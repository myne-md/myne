# Self-hostable web client (phase3-web-client task 49).
#
# The web client is AGPL-3.0 like the rest of the application code, so it has to
# be self-hostable **in practice**, not just in licence — and that is more than
# publishing a bundle. The image carries the bundle AND a server with the
# security headers baked in, because those headers are a real part of the
# security posture and a self-hoster serving static files with defaults loses
# them silently.
#
# It is also what makes the threat model's self-host mitigation real rather than
# nominal: a user who builds and serves their own bundle is their own
# code-delivery operator, and A15 does not apply to them — but only if serving
# it correctly is achievable (`threat-model.md` A15/TB11).

# ── wasm ─────────────────────────────────────────────────────────────────────
# `web/wasm/pkg/` is GITIGNORED — it is derived from `web/wasm/src/` plus the
# pinned toolchain. A build that copied it in would work on a developer machine
# that happens to have run `scripts/build-wasm.sh` and fail on every clean
# checkout, CI included. Building it here is also what makes `docker build`
# alone reproduce the whole client from source, which is the self-host claim
# (`myne-agents/docs/self-host-web.md`, threat-model A15/TB11).
FROM rust:1.96-bookworm AS wasm
# `build-wasm.sh` reads cargo's JSON artefact records with node rather than
# guessing a target path (shared-target dirs make a guessed path pick up a stale
# `.wasm`). Debian's nodejs is old but only ever parses those records here.
RUN apt-get update \
 && apt-get install -y --no-install-recommends nodejs \
 && rm -rf /var/lib/apt/lists/*
# Version read from the lock, not hardcoded: wasm-bindgen refuses a CLI/library
# mismatch, and it is right to — the glue encodes the ABI the library compiled
# against. Installed before the source is copied so a source edit does not
# rebuild the CLI.
WORKDIR /tmp/wasm-bindgen
COPY Cargo.lock .
RUN WBV="$(awk '/^name = "wasm-bindgen"$/{getline; gsub(/version = |"/,""); print; exit}' Cargo.lock)" \
 && cargo install wasm-bindgen-cli --version "$WBV" --locked
WORKDIR /src
COPY . .
RUN ./scripts/build-wasm.sh

# ── build ────────────────────────────────────────────────────────────────────
# Pinned by digest at release time (task 16); the tag here is the development
# form and is replaced by the reproducible-build pipeline.
FROM node:25-slim AS build
WORKDIR /src
# Manifests first, install second, source tree third. The order is the cache:
# `web-container-check` rebuilds this image on every push, and `COPY . .` ahead
# of the install meant any source edit invalidated the pnpm layer and reinstalled
# the whole workspace. Every workspace member's manifest has to be here, because
# `pnpm install --frozen-lockfile` resolves the workspace from them.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY mobile/package.json ./mobile/
COPY dialect/package.json ./dialect/
COPY editor/package.json ./editor/
COPY copy/package.json ./copy/
COPY client-core/package.json ./client-core/
COPY ornaments/package.json ./ornaments/
COPY preview/package.json ./preview/
RUN corepack enable pnpm || npm install -g pnpm@11.8.0
RUN pnpm install --frozen-lockfile --ignore-scripts
# node_modules is excluded from the build context, so this copy adds the source
# without touching the tree the install just produced.
COPY . .
COPY --from=wasm /src/web/wasm/pkg ./web/wasm/pkg
# `.git` is excluded from the build context (it is large and carries nothing the
# bundle needs), so `emit-web-version.mjs` cannot read the commit from git here.
# Passed in instead — still the COMMIT's identity and its own timestamp, never a
# wall clock, so a rebuild of the same commit stays byte-identical (task 111).
ARG MYNE_BUILD_COMMIT=""
ARG MYNE_BUILD_TIMESTAMP=""
ENV MYNE_BUILD_COMMIT=$MYNE_BUILD_COMMIT
ENV MYNE_BUILD_TIMESTAMP=$MYNE_BUILD_TIMESTAMP
RUN pnpm web:build
# The header generator is TypeScript alongside the app; compile just it.
# `--ignoreConfig`: the repo tsconfig has `include: ["src"]` and tsc refuses a
# file argument alongside a loaded config.
#
# `--module es2022`, not `nodenext`: with no `package.json` beside the output,
# `nodenext` resolves the emit to CommonJS and the ESM entrypoint then cannot
# import a named export from it. The runtime stage drops a `{"type":"module"}`
# marker next to the file for the same reason.
RUN pnpm exec tsc --ignoreConfig web/csp.ts --outDir /out/web --module es2022 --target es2022 --moduleResolution bundler --skipLibCheck

# ── runtime ──────────────────────────────────────────────────────────────────
FROM caddy:2.8-alpine
RUN apk add --no-cache nodejs
COPY --from=build /src/web/dist /srv/web
COPY --from=build /out/web/csp.js /opt/myne/csp.js
# Marks the directory as ESM so `csp.js` is loaded as a module (see the tsc
# invocation above).
RUN printf '{"type":"module"}\n' > /opt/myne/package.json
COPY web/container/generate-headers.mjs /opt/myne/generate-headers.mjs
COPY web/container/Caddyfile /etc/caddy/Caddyfile
COPY web/container/entrypoint.sh /usr/local/bin/entrypoint.sh
RUN chmod +x /usr/local/bin/entrypoint.sh

# No default. A container that starts without being told which sync server to
# talk to must fail loudly, not guess.
ENV MYNE_SYNC_ORIGIN=""
ENV PORT=8080
EXPOSE 8080

# AGPL §13: an operator serving this over a network owes its users the
# corresponding source. The About surface carries the offer; this label is the
# machine-readable half.
LABEL org.opencontainers.image.licenses="AGPL-3.0"
LABEL org.opencontainers.image.source="https://github.com/myne-md/myne"

# Probe over loopback so compose / Komodo can report container state and restart
# a wedged one (task 111). `/healthz` writes no log line, so this does not
# reintroduce a per-request record.
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD wget -q -O- "http://127.0.0.1:${PORT:-8080}/healthz" || exit 1

ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
