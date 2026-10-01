# ADR-0013: S3-compatible object storage (MinIO locally)

- **Status:** Accepted
- **Date:** 2026-10-01

## Context

Medical documents must never be stored in PostgreSQL. Access must be controlled, short-lived
and audited.

## Decision

- Use the **S3 API**: AWS S3 (SSE-KMS, versioning, lifecycle via infrastructure-as-code)
  in production and **MinIO** locally.
- The database stores only metadata: object key, owner, type, SHA-256 hash, size, upload
  time and status.
- Access is only through **short-lived presigned URLs**, issued after authorisation and
  consent checks, with every issuance audited.
- Uploads land in a quarantine prefix and are promoted only after validation and a
  malware scan.
- Bucket versioning is enabled to protect originals.
- **Local image:** MinIO no longer publishes community images to Docker Hub or Quay
  (verified 2026-10-01). We use Chainguard's maintained `cgr.dev/chainguard/minio`,
  **pinned by digest**. The image has no curl, wget or grep, so its health check uses a
  pure-bash HTTP probe.
- Local bucket creation is done by `scripts/bootstrap-storage.js`, which refuses to run in
  staging or production.

## Consequences

- Same code path locally and in production. Only the endpoint and credentials differ.
- If the Chainguard image becomes unsuitable, alternatives are building MinIO from source
  or another S3-compatible server. No application change is needed.
