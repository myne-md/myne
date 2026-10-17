# The design-system catalogue, served at design.myne.md.
#
# A two-stage build: the public variant of `stories/` (myne-md/myne#832's
# catalogue, public since the design.myne.md work) plus a static server that
# carries the security headers, so the deployed bytes and the bytes the guards
# inspect are the same image layer rather than two runs of one command.
#
# Build from the REPOSITORY ROOT, because the catalogue consumes the shared
# `src/` tree and the shared `public/` tree above its own Vite root:
#
#     docker build -f stories/container/Dockerfile -t myne-stories .
#
# `stories/container/Caddyfile` carries the policy and the reasoning behind each
# directive; this file only assembles it.

# ── build ────────────────────────────────────────────────────────────────────
FROM node:25-slim AS build
WORKDIR /src
COPY . .
RUN corepack enable pnpm || npm install -g pnpm@11.8.0
RUN pnpm install --frozen-lockfile --ignore-scripts
# The PUBLIC variant. `STORIES_PUBLIC=1` renders neither the source link, nor the
# issue form, nor the Welcome page's list of repositories — all three name
# `github.com/myne-md`, which is private, so all three are a 404 to a reader of
# this origin. `check-stories-public-bundle.mjs` asserts that absence on the
# artefact and the presence of a sentinel proving the build really is the public
# one, and CI runs both this build and that guard.
#
# `.git` is not in the build context (`.dockerignore`), so `stories/vite.config.ts`'s
# `branchName()` falls back to `develop`. That is inert here rather than lucky:
# the branch is only ever used to build a source URL, and the public variant
# renders none. `check-stories-public-bundle.mjs` is what keeps the fallback
# from mattering.
RUN pnpm stories:build:public

# ── runtime ──────────────────────────────────────────────────────────────────
FROM caddy:2.8-alpine
COPY --from=build /src/stories/dist-public /srv/catalogue
COPY stories/container/Caddyfile /etc/caddy/Caddyfile

ENV PORT=8080
EXPOSE 8080

# AGPL §13: an operator serving this over a network owes its users the
# corresponding source. `app.example.com`'s container carries the same pair.
LABEL org.opencontainers.image.licenses="AGPL-3.0"
LABEL org.opencontainers.image.source="https://github.com/myne-md/myne"

# Probe over loopback so compose / Komodo can report container state and restart
# a wedged one. `/healthz` writes no log line, so this does not reintroduce the
# per-request record the log filter above removes.
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD wget -q -O- "http://127.0.0.1:${PORT:-8080}/healthz" || exit 1
