#!/usr/bin/env python3
"""Clear demo leads, STOP hashes, outbox and calendar events titled Besichtigung.

Objekte are kept. Run this only on the demo, not on a mailbox you still need.
"""

import argparse
import json
import shutil
import urllib.error
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def load_env(path):
    env = {}
    if not path.exists():
        return env
    for line in path.read_text(encoding='utf-8').splitlines():
        line = line.strip()
        if not line or line.startswith('#') or '=' not in line:
            continue
        key, value = line.split('=', 1)
        env[key.strip()] = value.strip().strip('"').strip("'")
    return env


def clear_local(root):
    var = root / 'var'
    for name in ('demo_state.json', 'telegram.log', 'calendar.json', 'engine.log', 'access.log'):
        target = var / name
        if target.exists():
            target.unlink()
    leads = var / 'crm' / 'leads.json'
    if leads.exists():
        leads.unlink()
    outbox = var / 'outbox'
    if outbox.exists():
        shutil.rmtree(outbox)
    print('local var cleared, objekte.json kept')
    print('warning: STOP hashes in this demo store are cleared with the reset')


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--env', default=str(ROOT / '.env'))
    parser.add_argument('--local', action='store_true', help='also clear ./var when the engine is down')
    args = parser.parse_args()
    env = load_env(Path(args.env))
    token = env.get('ADMIN_TOKEN', '')
    engine_token = env.get('ENGINE_TOKEN', '')
    base = env.get('ENGINE_URL', 'http://127.0.0.1:18787')
    req = urllib.request.Request(
        f'{base}/v1/admin/reset',
        data=b'{}',
        method='POST',
        headers={
            'Content-Type': 'application/json',
            'x-admin-token': token,
            'x-engine-token': engine_token,
        },
    )
    try:
        with urllib.request.urlopen(req, timeout=20) as res:
            body = json.loads(res.read().decode('utf-8'))
        print(body.get('warning') or 'reset ok')
    except (urllib.error.URLError, TimeoutError) as err:
        print(f'engine unreachable: {err}')
        if args.local:
            clear_local(ROOT)
            return
        raise SystemExit(1)
    if args.local:
        clear_local(ROOT)


if __name__ == '__main__':
    main()
