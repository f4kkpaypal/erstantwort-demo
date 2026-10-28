#!/usr/bin/env python3
"""Create .env from .env.example and fill the local secrets."""

import secrets
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
ENV = ROOT / '.env'
EXAMPLE = ROOT / '.env.example'
PLACEHOLDERS = {
    'N8N_ENCRYPTION_KEY': 'change-me-encryption-key',
    'HASH_SALT': 'change-me-hash-salt',
    'ADMIN_TOKEN': 'change-me-admin-token',
    'POSTGRES_PASSWORD': 'change-me-postgres',
    'ENGINE_TOKEN': 'change-me-engine-token',
}


def replace_value(text, key, value):
    lines = []
    found = False
    for line in text.splitlines():
        if line.startswith(f'{key}=') and line.split('=', 1)[1] == PLACEHOLDERS[key]:
            lines.append(f'{key}={value}')
            found = True
        else:
            lines.append(line)
    if not found:
        lines.append(f'{key}={value}')
    return '\n'.join(lines) + '\n'


def main():
    if ENV.exists():
        print('.env already exists, left untouched')
        return
    text = EXAMPLE.read_text(encoding='utf-8')
    text = replace_value(text, 'N8N_ENCRYPTION_KEY', secrets.token_hex(32))
    text = replace_value(text, 'HASH_SALT', secrets.token_hex(32))
    text = replace_value(text, 'ADMIN_TOKEN', secrets.token_hex(24))
    text = replace_value(text, 'POSTGRES_PASSWORD', secrets.token_hex(18))
    text = replace_value(text, 'ENGINE_TOKEN', secrets.token_hex(24))
    ENV.write_text(text, encoding='utf-8')
    print('.env created. Mock modes stay on until you add the real keys.')


if __name__ == '__main__':
    main()
