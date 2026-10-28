-- Runs once, when the Postgres volume is first created.
-- n8n uses POSTGRES_DB. The lead pipeline uses the separate makler database.
SELECT 'CREATE DATABASE makler'
WHERE NOT EXISTS (SELECT FROM pg_database WHERE datname = 'makler')\gexec
