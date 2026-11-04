#!/usr/bin/env python3
"""Local-only Besu + Teku PoS testnet, using binaries already in Downloads.

python3 network/pos/manage.py start|status|stop
No external RPC or downloads. Does not deploy application contracts.
64 deterministic INTEROP validators: TEST ONLY, never use their keys on public networks.
Four execution/beacon pairs, each owning a disjoint range of 16 validators.
Genesis and databases survive stop/start. No implicit reset or key replacement.
Chain ID: 20261104. Prague/Electra, minimal preset (6-second slots, 8 slots/epoch).
Local ports: execution RPC 8545-8548, authenticated Engine API 8551-8554,
beacon REST 5051-5054. This network is not Sepolia, Hoodi or Ethereum mainnet.
Source defaults: Downloads/besu-26.10.2 and Downloads/teku/build/install/teku.
Override BESU_POS_HOME, TEKU_POS_HOME, TEKU_SOURCE_HOME, BESU_POS_JAVA_HOME
before first initialization if those local installations are moved.
"""

import argparse
import fcntl
import hashlib
import json
import os
from pathlib import Path
import re
import secrets
import signal
import socket
import subprocess
import sys
import time
import urllib.error
import urllib.request


ROOT = Path(__file__).resolve().parent
STATE = ROOT / ".local"
NAMES = ("ntq", "v", "university-c", "cert-1")
CHAIN_ID = 20261104
VALIDATORS = 64
DEPOSIT_CONTRACT = "0x00000000219ab540356cbb839cbe05303d7705fa"
JAVA = Path(os.environ.get("BESU_POS_JAVA_HOME", "/usr/lib/jvm/jdk-25.0.5.0.3-oracle-x64"))
BESU_HOME = Path(os.environ.get("BESU_POS_HOME", str(Path.home() / "Downloads/besu-26.10.2")))
TEKU_HOME = Path(os.environ.get("TEKU_POS_HOME", str(Path.home() / "Downloads/teku/build/install/teku")))
TEKU_SOURCE = Path(os.environ.get("TEKU_SOURCE_HOME", str(Path.home() / "Downloads/teku")))
BESU = BESU_HOME / "bin/besu"
TEKU = TEKU_HOME / "bin/teku"
HTTP = urllib.request.build_opener(urllib.request.ProxyHandler({}))


def write_json(path, value):
    temporary = path.with_suffix(path.suffix + ".tmp")
    temporary.write_text(json.dumps(value, indent=2) + "\n")
    temporary.replace(path)


def environment(heap="512m"):
    env = dict(os.environ)
    # Isolate inherited client settings from this private testnet.
    for key in list(env):
        if key.startswith(("BESU_", "TEKU_")) or key in ("JAVA_TOOL_OPTIONS", "JDK_JAVA_OPTIONS", "_JAVA_OPTIONS"):
            env.pop(key)
    env["JAVA_HOME"] = str(JAVA)
    env["PATH"] = str(JAVA / "bin") + os.pathsep + env.get("PATH", "")
    env["JAVA_OPTS"] = f"-Xms128m -Xmx{heap} -XX:ActiveProcessorCount=2"
    env["TEKU_OPTS"] = env["JAVA_OPTS"]
    return env


def run(command):
    result = subprocess.run([str(item) for item in command], env=environment(), cwd=ROOT, text=True, capture_output=True)
    if result.returncode:
        raise RuntimeError(result.stderr[-4000:] or result.stdout[-4000:])
    return result.stdout.strip()


def request(url, payload=None):
    body = None if payload is None else json.dumps(payload).encode()
    req = urllib.request.Request(url, data=body, headers={"Content-Type": "application/json"})
    with HTTP.open(req, timeout=4) as response:
        return json.load(response)


def rpc(index, method, params=None):
    result = request(f"http://127.0.0.1:{8545 + index}", {"jsonrpc": "2.0", "id": 1, "method": method, "params": params or []})
    if "error" in result:
        raise RuntimeError(str(result["error"]))
    return result["result"]


def beacon(index, endpoint):
    return request(f"http://127.0.0.1:{5051 + index}{endpoint}")["data"]


def process_identity(pid):
    try:
        # /proc starttime prevents signalling an unrelated process after PID reuse.
        fields = Path(f"/proc/{pid}/stat").read_text().rsplit(")", 1)[1].split()
        if fields[0] == "Z":
            return None
        return fields[19]
    except (FileNotFoundError, ProcessLookupError):
        return None


def process_record(name):
    path = STATE / f"{name}.pid"
    if not path.exists():
        return None
    record = json.loads(path.read_text())
    return record if process_identity(record["pid"]) == record["starttime"] else None


def launch(name, command):
    if process_record(name):
        return
    log = STATE / f"{name}.log"
    if log.exists() and log.stat().st_size > 10 * 1024 * 1024:
        log.replace(log.with_suffix(".log.1"))
    with log.open("ab") as stream:
        child = subprocess.Popen([str(arg) for arg in command], cwd=ROOT, env=environment(), stdin=subprocess.DEVNULL, stdout=stream, stderr=subprocess.STDOUT, start_new_session=True)
    write_json(STATE / f"{name}.pid", {"pid": child.pid, "starttime": process_identity(child.pid)})


def wait_for(name, operation, seconds=90):
    deadline = time.monotonic() + seconds
    next_message = time.monotonic() + 20
    last_error = None
    while time.monotonic() < deadline:
        if not process_record(name):
            log = STATE / f"{name}.log"
            detail = log.read_text(errors="replace")[-4500:] if log.exists() else "No log"
            raise RuntimeError(f"{name} exited. {detail}")
        try:
            return operation()
        except (OSError, ValueError, RuntimeError, KeyError) as error:
            last_error = error
        if time.monotonic() > next_message:
            print(f"Waiting for {name} to become ready...", flush=True)
            next_message += 20
        time.sleep(1)
    raise RuntimeError(f"{name} not ready: {last_error}; inspect {STATE / (name + '.log')}")


def validate_ports():
    for index, org in enumerate(NAMES):
        for client, ports in (("besu", (8545 + index, 8551 + index, 30311 + index)), ("teku", (5051 + index, 9001 + index))):
            if process_record(f"{client}-{org}"):
                continue
            for port in ports:
                with socket.socket() as probe:
                    try:
                        probe.bind(("127.0.0.1", port))
                    except OSError as error:
                        raise RuntimeError(f"Local port {port} is in use. Stop the previous network before starting PoS.") from error


def initialize():
    for executable in (JAVA / "bin/java", BESU, TEKU):
        if not executable.is_file():
            raise RuntimeError(f"Missing local executable: {executable}")
    runtime = {"besu": run([BESU, "--version"]), "teku": run([TEKU, "--version"]), "java_home": str(JAVA), "besu_home": str(BESU_HOME), "teku_home": str(TEKU_HOME)}
    metadata = STATE / "network.json"
    if metadata.exists():
        config = json.loads(metadata.read_text())
        if runtime != config["runtime"]:
            raise RuntimeError("Client binaries/runtime differ from this network's recorded versions; review the upgrade before restarting.")
        required = [STATE / "genesis.json", STATE / "consensus.yaml", STATE / "static-nodes.json", STATE / "accounts/deployer/key"]
        required += [STATE / f"besu-{org}/key" for org in NAMES]
        required += [STATE / f"jwt-{org}.hex" for org in NAMES]
        if not all(path.is_file() for path in required):
            raise RuntimeError("Persistent network files are incomplete. Restore them; identities will not be regenerated.")
        return config

    if any((STATE / f"besu-{org}/database").exists() or (STATE / f"teku-{org}/beacon").exists() for org in NAMES):
        raise RuntimeError("Existing chain data without network metadata. Refusing to regenerate genesis.")

    # A separate random execution account, not a validator/P2P key.
    account = STATE / "accounts/deployer"
    account.mkdir(parents=True, exist_ok=True)
    if not (account / "address").exists():
        run([BESU, f"--data-path={account}", "public-key", "export-address", f"--to={account / 'address'}"])
    deployer = (account / "address").read_text().strip()
    enodes = []
    for index, org in enumerate(NAMES):
        directory = STATE / f"besu-{org}"
        directory.mkdir(exist_ok=True)
        public = directory / "key.pub"
        if not public.exists():
            run([BESU, f"--data-path={directory}", "public-key", "export", f"--to={public}"])
        enodes.append(f"enode://{public.read_text().strip().removeprefix('0x')}@127.0.0.1:{30311 + index}")
        jwt = STATE / f"jwt-{org}.hex"
        if not jwt.exists():
            jwt.write_text(secrets.token_hex(32) + "\n")
    write_json(STATE / "static-nodes.json", enodes)

    # Local minimal preset: 6-second slots, 8 slots/epoch. Real PoS signatures and
    # Engine API; deterministic validator keys avoid deposits for this testnet.
    template = TEKU_SOURCE / "ethereum/spec/src/main/resources/tech/pegasys/teku/spec/config/configs/minimal.yaml"
    text = template.read_text()
    genesis_time = int(time.time()) + 120
    replacements = {
        "CONFIG_NAME": "'besu-teku-local'", "MIN_GENESIS_ACTIVE_VALIDATOR_COUNT": str(VALIDATORS),
        "MIN_GENESIS_TIME": str(genesis_time), "GENESIS_DELAY": "0", "TERMINAL_TOTAL_DIFFICULTY": "0",
        "DEPOSIT_CHAIN_ID": str(CHAIN_ID), "DEPOSIT_NETWORK_ID": str(CHAIN_ID),
        "DEPOSIT_CONTRACT_ADDRESS": DEPOSIT_CONTRACT,
        "GENESIS_FORK_VERSION": "0x10004200", "SLOT_DURATION_MS": "6000",
    }
    for index, fork in enumerate(("ALTAIR", "BELLATRIX", "CAPELLA", "DENEB", "ELECTRA", "FULU", "GLOAS", "HEZE"), start=1):
        replacements[f"{fork}_FORK_VERSION"] = f"0x{16 + index:02x}004200"
        replacements[f"{fork}_FORK_EPOCH"] = "0" if index <= 5 else "18446744073709551615"
    for key, value in replacements.items():
        text, count = re.subn(rf"^{key}:.*$", f"{key}: {value}", text, flags=re.MULTILINE)
        if count != 1:
            raise RuntimeError(f"Unsupported Teku source configuration field: {key}")
    (STATE / "consensus.yaml").write_text(text)

    genesis = {
        "config": {
            "chainId": CHAIN_ID,
            "homesteadBlock": 0, "eip150Block": 0, "eip155Block": 0, "eip158Block": 0,
            "byzantiumBlock": 0, "constantinopleBlock": 0, "petersburgBlock": 0,
            "istanbulBlock": 0, "berlinBlock": 0, "londonBlock": 0,
            "terminalTotalDifficulty": 0, "terminalTotalDifficultyPassed": True,
            "depositContractAddress": DEPOSIT_CONTRACT,
            "shanghaiTime": 0, "cancunTime": 0, "pragueTime": 0,
            "blobSchedule": {"cancun": {"target": 3, "max": 6, "baseFeeUpdateFraction": 3338477}, "prague": {"target": 6, "max": 9, "baseFeeUpdateFraction": 5007716}},
        },
        "nonce": "0x0", "timestamp": hex(genesis_time), "extraData": "0x",
        "gasLimit": "0x1c9c380", "difficulty": "0x0", "baseFeePerGas": "0x3b9aca00",
        "mixHash": "0x" + "00" * 32, "coinbase": "0x" + "00" * 20,
        "alloc": {deployer.removeprefix("0x"): {"balance": str(10000 * 10**18)}, **system_contracts()},
    }
    write_json(STATE / "genesis.json", genesis)
    config = {"chain_id": CHAIN_ID, "genesis_time": genesis_time, "validator_count": VALIDATORS, "validators_per_node": 16, "slot_seconds": 6, "slots_per_epoch": 8, "fork": "Prague/Electra", "deployer_address": deployer, "runtime": runtime}
    write_json(metadata, config)
    return config


def system_contracts():
    # Runtime bytecode from the local Teku distribution's Besu fixtures. Do not
    # copy fixture balances, queued requests or block-history storage into genesis.
    fixtures = TEKU_SOURCE / "acceptance-tests/src/testFixtures/resources/besu"
    osaka = json.loads((fixtures / "osakaGenesis.json").read_text())
    accounts = {address.lower(): value for address, value in osaka["alloc"].items()}
    addresses = (
        "0x00000961ef480eb55e80d19ad83579a64c007002",  # EIP-7002 withdrawal requests
        "0x0000bbddc7ce488642fb579f8b00f3a590007251",  # EIP-7251 consolidation requests
        "0x0000f90827f1c53a10cb7a02335b175320002935",  # EIP-2935 block history
        "0x000f3df6d732807ef1319fb7b8bb8522d0beac02",  # EIP-4788 beacon roots
    )
    result = {address[2:]: {"code": accounts[address]["code"], "balance": "0", "nonce": "0x1"} for address in addresses}
    prague = json.loads((fixtures / "pragueGenesis.json").read_text())
    deposit = next(value for address, value in prague["alloc"].items() if address.lower() == DEPOSIT_CONTRACT)
    # Reconstruct constructor-initialized zero hashes; no prior deposits.
    value = bytes(32)
    storage = {}
    for height in range(1, 32):
        value = hashlib.sha256(value + value).digest()
        storage[f"0x{33 + height:064x}"] = "0x" + value.hex()
    result[DEPOSIT_CONTRACT[2:]] = {"code": deposit["code"], "storage": storage, "balance": "0", "nonce": "0x1"}
    return result


def empty_list_root(depth):
    value = bytes(32)
    for _ in range(depth):
        value = hashlib.sha256(value + value).digest()
    return "0x" + hashlib.sha256(value + bytes(32)).hexdigest()


def write_payload_header(block):
    # Consensus header uses SSZ list roots, not execution MPT trie roots.
    header = {
        "parent_hash": block["parentHash"], "fee_recipient": block["miner"],
        "state_root": block["stateRoot"], "receipts_root": block["receiptsRoot"],
        "logs_bloom": block["logsBloom"], "prev_randao": block["mixHash"],
        "block_number": "0", "gas_limit": str(int(block["gasLimit"], 16)),
        "gas_used": "0", "timestamp": str(int(block["timestamp"], 16)),
        "extra_data": block["extraData"], "base_fee_per_gas": str(int(block["baseFeePerGas"], 16)),
        "block_hash": block["hash"], "transactions_root": empty_list_root(20),
        "withdrawals_root": empty_list_root(2),  # minimal preset: 4 withdrawals/payload
        "blob_gas_used": "0", "excess_blob_gas": "0",
    }
    path = STATE / "payload-header.json"
    if path.exists() and json.loads(path.read_text()) != header:
        raise RuntimeError("Execution genesis does not match the existing beacon genesis header.")
    write_json(path, header)


def start():
    validate_ports()
    config = initialize()
    print(f"Local PoS chain {CHAIN_ID}; {config['runtime']['besu']}; {config['runtime']['teku']}", flush=True)
    for index, org in enumerate(NAMES):
        name = f"besu-{org}"
        launch(name, [BESU, f"--config-file={ROOT / 'besu.toml'}", f"--data-path={STATE / name}",
            f"--genesis-file={STATE / 'genesis.json'}", f"--network-id={CHAIN_ID}",
            f"--identity=besu-pos-{org}", f"--p2p-port={30311 + index}",
            f"--static-nodes-file={STATE / 'static-nodes.json'}", f"--rpc-http-port={8545 + index}",
            f"--engine-rpc-port={8551 + index}", f"--engine-jwt-secret={STATE / ('jwt-' + org + '.hex')}",
            f"--pid-path={STATE / name / 'besu.pid'}"])
    genesis_blocks = []
    for index, org in enumerate(NAMES):
        block = wait_for(f"besu-{org}", lambda i=index: rpc(i, "eth_getBlockByNumber", ["0x0", False]))
        genesis_blocks.append(block["hash"])
    if len(set(genesis_blocks)) != 1:
        raise RuntimeError("Execution nodes disagree on genesis.")
    write_payload_header(rpc(0, "eth_getBlockByNumber", ["0x0", False]))

    peers = []
    for index, org in enumerate(NAMES):
        name = f"teku-{org}"
        command = [TEKU, f"--network={STATE / 'consensus.yaml'}", f"--data-path={STATE / name}",
            f"--ee-endpoint=http://127.0.0.1:{8551 + index}", f"--ee-jwt-secret-file={STATE / ('jwt-' + org + '.hex')}",
            "--p2p-interface=127.0.0.1", "--p2p-advertised-ip=127.0.0.1", f"--p2p-port={9001 + index}",
            "--p2p-discovery-enabled=false", "--Xp2p-quic-enabled=false", "--p2p-peer-lower-bound=1", "--p2p-peer-upper-bound=6",
            "--p2p-subscribe-all-subnets-enabled=true", "--rest-api-enabled=true", "--rest-api-interface=127.0.0.1",
            f"--rest-api-port={5051 + index}", "--rest-api-host-allowlist=localhost,127.0.0.1",
            f"--validators-proposer-default-fee-recipient={config['deployer_address']}",
            f"--validators-graffiti=LOCAL-{org}",
            "--Xinterop-enabled=true", f"--Xinterop-genesis-time={config['genesis_time']}",
            f"--Xinterop-genesis-payload-header={STATE / 'payload-header.json'}", f"--Xinterop-number-of-validators={VALIDATORS}",
            f"--Xinterop-owned-validator-start-index={16 * index}", "--Xinterop-owned-validator-count=16",
            "--logging=INFO", "--log-destination=CONSOLE"]
        if peers:
            command.append("--p2p-static-peers=" + ",".join(peers))
        launch(name, command)
        identity = wait_for(name, lambda i=index: beacon(i, "/eth/v1/node/identity"))
        if index == 0 and not (STATE / "genesis.ssz").exists():
            req = urllib.request.Request("http://127.0.0.1:5051/eth/v2/debug/beacon/states/genesis", headers={"Accept": "application/octet-stream"})
            with HTTP.open(req, timeout=15) as response:
                if "octet-stream" not in response.headers.get("Content-Type", ""):
                    raise RuntimeError("Beacon API did not return genesis SSZ.")
                (STATE / "genesis.ssz").write_bytes(response.read())
        peers.append(f"/ip4/127.0.0.1/tcp/{9001 + index}/p2p/{identity['peer_id']}")
        print(f"{org}: execution ready; beacon ready; validator indices {16 * index}-{16 * index + 15}", flush=True)
    print("All processes started. Use 'status' to inspect head and finality; initial finality takes a few epochs.", flush=True)
    print(f"Prefunded test account: {config['deployer_address']}; private key stays in {STATE / 'accounts/deployer/key'}", flush=True)
    status()


def status():
    if not (STATE / "network.json").exists():
        print("PoS network has not been initialized.")
        return
    config = json.loads((STATE / "network.json").read_text())
    remaining = config["genesis_time"] - int(time.time())
    if remaining > 0:
        print(f"Waiting for genesis: {remaining} seconds. No blocks are expected yet.")
    print("NODE              EXECUTION       BEACON          BLOCK    SLOT     FINALIZED EPOCH")
    for index, org in enumerate(NAMES):
        el = "running" if process_record(f"besu-{org}") else "stopped"
        cl = "running" if process_record(f"teku-{org}") else "stopped"
        height = slot = finalized = "-"
        if el == "running":
            try:
                height = str(int(rpc(index, "eth_blockNumber"), 16))
                el = f"up/{int(rpc(index, 'net_peerCount'), 16)} peers"
            except (OSError, ValueError, RuntimeError):
                el = "starting/error"
        if cl == "running":
            try:
                syncing = beacon(index, "/eth/v1/node/syncing")
                slot = syncing["head_slot"]
                finalized = beacon(index, "/eth/v1/beacon/states/head/finality_checkpoints")["finalized"]["epoch"]
                cl = f"up/{beacon(index, '/eth/v1/node/peer_count')['connected']} peers"
                if syncing.get("is_optimistic") or syncing.get("el_offline"):
                    cl = "EL not verified"
            except (OSError, ValueError, RuntimeError, KeyError):
                cl = "starting/error"
        print(f"{org:<17} {el:<15} {cl:<15} {height:<8} {slot:<8} {finalized}")


def stop():
    # Stop signers before execution clients; retain slashing-protection databases.
    for client in ("teku", "besu"):
        running = []
        for org in NAMES:
            name = f"{client}-{org}"
            record = process_record(name)
            if record:
                os.killpg(record["pid"], signal.SIGTERM)
                running.append(name)
        deadline = time.monotonic() + 45
        while any(process_record(name) for name in running) and time.monotonic() < deadline:
            time.sleep(1)
        remaining = [name for name in running if process_record(name)]
        if remaining:
            raise RuntimeError(f"Still shutting down: {remaining}. No force kill was performed; run stop again after checking logs.")
    print("PoS processes stopped. Genesis, keys, slashing protection and databases retained.")


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("action", choices=("start", "status", "stop"))
    args = parser.parse_args()
    os.umask(0o077)
    STATE.mkdir(mode=0o700, parents=True, exist_ok=True)
    with (STATE / "manager.lock").open("a") as lock:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            raise RuntimeError("Another network management command is running.")
        {"start": start, "status": status, "stop": stop}[args.action]()


if __name__ == "__main__":
    try:
        main()
    except (RuntimeError, OSError, ValueError) as error:
        print(f"Error: {error}", file=sys.stderr)
        sys.exit(1)
