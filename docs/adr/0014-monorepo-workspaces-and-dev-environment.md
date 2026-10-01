# ADR-0014: Monorepo with npm workspaces; repository outside cloud-sync folders

- **Status:** Accepted
- **Date:** 2026-10-01

## Context

The frontend and backend share constants and, later, validation schemas. The project was
initially created inside a OneDrive-synced folder. Syncing `node_modules`, Docker volumes
and model caches there causes file locks, slowness and conflicts.

## Decision

- A single repository with `frontend/`, `backend/`, `shared/`, `ai-service/`, `infra/` and
  `docs/`.
- **npm workspaces** for the JavaScript packages, with one lockfile. `@healthbridge/shared`
  holds shared constants and, later, Zod schemas. The AI service is managed by **uv** with
  a committed `uv.lock`.
- The repository lives at `C:\dev\healthbridge`, **outside OneDrive**.
- `.gitignore` excludes dependencies, build output, caches, model weights, Docker data,
  logs, temporary files and all `.env*` except `.env.example`. `.gitattributes` enforces
  LF line endings (shell scripts run inside Linux containers).
- `scripts/generate-env.mjs` creates a local `.env` with random secrets. It also detects
  host ports already in use (e.g. a local PostgreSQL on 5432) and remaps them.
- Docker images are built from the repository root for the JS packages (shared lockfile)
  and from `ai-service/` for Python.

## Consequences

- One `npm ci` sets up all JavaScript packages, and versions cannot drift between packages.
- Contributors on Windows should use Docker Desktop with the WSL2 backend and keep the
  clone outside synced folders.
