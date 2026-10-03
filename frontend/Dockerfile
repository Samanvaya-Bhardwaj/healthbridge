# syntax=docker/dockerfile:1.7
# Build context: repository root.
#   docker build -f frontend/Dockerfile .

FROM node:24-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
COPY shared/package.json shared/
COPY backend/package.json backend/
COPY frontend/package.json frontend/
RUN --mount=type=cache,target=/root/.npm \
    npm ci --workspace frontend --include-workspace-root=false
COPY shared ./shared
COPY frontend ./frontend
RUN npm run build --workspace frontend

# Unprivileged Nginx (runs as non-root, listens on 8080).
FROM nginxinc/nginx-unprivileged:1.29-alpine AS runtime
# Apply OS security updates published after the base image was built, then drop back
# to the unprivileged nginx user (uid 101).
USER root
RUN apk upgrade --no-cache
USER 101
COPY infra/nginx/default.conf /etc/nginx/conf.d/default.conf
# Owned by the nginx user: the start-up script adapts them per environment.
COPY --chown=101:101 infra/nginx/app.conf infra/nginx/security-headers.conf /etc/nginx/snippets/
# Start-up script: HB_TLS=on (TLS variant), HB_STORAGE_PROXY=off, HB_CSP_CONNECT_EXTRA.
COPY infra/nginx/default.tls.conf /etc/nginx/variants/default.tls.conf
COPY --chmod=755 infra/nginx/40-healthbridge.sh /docker-entrypoint.d/40-healthbridge.sh
COPY --from=build /app/frontend/dist /usr/share/nginx/html
EXPOSE 8080
HEALTHCHECK --interval=15s --timeout=3s --start-period=5s --retries=3 \
  CMD wget -q -O /dev/null http://127.0.0.1:8080/healthz || exit 1
