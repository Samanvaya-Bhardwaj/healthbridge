#!/usr/bin/env bash
# One encrypted backup (ADR-0028):
#   1. pg_dump (custom format) and the row-count manifest, taken in ONE exported snapshot,
#      so a restore must reproduce the manifest exactly;
#   2. the dump is encrypted with age to BACKUP_AGE_RECIPIENT (the private key is not on
#      this host); checksums are written alongside;
#   3. document objects are copied incrementally through rclone crypt (encrypted names and
#      contents) to /backups/objects, and to BACKUP_REMOTE when configured;
#   4. old local dumps are pruned (hourly window + one per day).
set -euo pipefail
umask 077

log() { printf '{"service":"healthbridge-backup","msg":"%s"%s}\n' "$1" "${2:+,$2}"; }

ts=$(date -u +%Y%m%dT%H%M%SZ)
dir=/backups/db/$ts
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"; [ -n "${holder:-}" ] && kill "$holder" 2>/dev/null || true' EXIT
mkdir -p "$dir"
started=$(date +%s)

# Hold a REPEATABLE READ transaction open and export its snapshot for pg_dump.
mkfifo "$tmp/in"
psql -X -q -At -v ON_ERROR_STOP=1 <"$tmp/in" >"$tmp/out" 2>"$tmp/err" &
holder=$!
exec 3>"$tmp/in"
echo "BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY; SELECT pg_export_snapshot();" >&3
for _ in $(seq 1 100); do [ -s "$tmp/out" ] && break; sleep 0.1; done
snapshot=$(head -n1 "$tmp/out")
[ -n "$snapshot" ] || { cat "$tmp/err" >&2; log "could not export snapshot"; exit 1; }

pg_dump --format=custom --compress=6 --no-password --snapshot="$snapshot" \
  | age -r "$BACKUP_AGE_RECIPIENT" -o "$dir/healthbridge.dump.age"

echo "\\o $tmp/manifest" >&3
echo "\\i /usr/local/share/healthbridge/manifest.sql" >&3
echo "COMMIT;" >&3
echo "\\q" >&3
exec 3>&-
wait "$holder"
holder=
sort "$tmp/manifest" >"$dir/manifest.txt"
(cd "$dir" && sha256sum healthbridge.dump.age manifest.txt >SHA256SUMS)
size=$(stat -c %s "$dir/healthbridge.dump.age")

# Document objects: incremental, encrypted at rest.
rclone sync "minio:$S3_BUCKET_DOCUMENTS" localcrypt: --fast-list --checksum --quiet
if [ -n "${BACKUP_REMOTE:-}" ]; then
  rclone copy "$dir" "$BACKUP_REMOTE/db/$ts" --quiet
  rclone sync "minio:$S3_BUCKET_DOCUMENTS" offsitecrypt: --fast-list --checksum --quiet
fi

# Retention: the newest BACKUP_KEEP_HOURLY dumps, plus the newest dump of each of the
# last BACKUP_KEEP_DAILY days.
mapfile -t all < <(ls -1 /backups/db | sort -r)
declare -A keep=()
for d in "${all[@]:0:${BACKUP_KEEP_HOURLY:-48}}"; do keep[$d]=1; done
declare -A day_seen=()
for d in "${all[@]}"; do
  day=${d:0:8}
  if [ -z "${day_seen[$day]:-}" ] && [ "${#day_seen[@]}" -lt "${BACKUP_KEEP_DAILY:-14}" ]; then
    day_seen[$day]=1
    keep[$d]=1
  fi
done
pruned=0
for d in "${all[@]}"; do
  if [ -z "${keep[$d]:-}" ]; then rm -rf "/backups/db/$d"; pruned=$((pruned + 1)); fi
done

log "backup complete" "\"backup\":\"$ts\",\"dumpBytes\":$size,\"seconds\":$(($(date +%s) - started)),\"pruned\":$pruned,\"offsite\":$([ -n "${BACKUP_REMOTE:-}" ] && echo true || echo false)"
