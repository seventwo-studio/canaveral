# Controller and dashboard use Node's built-in SQLite implementation.
FROM node:24-bookworm-slim AS node-build
WORKDIR /app
COPY coordination/package*.json ./coordination/
COPY dashboard/package*.json ./dashboard/
RUN npm --prefix coordination ci --ignore-scripts && npm --prefix dashboard ci --ignore-scripts
COPY coordination ./coordination
COPY dashboard ./dashboard
# prepare_cli.mjs imports package_checks.mjs to verify the emitted module closure.
COPY script/prepare_cli.mjs script/package_checks.mjs ./script/
RUN npm --prefix coordination run build && npm --prefix dashboard run build

FROM rust:1.99.1-bookworm AS rust-build
WORKDIR /source
ENV CARGO_BUILD_JOBS=2
COPY Cargo.toml Cargo.lock rust-toolchain.toml ./
COPY crates ./crates
COPY coordination/src/providers/apple-native.rs ./coordination/src/providers/apple-native.rs
RUN cargo build --release --workspace --bins --locked -j 2

FROM node:24-bookworm-slim AS base
ENV NODE_ENV=production
WORKDIR /app
RUN groupadd --gid 10001 canaveral && useradd --uid 10001 --gid 10001 --create-home canaveral && \
    mkdir /data /run/credentials /run/tls && chown canaveral:canaveral /data /run/credentials /run/tls
COPY --from=node-build /app/coordination/dist/src ./coordination/dist/src
COPY coordination/package.json ./coordination/package.json
COPY canaveral/schemas ./canaveral/schemas
COPY --from=node-build /app/canaveral/web ./canaveral/web
ENTRYPOINT ["node", "/app/coordination/dist/src/cli.js"]
USER 10001:10001

FROM base AS dashboard
EXPOSE 8766
CMD ["dashboard", "--bind", "0.0.0.0"]

FROM base AS orchestrator
EXPOSE 8765
# Non-loopback controller listeners require TLS, including container interfaces.
# Mount server certificates separately from enrollment and operator credentials.
CMD ["serve", "--bind", "0.0.0.0", "--database", "/data/orchestrator.sqlite3", "--admin-token-file", "/run/credentials/admin.token", "--enrollment-token-file", "/run/credentials/enrollment.token", "--tls-cert-file", "/run/tls/server.crt", "--tls-key-file", "/run/tls/server.key"]

# Worker SDKs remain separate from the unprivileged controller image.
FROM base AS libvirt
COPY --from=rust-build /source/target/release/canaveral-mobile-native /app/native/canaveral-mobile-native
USER root
RUN apt-get update && apt-get install -y --no-install-recommends libvirt-clients qemu-utils genisoimage openssh-client && rm -rf /var/lib/apt/lists/*
USER 10001:10001

FROM debian:bookworm-slim AS native
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates && rm -rf /var/lib/apt/lists/* && \
    groupadd --gid 10001 canaveral && useradd --uid 10001 --gid 10001 --create-home canaveral
COPY --from=rust-build /source/target/release/canaveral-runner-client /usr/local/bin/
COPY --from=rust-build /source/target/release/canaveral-model-execution /usr/local/bin/
COPY --from=rust-build /source/target/release/canaveral-guest-agent /usr/local/bin/
COPY --from=rust-build /source/target/release/canaveral-mobile-native /usr/local/bin/
USER 10001:10001
# Each native executable keeps its own strict configuration and acceptance gates.
ENTRYPOINT ["/usr/local/bin/canaveral-model-execution"]

FROM node:24-bookworm-slim@sha256:dc26ae92c9fb15cf6b1d63e20f0944b2efe0f115b20e00be48fb23fceb061c54 AS canaverald
WORKDIR /app
ENV NODE_ENV=production HOME=/tmp
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates libvirt-clients qemu-utils genisoimage &&     rm -rf /var/lib/apt/lists/* && groupadd --gid 10001 canaverald &&     useradd --uid 10001 --gid 10001 --no-create-home canaverald
COPY --from=node-build /app/coordination/dist/src ./coordination/dist/src
COPY coordination/package.json ./coordination/package.json
COPY canaveral/schemas ./canaveral/schemas
COPY --from=rust-build /source/target/release/canaveral-model-execution /usr/local/bin/
RUN ln -s /app/coordination/dist/src/canaverald.js /usr/local/bin/canaverald &&     chmod 0755 /app/coordination/dist/src/canaverald.js
USER 10001:10001
ENTRYPOINT ["canaverald"]
CMD ["--config", "/etc/canaverald/host.json", "--state", "/var/lib/canaverald"]
