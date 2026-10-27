#!/usr/bin/env python3
"""Print a Google refresh token for Calendar events and Sheets.

Create an OAuth client of type Desktop in Google Cloud, enable Calendar API
and Google Sheets API, then pass the client id and secret. Paste the code
from the browser address bar after you approve the consent screen.
"""

import argparse
import json
import urllib.parse
import urllib.request

SCOPES = ' '.join([
    'https://www.googleapis.com/auth/calendar.events',
    'https://www.googleapis.com/auth/spreadsheets',
])


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--client-id', required=True)
    parser.add_argument('--client-secret', required=True)
    args = parser.parse_args()
    query = urllib.parse.urlencode({
        'client_id': args.client_id,
        'redirect_uri': 'http://localhost',
        'response_type': 'code',
        'scope': SCOPES,
        'access_type': 'offline',
        'prompt': 'consent',
    })
    print('Open this URL and approve access:')
    print(f'https://accounts.google.com/o/oauth2/v2/auth?{query}')
    print('The browser will stop on localhost. Copy only the code parameter.')
    code = input('Code: ').strip()
    if 'code=' in code:
        parsed = urllib.parse.urlparse(code if '://' in code else f'http://localhost/?{code}')
        code = urllib.parse.parse_qs(parsed.query).get('code', [code])[0]
    body = urllib.parse.urlencode({
        'code': code,
        'client_id': args.client_id,
        'client_secret': args.client_secret,
        'redirect_uri': 'http://localhost',
        'grant_type': 'authorization_code',
    }).encode('utf-8')
    req = urllib.request.Request(
        'https://oauth2.googleapis.com/token',
        data=body,
        headers={'Content-Type': 'application/x-www-form-urlencoded'},
    )
    with urllib.request.urlopen(req, timeout=30) as res:
        data = json.loads(res.read().decode('utf-8'))
    token = data.get('refresh_token')
    if not token:
        raise SystemExit('no refresh_token in the response; approve the prompt again')
    print('Put this into .env as GOOGLE_OAUTH_REFRESH_TOKEN=')
    print(token)


if __name__ == '__main__':
    main()
