# syntax=docker/dockerfile:1
#
# Static web UI image: Rust builds the WASM core, Node bundles the React page,
# nginx serves the result. Nothing needs a backend or a POD Go to start.

# --- 1. WebAssembly core -----------------------------------------------------
FROM rust:1.90-bookworm AS wasm

ARG TARGETARCH=amd64

RUN rustup target add wasm32-unknown-unknown

# The binding must match the wasm-bindgen crate version exactly (0.2.130).
RUN set -eux; \
    case "${TARGETARCH}" in \
      amd64) triple="x86_64-unknown-linux-musl" ;; \
      arm64) triple="aarch64-unknown-linux-musl" ;; \
      *) echo "unsupported architecture: ${TARGETARCH}" >&2; exit 1 ;; \
    esac; \
    curl -fsSL -o /tmp/wasm-bindgen.tar.gz \
      "https://github.com/wasm-bindgen/wasm-bindgen/releases/download/0.2.130/wasm-bindgen-0.2.130-${triple}.tar.gz"; \
    tar -xzf /tmp/wasm-bindgen.tar.gz -C /tmp; \
    install -m 0755 "/tmp/wasm-bindgen-0.2.130-${triple}/wasm-bindgen" /usr/local/bin/wasm-bindgen; \
    rm -rf /tmp/wasm-bindgen*

WORKDIR /src
COPY . .

RUN cargo build \
      --manifest-path apps/web/wasm/Cargo.toml \
      --target wasm32-unknown-unknown \
      --release
RUN wasm-bindgen \
      apps/web/wasm/target/wasm32-unknown-unknown/release/podgo_wasm.wasm \
      --target web \
      --out-dir /wasm-out

# --- 2. Static site ----------------------------------------------------------
FROM node:22-bookworm-slim AS build

WORKDIR /src

# Install dependencies before copying the source so edits reuse this layer.
COPY apps/web/package.json apps/web/package-lock.json ./apps/web/
RUN cd apps/web && npm ci

COPY . .
COPY --from=wasm /wasm-out ./apps/web/src/wasm

# `prebuild` would rebuild the WASM; it is already built in the stage above.
RUN cd apps/web \
    && npm run fixtures \
    && npx tsc --noEmit \
    && npx vite build

# --- 3. Runtime --------------------------------------------------------------
FROM nginx:alpine AS runtime

COPY deploy/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /src/apps/web/dist /usr/share/nginx/html

EXPOSE 80
