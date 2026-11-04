#!/usr/bin/env python3
"""Generate local QBFT identities once, then start four validators and one RPC node.

Start: python3 network/start.py
Status: docker compose -f network/compose.yaml ps
Stop (retain keys and chain): docker compose -f network/compose.yaml down
"""

import json
import os
from pathlib import Path
import shutil
import subprocess


ROOT = Path(__file__).resolve().parent
STATE = ROOT / ".local"
IMAGE = "hyperledger/besu:25.6.0"
NODES = ["validator-ntq", "validator-v", "validator-university-c", "validator-cert-1", "rpc"]


def run(*args):
    subprocess.run(args, check=True, cwd=ROOT)


def besu(*args):
    run(
        "docker", "run", "--rm", "--network=none", "--hostname=localhost",
        "--user", f"{os.getuid()}:{os.getgid()}",
        "--env", "JAVA_OPTS=-Xms64m -Xmx256m -XX:ActiveProcessorCount=2",
        "--volume", f"{STATE}:/work", IMAGE, *args,
    )


def write_json(path, value):
    path.write_text(json.dumps(value, indent=2) + "\n")


def initialize():
    os.umask(0o077)
    STATE.mkdir(mode=0o700, exist_ok=True)
    genesis = STATE / "generated/genesis.json"
    marker = STATE / "initialized"
    if marker.exists():
        required = [genesis, STATE / "static-nodes.json", STATE / "permissions.toml"]
        required += [STATE / name / "key" for name in NODES]
        if not all(path.is_file() for path in required):
            raise RuntimeError("Existing network is incomplete; restore its files. Keys and chain will not be regenerated automatically.")
        print("Using existing local keys and chain data.", flush=True)
    else:
        if any((STATE / name / "database").exists() for name in NODES):
            raise RuntimeError("Existing blockchain data found without initialization marker; refusing to replace identities.")
        operator_config = {
            "genesis": {
                "config": {
                    "chainId": 1337,
                    "londonBlock": 0,
                    "shanghaiTime": 0,
                    "zeroBaseFee": True,
                    "qbft": {"blockperiodseconds": 2, "epochlength": 30000, "requesttimeoutseconds": 4},
                },
                "nonce": "0x0",
                "timestamp": "0x0",
                "gasLimit": "0x1c9c380",
                "difficulty": "0x1",
                "mixHash": "0x63746963616c2062797a616e74696e65206661756c7420746f6c6572616e6365",
                "coinbase": "0x0000000000000000000000000000000000000000",
                "alloc": {},
            },
            "blockchain": {"nodes": {"generate": True, "count": 4}},
        }
        if not genesis.exists():
            write_json(STATE / "operator-config.json", operator_config)
            besu("operator", "generate-blockchain-config", "--config-file=/work/operator-config.json", "--to=/work/generated", "--private-key-file-name=key")

        key_dirs = sorted((STATE / "generated/keys").iterdir())
        if len(key_dirs) != 4 or not all((path / "key").is_file() and (path / "key.pub").is_file() for path in key_dirs):
            raise RuntimeError("Expected exactly four complete validator key pairs.")

        for name, source in zip(NODES[:4], key_dirs):
            directory = STATE / name
            directory.mkdir(mode=0o700, exist_ok=True)
            for filename in ("key", "key.pub"):
                destination = directory / filename
                if destination.exists() and destination.read_bytes() != (source / filename).read_bytes():
                    raise RuntimeError(f"Refusing to replace existing identity for {name}.")
                shutil.copyfile(source / filename, destination)
                destination.chmod(0o600)

        (STATE / "rpc").mkdir(mode=0o700, exist_ok=True)
        if not (STATE / "rpc/key.pub").exists():
            besu("--data-path=/work/rpc", "public-key", "export", "--to=/work/rpc/key.pub")

        enodes = []
        for index, name in enumerate(NODES, start=11):
            public_key = (STATE / name / "key.pub").read_text().strip().removeprefix("0x")
            if len(public_key) != 128 or any(char not in "0123456789abcdefABCDEF" for char in public_key):
                raise RuntimeError(f"Unexpected public key format for {name}.")
            (STATE / name / "key").chmod(0o600)
            enodes.append(f"enode://{public_key}@172.28.44.{index}:30303")

        write_json(STATE / "static-nodes.json", enodes)
        (STATE / "permissions.toml").write_text("nodes-allowlist=" + json.dumps(enodes, indent=2) + "\n")
        marker.write_text("Besu 25.6.0; chainId 1337; four QBFT validators plus one non-validator RPC\n")
        print("Generated local node keys and QBFT genesis. Private keys are kept in network/.local/.", flush=True)

    (ROOT / ".env").write_text(f"LOCAL_UID={os.getuid()}\nLOCAL_GID={os.getgid()}\n")
    run("docker", "compose", "-f", str(ROOT / "compose.yaml"), "up", "-d")
    print("Starting QBFT network. RPC: http://127.0.0.1:8545 ; chain ID: 1337", flush=True)


if __name__ == "__main__":
    initialize()
