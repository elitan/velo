#!/bin/sh
set -eu

cat >> "$PGDATA/postgresql.conf" <<'CONF'

# Velo local prod-like WAL archiving.
wal_level = replica
archive_mode = on
archive_command = 'pgbackrest --config=/etc/pgbackrest.conf --stanza=main archive-push %p'
archive_timeout = '5s'
max_wal_senders = 10
CONF
