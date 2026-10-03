#!/usr/bin/env bash
# Disaster recovery restore (docs/OPERATIONS.md): restores a backup into the configured
# database on a FRESH server (roles created by the postgres init scripts, database empty),
# then the document objects. Refuses to touch a database that already has tables.
#
#   docker compose ... run --rm -v /secure/backup-identity.txt:/run/secrets/backup-identity.txt:ro \
#     backup restore BACKUP_ID --confirm
set -euo pipefail

backup=${1:?usage: restore BACKUP_ID --confirm [--objects-from local|offsite]}
[ "${2:-}" = "--confirm" ] || { echo "add --confirm to restore $backup into $PGDATABASE" >&2; exit 2; }
source=${4:-local}
identity=${BACKUP_AGE_IDENTITY:-/run/secrets/backup-identity.txt}
dir=/backups/db/$backup

if [ ! -d "$dir" ] && [ -n "${BACKUP_REMOTE:-}" ]; then
  rclone copy "$BACKUP_REMOTE/db/$backup" "$dir" --quiet
fi
[ -d "$dir" ] || { echo "no backup $backup" >&2; exit 2; }
(cd "$dir" && sha256sum --quiet -c SHA256SUMS)

tables=$(psql -X -At -c "SELECT count(*) FROM pg_tables WHERE schemaname IN ('public','ai','audit')")
[ "$tables" = "0" ] || { echo "refusing: $PGDATABASE already has $tables tables" >&2; exit 3; }

age -d -i "$identity" "$dir/healthbridge.dump.age" \
  | pg_restore --dbname="$PGDATABASE" --exit-on-error --no-password
psql -X -q -At -v ON_ERROR_STOP=1 -f /usr/local/share/healthbridge/manifest.sql | sort \
  | diff -u "$dir/manifest.txt" - && echo "database restored and verified against the manifest"

crypt=localcrypt:
[ "$source" = offsite ] && crypt=offsitecrypt:
rclone sync "$crypt" "minio:$S3_BUCKET_DOCUMENTS" --fast-list --checksum --quiet
echo "document objects restored from $source"
