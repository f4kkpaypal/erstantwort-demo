#!/bin/sh
# One command for the live stack. Reads .env and does not print it.
set -eu
cd "$(dirname "$0")/.."
if [ ! -f .env ]; then
  echo "env_missing"
  exit 1
fi
set -a
# shellcheck disable=SC1091
. ./.env
set +a
if [ -z "${SITE_ADDRESS:-}" ] || [ -z "${APP_ADDRESS:-}" ] || [ -z "${ACME_EMAIL:-}" ]; then
  echo "prod_env_incomplete"
  exit 1
fi
exec docker compose --env-file .env -f docker-compose.prod.yml up -d --build
