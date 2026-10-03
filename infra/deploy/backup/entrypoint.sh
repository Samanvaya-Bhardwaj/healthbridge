#!/usr/bin/env bash
# Configures rclone from the environment, then runs a command:
#   schedule      back up every BACKUP_INTERVAL_MINUTES (default 60) — the default
#   backup        one backup now
#   drill [ID]    restore drill (needs the age identity mounted)
#   restore ID --confirm [--objects-from local|offsite]
set -euo pipefail

# rclone remotes (config via environment; passwords must be "obscured" for rclone).
export RCLONE_CONFIG_MINIO_TYPE=s3
export RCLONE_CONFIG_MINIO_PROVIDER=Minio
export RCLONE_CONFIG_MINIO_ENDPOINT=${MINIO_ENDPOINT:-http://minio:9000}
export RCLONE_CONFIG_MINIO_ACCESS_KEY_ID=$S3_ACCESS_KEY_ID
export RCLONE_CONFIG_MINIO_SECRET_ACCESS_KEY=$S3_SECRET_ACCESS_KEY
obscured=$(rclone obscure "$BACKUP_OBJECTS_PASSWORD")
export RCLONE_CONFIG_LOCALCRYPT_TYPE=crypt
export RCLONE_CONFIG_LOCALCRYPT_REMOTE=/backups/objects
export RCLONE_CONFIG_LOCALCRYPT_PASSWORD=$obscured
if [ -n "${BACKUP_REMOTE:-}" ]; then
  export RCLONE_CONFIG_OFFSITECRYPT_TYPE=crypt
  export RCLONE_CONFIG_OFFSITECRYPT_REMOTE=$BACKUP_REMOTE/objects
  export RCLONE_CONFIG_OFFSITECRYPT_PASSWORD=$obscured
fi
mkdir -p /backups/db /backups/objects

case "${1:-schedule}" in
  schedule)
    interval=$((${BACKUP_INTERVAL_MINUTES:-60} * 60))
    while :; do
      backup.sh || echo '{"service":"healthbridge-backup","level":"error","msg":"backup failed"}'
      sleep "$interval" &
      wait $!
    done
    ;;
  backup) exec backup.sh ;;
  drill) shift; exec restore-drill.sh "$@" ;;
  restore) shift; exec restore.sh "$@" ;;
  *) exec "$@" ;;
esac
