# syntax=docker/dockerfile:1.7
# Backup and restore tooling for the single-host deployment (ADR-0028).
#   docker build -t healthbridge-backup infra/deploy/backup
# pg_dump/pg_restore 17 (matches the pgvector/pg17 server), age (encryption),
# rclone (incremental, encrypted copies of document objects; optional off-site).
FROM postgres:17-alpine
# gosu (base-image privilege dropper, an old Go build) is unused: this image runs as
# `postgres` from the start, so it is removed rather than carried with its CVEs.
RUN apk upgrade --no-cache && apk add --no-cache age rclone bash coreutils \
  && rm -f /usr/local/bin/gosu
COPY --chmod=755 backup.sh restore-drill.sh restore.sh entrypoint.sh /usr/local/bin/
COPY manifest.sql /usr/local/share/healthbridge/manifest.sql
# Named volumes inherit this ownership on first use; everything runs unprivileged.
RUN mkdir -p /backups && chown postgres:postgres /backups && chmod 700 /backups
USER postgres
WORKDIR /backups
ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
CMD ["schedule"]
