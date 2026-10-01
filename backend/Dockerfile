# syntax=docker/dockerfile:1.7
# Build context: repository root (npm workspaces share one lockfile).
#   docker build -f backend/Dockerfile .

ARG NODE_IMAGE=node:24-alpine

FROM ${NODE_IMAGE} AS deps
WORKDIR /app
COPY package.json package-lock.json ./
COPY shared/package.json shared/
COPY backend/package.json backend/
COPY frontend/package.json frontend/
RUN --mount=type=cache,target=/root/.npm \
    npm ci --workspace backend --include-workspace-root=false --omit=dev --ignore-scripts

FROM ${NODE_IMAGE} AS runtime
ENV NODE_ENV=production \
    NODE_OPTIONS=--enable-source-maps
WORKDIR /app
RUN apk add --no-cache tini
COPY --from=deps --chown=node:node /app/node_modules ./node_modules
COPY --chown=node:node package.json ./
COPY --chown=node:node shared ./shared
COPY --chown=node:node backend/package.json backend/knexfile.js ./backend/
COPY --chown=node:node backend/src ./backend/src
COPY --chown=node:node backend/scripts ./backend/scripts
COPY --chown=node:node backend/migrations ./backend/migrations

USER node
WORKDIR /app/backend
EXPOSE 4000 9464

HEALTHCHECK --interval=15s --timeout=3s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.API_PORT||4000)+'/health/live').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "src/server.js"]
