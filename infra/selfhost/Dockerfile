# Build with the repository as context; the sibling allowlist excludes secrets/data.
FROM rust:1.92.0-bookworm AS rust-build
WORKDIR /build
COPY Cargo.toml Cargo.lock ./
COPY crates ./crates
COPY migrations ./migrations
ARG CARGO_BUILD_JOBS=2
RUN --mount=type=cache,target=/usr/local/cargo/registry \
    --mount=type=cache,target=/usr/local/cargo/git \
    --mount=type=cache,target=/build/target \
    CARGO_BUILD_JOBS=${CARGO_BUILD_JOBS} cargo build --release --locked -p tomorrow-api -p tomorrow-worker -p tomorrow-settings && \
    mkdir /out && cp target/release/tomorrow-api target/release/tomorrow-worker target/release/tada-admin-recover target/release/tada-config /out/

FROM node:22.19.0-bookworm-slim AS node-base
ENV CI=true
RUN corepack enable && corepack prepare pnpm@10.20.0 --activate

FROM node-base AS agent-build
WORKDIR /build/services/agent
COPY services/agent/package.json services/agent/pnpm-lock.yaml ./
RUN --mount=type=cache,target=/root/.local/share/pnpm/store pnpm install --frozen-lockfile
COPY services/agent/tsconfig.json ./
COPY services/agent/src ./src
RUN pnpm run build && pnpm prune --prod

FROM node-base AS admin-build
WORKDIR /build/apps/admin
COPY apps/admin/package.json apps/admin/pnpm-lock.yaml ./
RUN --mount=type=cache,target=/root/.local/share/pnpm/store pnpm install --frozen-lockfile
COPY apps/admin/index.html apps/admin/tsconfig.json apps/admin/vite.config.ts ./
COPY apps/admin/src ./src
RUN pnpm run build

# PostgreSQL 17 clients support the Compose PG17 server; no database runs here.
FROM pgvector/pgvector:0.8.7-pg17-trixie AS server
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates python3 python3-cryptography libstdc++6 && \
    rm -rf /var/lib/apt/lists/* && groupadd --gid 10001 tada && useradd --uid 10001 --gid 10001 --no-create-home --home /data tada
COPY --from=rust-build /out/tomorrow-api /out/tomorrow-worker /out/tada-admin-recover /out/tada-config /usr/local/bin/
COPY --from=node-base /usr/local/bin/node /usr/local/bin/node
COPY --from=agent-build /build/services/agent/dist /opt/tada/agent/dist
COPY --from=agent-build /build/services/agent/node_modules /opt/tada/agent/node_modules
COPY --from=agent-build /build/services/agent/package.json /opt/tada/agent/package.json
COPY --from=admin-build /build/apps/admin/dist /opt/tada/admin
COPY infra/selfhost/initialize.py infra/selfhost/run.py infra/selfhost/restore.py /opt/tada/selfhost/
ENV API_BIND=0.0.0.0:8080 \
    AGENT_MODE=pi AGENT_URL=http://127.0.0.1:8090 AGENT_PORT=8090 RUST_API_URL=http://127.0.0.1:8080 TADA_RUNTIME_CONFIG=enabled \
    SCHEDULER_MODE=local \
    TADA_CONFIG_DIR=/data/config TADA_ADMIN_DIST=/opt/tada/admin \
    UPLOAD_STORAGE=local UPLOAD_DIR=/data/uploads BACKUP_DIR=/data/backups \
    BACKUP_RECOVERY_FILES=/data/runtime.env BACKUP_ENABLED=true \
    PYTHONUNBUFFERED=1 RUST_LOG=tomorrow_api=info,tomorrow_worker=info
WORKDIR /data
USER 10001:10001
EXPOSE 8080
HEALTHCHECK --interval=20s --timeout=3s --start-period=60s --retries=3 \
    CMD ["python3", "-c", "import urllib.request; urllib.request.urlopen('http://127.0.0.1:8080/v1/health',timeout=2).close()"]
ENTRYPOINT ["python3", "/opt/tada/selfhost/run.py"]
