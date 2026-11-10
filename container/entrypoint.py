"""One-container lifecycle: database -> chain -> application -> explorers.

State lives only in /data. A failed critical child exits the container; Docker
can restart it. Shutdown stops signers before execution clients and PostgreSQL.
"""
import fcntl
import json
import os
from pathlib import Path
import secrets
import signal
import subprocess
import sys
import time
import urllib.request

ROOT = Path('/opt/credentials')
DATA = Path('/data')
NETWORK = DATA / 'network'
children = []
stopping = False
os.umask(0o077)
sys.path.insert(0, str(ROOT / 'network/pos'))
import manage


def stop_requested(signum, frame):
    global stopping
    stopping = True
    raise InterruptedError('Shutdown requested')


def run(args, *, env=None, cwd=ROOT, input=None):
    subprocess.run(args, check=True, cwd=cwd, env=env, input=input, text=True)


def sql(text, database='postgres'):
    # No password or private content is passed on command lines or printed.
    subprocess.run(['runuser', '-u', 'postgres', '--', 'psql', '-q', '-v', 'ON_ERROR_STOP=1', '-d', database],
                   input=text, text=True, check=True, stdout=subprocess.DEVNULL)


def spawn(name, args, *, env=None, cwd=ROOT):
    path = DATA / 'logs' / (name + '.log')
    if path.exists() and path.stat().st_size > 10 * 1024 * 1024:
        path.replace(path.with_suffix('.log.1'))
    with path.open('ab') as log:
        child = subprocess.Popen(args, cwd=cwd, env=env, stdout=log, stderr=subprocess.STDOUT, start_new_session=True)
    children.append((name, child))
    print('Started:', name, flush=True)
    return child


def wait_for(label, predicate, seconds=240):
    end = time.monotonic() + seconds
    while time.monotonic() < end:
        for name, child in children:
            if child.poll() is not None:
                raise RuntimeError(f'{name} exited; inspect /data/logs/{name}.log')
        try:
            if predicate(): return
        except (OSError, ValueError, KeyError, RuntimeError): pass
        time.sleep(2)
    raise RuntimeError(label + ' readiness timed out')


def http(url):
    with urllib.request.urlopen(url, timeout=5) as response:
        return response.status == 200


def main():
    DATA.mkdir(exist_ok=True)
    NETWORK.mkdir(exist_ok=True)
    (DATA / 'logs').mkdir(exist_ok=True)
    lock = (DATA / 'container.lock').open('a')
    fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
    # Keep this descriptor alive for the lifetime of the supervisor.
    main.lock = lock
    secrets_file = DATA / 'service-secrets.json'
    if not secrets_file.exists():
        secrets_file.write_text(json.dumps({'database': secrets.token_hex(32), 'explorer': secrets.token_hex(64)}))
    keys = json.loads(secrets_file.read_text())
    pgdata = DATA / 'postgres'
    pgdata.mkdir(exist_ok=True)
    run(['chown', '-R', 'postgres:postgres', str(pgdata)])
    run(['install', '-d', '-m', '775', '-o', 'postgres', '-g', 'postgres', '/var/run/postgresql'])
    if not (pgdata / 'PG_VERSION').exists():
        run(['runuser', '-u', 'postgres', '--', 'initdb', '-D', str(pgdata), '--auth-local=trust', '--auth-host=scram-sha-256'])
    spawn('postgres', ['runuser', '-u', 'postgres', '--', 'postgres', '-D', str(pgdata), '-c', 'listen_addresses=127.0.0.1'])
    wait_for('PostgreSQL', lambda: subprocess.run(['pg_isready', '-q'], stdout=subprocess.DEVNULL).returncode == 0)
    # Database setup markers are written only after successful setup/restoration.
    sql("DO $$ BEGIN IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname='credentials_demo') THEN CREATE ROLE credentials_demo LOGIN; END IF; IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname='blockscout') THEN CREATE ROLE blockscout LOGIN; END IF; END $$;")
    sql("ALTER ROLE blockscout PASSWORD '" + keys['database'] + "';")
    for database, owner in [('credentials_demo', 'credentials_demo'), ('blockscout', 'blockscout')]:
        marker = DATA / (database + '.ready')
        if marker.exists(): continue
        present = subprocess.check_output(['runuser', '-u', 'postgres', '--', 'psql', '-qAt', '-c',
            "SELECT 1 FROM pg_database WHERE datname='" + database + "'"], text=True).strip()
        if not present: sql('CREATE DATABASE ' + database + ' OWNER ' + owner + ';')
        dump = DATA / 'import' / (database + '.sql')
        if dump.exists():
            # Imported plain dumps are transactional; never delete them on failure.
            with dump.open() as stream:
                subprocess.run(['runuser', '-u', 'postgres', '--', 'psql', '-q', '-1', '-v', 'ON_ERROR_STOP=1', '-d', database],
                               stdin=stream, stdout=subprocess.DEVNULL, check=True,
                               env={**os.environ, 'PGOPTIONS': '-c role=' + owner})
        elif database == 'credentials_demo':
            sql('SET ROLE credentials_demo;\n' + (ROOT / 'database/schema.sql').read_text(), database)
        marker.touch()

    # Token is per volume. Recreating the container does not rotate it.
    token = NETWORK / 'status-api-token'
    if not token.exists(): token.write_text(secrets.token_hex(32) + '\n')
    manage.start()
    config = json.loads((NETWORK / 'network.json').read_text())
    def heads_ready():
        return all(int(time.time()) - int(manage.rpc(i, 'eth_getBlockByNumber', ['latest', False])['timestamp'], 16) < 30
                   for i in range(len(manage.NAMES)))
    def finality_ready():
        epoch = max(0, (int(time.time()) - config['genesis_time']) // 48)
        return heads_ready() and all(0 < int(manage.beacon(i, '/eth/v1/beacon/states/head/finality_checkpoints')['finalized']['epoch']) >= epoch - 4
                                     for i in range(len(manage.NAMES)))
    wait_for('Chain heads', heads_ready, 480)
    try:
        wait_for('Chain finality', finality_ready, 180)
    except RuntimeError as error:
        if str(error) != 'Chain finality readiness timed out': raise
        # This pinned Teku build can leave gossip inactive after a long network-wide
        # pause. Restart only beacon clients once heads are recent; preserve all
        # databases and slashing protection, and never overlap signer processes.
        print('Refreshing beacon gossip after network downtime...', flush=True)
        manage.stop(('teku',))
        manage.start()
        wait_for('Chain finality', finality_ready, 480)
    if not (NETWORK / 'contracts-deployment.json').exists():
        run(['node', str(ROOT / 'network/pos/deploy-contracts.cjs')])
    state = NETWORK / 'business-demo/state.json'
    if not state.exists() or not json.loads(state.read_text()).get('setup'):
        run(['node', 'backend/app.cjs', 'setup'])
    spawn('application', ['node', 'backend/app.cjs', 'serve'])
    spawn('status-api', ['node', 'backend/server.cjs'])
    wait_for('Application', lambda: http('http://127.0.0.1:3002/'))

    (NETWORK / 'dora').mkdir(exist_ok=True)
    spawn('dora', ['/opt/dora', '--config', str(ROOT / 'network/pos/dora.yaml')], cwd=ROOT / 'network/pos',
          env={**os.environ, 'GOMEMLIMIT': '512MiB', 'GOMAXPROCS': '2'})
    verifier_env = {**os.environ, 'SMART_CONTRACT_VERIFIER__SERVER__HTTP__ADDR': '127.0.0.1:8050',
        'SMART_CONTRACT_VERIFIER__SERVER__HTTP__ENABLED': 'true', 'SMART_CONTRACT_VERIFIER__COMPILERS__EXECUTION__TYPE': 'native',
        'SMART_CONTRACT_VERIFIER__SOLIDITY__ENABLED': 'true', 'SMART_CONTRACT_VERIFIER__VYPER__ENABLED': 'false',
        'SMART_CONTRACT_VERIFIER__SOURCIFY__ENABLED': 'false'}
    spawn('contract-verifier', ['/opt/verifier/server'], env=verifier_env)
    explorer_env = {**os.environ, 'LD_LIBRARY_PATH': '/opt/explorer-libs/base:/opt/explorer-libs/usr',
        'DATABASE_URL': 'postgresql://blockscout:' + keys['database'] + '@127.0.0.1:5432/blockscout',
        'SECRET_KEY_BASE': keys['explorer'], 'ETHEREUM_JSONRPC_VARIANT': 'besu',
        'ETHEREUM_JSONRPC_HTTP_URL': 'http://127.0.0.1:8545', 'ETHEREUM_JSONRPC_TRACE_URL': 'http://127.0.0.1:8545',
        'ETHEREUM_JSONRPC_TRANSPORT': 'http', 'CHAIN_ID': '20261104', 'PORT': '4000', 'COIN': 'ETH',
        'COIN_NAME': 'Ether', 'DISABLE_MARKET': 'true', 'INDEXER_DISABLE_INTERNAL_TRANSACTIONS_FETCHER': 'true',
        'INDEXER_DISABLE_BLOCK_REWARD_FETCHER': 'true', 'MICROSERVICE_SIG_PROVIDER_ENABLED': 'false',
        'MICROSERVICE_SC_VERIFIER_ENABLED': 'true', 'MICROSERVICE_SC_VERIFIER_TYPE': 'sc_verifier',
        'MICROSERVICE_SC_VERIFIER_URL': 'http://127.0.0.1:8050/', 'NFT_MEDIA_HANDLER_ENABLED': 'false',
        'ACCOUNT_ENABLED': 'false', 'POOL_SIZE': '10', 'POOL_SIZE_API': '5', 'ERL_FLAGS': '+S 2:2',
        'ECTO_SSL_MODE': 'disable', 'ECTO_USE_SSL': 'false'}
    run(['/app/bin/blockscout', 'eval', 'Elixir.Explorer.ReleaseTasks.create_and_migrate()'], env=explorer_env, cwd='/app')
    spawn('blockscout', ['/app/bin/blockscout', 'start'], env=explorer_env, cwd='/app')
    frontend_env = {**os.environ, 'PATH': '/opt/frontend-bin:' + os.environ['PATH'],
        'LD_LIBRARY_PATH': '/opt/frontend-libs/base:/opt/frontend-libs/usr', 'PORT': '3001', 'HOSTNAME': '127.0.0.1',
        'NEXT_PUBLIC_API_HOST': 'localhost:8081', 'NEXT_PUBLIC_API_PROTOCOL': 'http', 'NEXT_PUBLIC_APP_HOST': 'localhost:8081',
        'NEXT_PUBLIC_APP_PROTOCOL': 'http', 'NEXT_PUBLIC_NETWORK_NAME': 'Besu Local', 'NEXT_PUBLIC_NETWORK_SHORT_NAME': 'Besu Local',
        'NEXT_PUBLIC_NETWORK_ID': '20261104', 'NEXT_PUBLIC_NETWORK_CURRENCY_NAME': 'Ether', 'NEXT_PUBLIC_NETWORK_CURRENCY_SYMBOL': 'ETH',
        'NEXT_PUBLIC_NETWORK_CURRENCY_DECIMALS': '18', 'NEXT_PUBLIC_IS_TESTNET': 'true', 'NEXT_PUBLIC_API_WEBSOCKET_PROTOCOL': 'ws'}
    # Only local environment generation is required; asset downloads are not a startup dependency.
    run(['bash', './make_envs_script.sh'], env=frontend_env, cwd='/opt/explorer-frontend')
    spawn('blockscout-ui', ['node', 'server.js'], env=frontend_env, cwd='/opt/explorer-frontend')
    spawn('gateway', ['nginx', '-c', '/opt/container/nginx.conf', '-g', 'daemon off;'])
    wait_for('Explorers', lambda: http('http://127.0.0.1:8080/') and http('http://127.0.0.1:3001/') and http('http://127.0.0.1:4000/api/v2/stats'))
    (DATA / 'ready').touch()
    print('READY: application :3002, status API :3000, Dora :8080, Blockscout :8081', flush=True)
    while True:
        for name, child in children:
            if child.poll() is not None: raise RuntimeError(name + ' exited; restarting container is required')
        for org in manage.NAMES:
            if not manage.process_record('besu-' + org) or not manage.process_record('teku-' + org):
                raise RuntimeError('Network process exited: ' + org)
        time.sleep(5)


def shutdown():
    (DATA / 'ready').unlink(missing_ok=True)
    # Drain APIs while the chain and DB remain available.
    for name, child in reversed(children):
        if name != 'postgres' and child.poll() is None:
            try: os.killpg(child.pid, signal.SIGTERM)
            except ProcessLookupError: pass
    deadline = time.monotonic() + 15
    for name, child in reversed(children):
        if name != 'postgres':
            try: child.wait(timeout=max(0, deadline - time.monotonic()))
            except subprocess.TimeoutExpired: print('Still stopping:', name, flush=True)
    try: manage.stop()
    except Exception: print('Network shutdown incomplete; inspect persistent logs', flush=True)
    for name, child in children:
        if name == 'postgres' and child.poll() is None:
            subprocess.run(['runuser', '-u', 'postgres', '--', 'pg_ctl', '-D', '/data/postgres', '-m', 'fast', '-w', 'stop'],
                           stdout=subprocess.DEVNULL)


if __name__ == '__main__':
    for sig in (signal.SIGTERM, signal.SIGINT): signal.signal(sig, stop_requested)
    try:
        (DATA / 'ready').unlink(missing_ok=True)
        main()
    except InterruptedError:
        print('Stopping services...', flush=True)
    except Exception as error:
        # No environment or SQL containing credentials in the console.
        print('Startup/service failure:', type(error).__name__, str(error)[:180], flush=True)
        sys.exitcode = 1
    finally:
        for sig in (signal.SIGTERM, signal.SIGINT): signal.signal(sig, signal.SIG_IGN)
        shutdown()
    sys.exit(getattr(sys, 'exitcode', 0))
