import json
import time
from pathlib import Path
import urllib.request
try:
    assert Path('/data/ready').exists()
    config = json.loads(Path('/data/network/network.json').read_text())
    epoch = max(0, (int(time.time()) - config['genesis_time']) // 48)
    for port in range(5051, 5055):
        with urllib.request.urlopen(f'http://127.0.0.1:{port}/eth/v1/beacon/states/head/finality_checkpoints', timeout=2) as response:
            assert int(json.load(response)['data']['finalized']['epoch']) >= epoch - 4
    token = Path('/data/network/status-api-token').read_text().strip()
    request = urllib.request.Request('http://127.0.0.1:3000/health', headers={'Authorization': 'Bearer ' + token})
    with urllib.request.urlopen(request, timeout=8) as response:
        assert json.load(response)['ready']
    for url in ['http://127.0.0.1:3002/', 'http://127.0.0.1:8080/', 'http://127.0.0.1:4000/api/v2/stats', 'http://127.0.0.1:3001/']:
        with urllib.request.urlopen(url, timeout=2) as response: assert response.status == 200
except Exception:
    raise SystemExit(1)
