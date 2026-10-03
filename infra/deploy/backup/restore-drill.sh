#!/usr/bin/env bash
# Restore drill (ADR-0028): proves the newest (or a given) backup can be restored.
#   1. verify checksums; 2. decrypt with the age identity (mounted only for the drill);
#   3. restore into a throw-away database on the same server; 4. recompute the manifest
#   and require an exact match (schema version, row counts, RLS tables, triggers);
#   5. drop the scratch database. Prints a JSON report; exits non-zero on any mismatch.
#
#   docker compose ... run --rm -v /secure/backup-identity.txt:/run/secrets/backup-identity.txt:ro \
#     backup drill [BACKUP_ID]
set -euo pipefail
umask 077

identity=${BACKUP_AGE_IDENTITY:-/run/secrets/backup-identity.txt}
[ -s "$identity" ] || { echo "restore drill needs the age identity at $identity" >&2; exit 2; }

backup=${1:-$(ls -1 /backups/db | sort | tail -n1)}
dir=/backups/db/$backup
[ -d "$dir" ] || { echo "no backup $backup" >&2; exit 2; }

started=$(date +%s)
(cd "$dir" && sha256sum --quiet -c SHA256SUMS)

scratch="hb_restore_drill_$(date -u +%Y%m%d%H%M%S)"
cleanup() { dropdb --if-exists --no-password "$scratch" >/dev/null 2>&1 || true; }
trap cleanup EXIT
createdb --no-password "$scratch"

age -d -i "$identity" "$dir/healthbridge.dump.age" \
  | pg_restore --dbname="$scratch" --exit-on-error --no-password
restored_at=$(date +%s)

psql -X -q -At -v ON_ERROR_STOP=1 -d "$scratch" -f /usr/local/share/healthbridge/manifest.sql \
  | sort >/tmp/restored-manifest.txt

if diff -u "$dir/manifest.txt" /tmp/restored-manifest.txt >/tmp/manifest.diff; then
  result=pass
else
  result=fail
  cat /tmp/manifest.diff >&2
fi

# The append-only audit guard must have survived the restore.
guard=$(psql -X -At -d "$scratch" -c "SELECT count(*) FROM pg_trigger WHERE tgrelid = 'audit.audit_logs'::regclass AND NOT tgisinternal")
[ "$guard" -ge 1 ] || result=fail

users=$(grep '^users|' /tmp/restored-manifest.txt | cut -d'|' -f2)
audit=$(grep '^audit_logs|' /tmp/restored-manifest.txt | cut -d'|' -f2)
migration=$(grep '^latest_migration|' /tmp/restored-manifest.txt | cut -d'|' -f2)
printf '{"drill":"%s","backup":"%s","restoreSeconds":%d,"totalSeconds":%d,"manifestMatch":%s,"auditGuardTriggers":%s,"users":%s,"auditLogs":%s,"latestMigration":"%s"}\n' \
  "$result" "$backup" "$((restored_at - started))" "$(($(date +%s) - started))" \
  "$([ -s /tmp/manifest.diff ] && echo false || echo true)" "$guard" "$users" "$audit" "$migration"
[ "$result" = pass ]
