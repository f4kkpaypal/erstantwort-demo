#!/bin/sh
set -eu
cd "$(dirname "$0")/.."
echo "Importing workflows once. A second import duplicates them if the ids were deleted in the UI."
docker compose exec -T n8n n8n import:workflow --separate --input=/workflows
echo "Done. Activate only WF-01 Intake. Leave WF-06 inactive."
echo "Open N01 IMAP and attach the credential named IMAP Makler."
