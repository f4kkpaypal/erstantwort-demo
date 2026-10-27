#!/usr/bin/env python3
"""Send E01, E02 or E11 into the makler mailbox.

Dry-run writes var/outbox and does not open SMTP. A real send refuses
example.org, example.com, example.net, testdomain.de, .test and .invalid.
E11 needs var/demo_state.json from a previous E01 send.
"""

import argparse
import json
import smtplib
import ssl
import time
import uuid
from datetime import datetime, timezone
from email.utils import formatdate, parseaddr
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
BLOCKED = {'example.org', 'example.com', 'example.net', 'testdomain.de', 'lead.testdomain.de'}


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


def domain_blocked(domain):
    host = (domain or '').lower().strip().strip('.')
    if not host:
        return True
    if host in BLOCKED or host.endswith('.test') or host.endswith('.invalid'):
        return True
    for blocked in ('example.org', 'example.com', 'example.net', 'testdomain.de'):
        if host == blocked or host.endswith('.' + blocked):
            return True
    return False


def header_map(raw):
    head, _, body = raw.partition('\n\n')
    if '\r\n\r\n' in raw and not body:
        head, _, body = raw.partition('\r\n\r\n')
    headers = {}
    order = []
    current = None
    for line in head.splitlines():
        if line.startswith((' ', '\t')) and current:
            headers[current] += ' ' + line.strip()
            continue
        if ':' not in line:
            continue
        name, value = line.split(':', 1)
        current = name.strip()
        headers[current] = value.strip()
        if current not in order:
            order.append(current)
    return headers, order, body.lstrip('\n')


def render(headers, order, body):
    lines = [f'{name}: {headers[name]}' for name in order if name in headers]
    return '\r\n'.join(lines) + '\r\n\r\n' + body.replace('\n', '\r\n')


def fresh_message_id(domain):
    return f'<loom.{int(time.time())}.{uuid.uuid4().hex[:16]}@{domain}>'


def prepare(fixture_id, env, keep_date, keep_message_id):
    raw = (ROOT / 'fixtures' / 'eml' / f'{fixture_id}.eml').read_text(encoding='utf-8')
    lead_domain = env.get('LEAD_DOMAIN', '').strip().lower()
    if lead_domain:
        raw = raw.replace('@lead.testdomain.de', f'@{lead_domain}')
    if fixture_id == 'E11':
        state_path = ROOT / 'var' / 'demo_state.json'
        if not state_path.exists():
            raise SystemExit('send E01 first')
        state = json.loads(state_path.read_text(encoding='utf-8'))
        if not state.get('lead_id') or not state.get('outbound_message_id'):
            raise SystemExit('send E01 first')
        raw = raw.replace('{{LEAD_ID}}', state['lead_id'])
        raw = raw.replace('{{IN_REPLY_TO}}', state['outbound_message_id'])
    headers, order, body = header_map(raw)
    imap_user = env.get('IMAP_USER', '').strip()
    if imap_user and 'To' in headers:
        headers['To'] = imap_user
    domain = lead_domain or 'lead.testdomain.de'
    if not keep_message_id:
        headers['Message-ID'] = fresh_message_id(domain)
    if not keep_date:
        headers['Date'] = formatdate(time.time(), localtime=True)
    return render(headers, order, body), headers


def envelope_and_to(headers, env):
    envelope = env.get('SMTP_USER', '').strip() or parseaddr(headers.get('From', ''))[1]
    target = parseaddr(headers.get('To', ''))[1]
    return envelope, target


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--id', required=True, choices=['E01', 'E02', 'E11'])
    parser.add_argument('--dry-run', action='store_true')
    parser.add_argument('--env', default=str(ROOT / '.env'))
    parser.add_argument('--keep-date', action='store_true')
    parser.add_argument('--message-id', action='store_true', help='keep the Message-ID from the fixture')
    args = parser.parse_args()
    env = load_env(Path(args.env))
    lead_domain = env.get('LEAD_DOMAIN', '').strip().lower()
    if not args.dry_run and domain_blocked(lead_domain):
        raise SystemExit('refusing real send: set LEAD_DOMAIN to the catch-all domain, not example.org or testdomain.de')
    raw, headers = prepare(args.id, env, args.keep_date, args.message_id)
    out = ROOT / 'var' / 'outbox'
    out.mkdir(parents=True, exist_ok=True)
    stamp = datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%SZ')
    target = out / f'{args.id}-{stamp}.eml'
    target.write_text(raw, encoding='utf-8')
    if args.dry_run:
        print(f'dry-run wrote {target}')
        print(f"From: {headers.get('From', '')}")
        print(f"To: {headers.get('To', '')}")
        print(f"Subject: {headers.get('Subject', '')}")
        return
    host = env.get('SMTP_HOST', '')
    port = int(env.get('SMTP_PORT') or '587')
    user = env.get('SMTP_USER', '')
    password = env.get('SMTP_PASSWORD', '')
    if not host or not user:
        raise SystemExit('SMTP_HOST and SMTP_USER are required for a real send')
    envelope, recipient = envelope_and_to(headers, env)
    secure = (env.get('SMTP_SECURE') or 'starttls').lower()
    context = ssl.create_default_context()
    if secure == 'ssl' or port == 465:
        with smtplib.SMTP_SSL(host, port, context=context, timeout=30) as client:
            client.login(user, password)
            client.sendmail(envelope, [recipient], raw.encode('utf-8'))
    else:
        with smtplib.SMTP(host, port, timeout=30) as client:
            client.ehlo()
            if secure != 'plain':
                client.starttls(context=context)
                client.ehlo()
            client.login(user, password)
            client.sendmail(envelope, [recipient], raw.encode('utf-8'))
    print(f'sent {args.id} to {recipient}')


if __name__ == '__main__':
    main()
