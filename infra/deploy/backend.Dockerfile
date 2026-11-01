# Debian 12 / glibc 2.36 binaries also run on Ubuntu 24.04 / glibc 2.39.
# Build locally; the small cloud host needs no Rust compiler or Node installation.
FROM rust:1.92.0-bookworm AS rust-build
WORKDIR /build
COPY Cargo.toml Cargo.lock ./
COPY crates ./crates
COPY migrations ./migrations
ARG BUILD_API_ONLY=0
ARG CARGO_BUILD_JOBS=2
ENV CARGO_BUILD_JOBS=${CARGO_BUILD_JOBS}
RUN --mount=type=cache,target=/usr/local/cargo/registry \
    --mount=type=cache,target=/usr/local/cargo/git \
    --mount=type=cache,target=/build/target \
    find crates migrations -type f -exec touch {} + && touch Cargo.toml Cargo.lock && \
    if [ "$BUILD_API_ONLY" = "1" ]; then \
        cargo build --release --locked -p tomorrow-api --bin tomorrow-api && \
        mkdir -p /out && cp target/release/tomorrow-api /out/; \
    else \
        cargo build --release --locked -p tomorrow-api -p tomorrow-worker -p tomorrow-settings && \
        mkdir -p /out && cp target/release/tomorrow-api target/release/tomorrow-worker target/release/tada-config target/release/tada-admin-recover /out/; \
    fi

FROM scratch AS api-package
COPY --from=rust-build /out/tomorrow-api /bin/tomorrow-api

FROM node:22.19.0-bookworm-slim AS agent-build
ENV CI=true
RUN corepack enable && corepack prepare pnpm@10.20.0 --activate
WORKDIR /build/services/agent
COPY services/agent/package.json services/agent/pnpm-lock.yaml ./
RUN --mount=type=cache,target=/root/.local/share/pnpm/store \
    pnpm install --frozen-lockfile
COPY services/agent/tsconfig.json ./
COPY services/agent/src ./src
RUN pnpm run build && pnpm prune --prod

FROM node:22.19.0-bookworm-slim AS admin-build
ENV CI=true
RUN corepack enable && corepack prepare pnpm@10.20.0 --activate
WORKDIR /build/apps/admin
COPY apps/admin/package.json apps/admin/pnpm-lock.yaml ./
RUN --mount=type=cache,target=/root/.local/share/pnpm/store pnpm install --frozen-lockfile
COPY apps/admin/tsconfig.json apps/admin/vite.config.ts apps/admin/index.html ./
COPY apps/admin/src ./src
RUN pnpm run build

FROM scratch AS package
COPY --from=rust-build /out/tomorrow-api /bin/tomorrow-api
COPY --from=rust-build /out/tomorrow-worker /bin/tomorrow-worker
COPY --from=rust-build /out/tada-config /bin/tada-config
COPY --from=rust-build /out/tada-admin-recover /bin/tada-admin-recover
COPY --from=agent-build /usr/local/bin/node /bin/node
COPY --from=agent-build /build/services/agent/dist /services/agent/dist
COPY --from=agent-build /build/services/agent/node_modules /services/agent/node_modules
COPY --from=agent-build /build/services/agent/package.json /services/agent/package.json
COPY --from=agent-build /build/services/agent/pnpm-lock.yaml /services/agent/pnpm-lock.yaml
COPY --from=admin-build /build/apps/admin/dist /admin
COPY infra/selfhost/restore.py /tools/restore.py
COPY infra/deploy/systemd /templates/systemd
COPY infra/deploy/nginx.conf /templates/nginx.conf
COPY infra/deploy/nginx-provider-https.conf /templates/nginx-provider-https.conf
COPY infra/deploy/aliyun-pnvs-send-policy.json /templates/aliyun-pnvs-send-policy.json
COPY infra/deploy/runtime.env.example /templates/runtime.env.example
COPY infra/deploy/database.env.example /templates/database.env.example
COPY infra/deploy/model.env.example /templates/model.env.example
COPY infra/deploy/prepare-host.sh /prepare-host.sh
COPY infra/deploy/verify-local.sh /verify-local.sh
COPY infra/deploy/verify-package.sh /verify-package.sh
COPY infra/deploy/README.md /README.md
