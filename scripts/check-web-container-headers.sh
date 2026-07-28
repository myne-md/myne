#!/usr/bin/env bash
# Assert the web-client container actually SERVES its security headers and its
# operational endpoints (phase3-web-client tasks 49, 50, 55, 111).
#
# This exists because both properties were broken in a shipped image while every
# other check was green, and both failures were of the same kind: the
# configuration was right, its EFFECT was not, and nothing looked at the effect.
#
#   * `generate-headers.mjs` emitted the top-level Caddyfile form
#     (`header "Name" "value"`) into a file the Caddyfile imports INSIDE a
#     `header { … }` block, where the first token is the header NAME. Caddy
#     accepted it silently and the container served no CSP, no COOP, no COEP —
#     the entire posture of the client, absent, with a valid config.
#   * `respond /healthz` sat beside `try_files {path} /index.html`, which
#     REWRITES the path before the matcher runs, so the health endpoint answered
#     200 with the whole SPA. Any check that only looked at the status code —
#     including this repo's own container test — passed.
#
# So: unit tests over `securityHeaders()` cannot catch this class, and neither
# can reading the Caddyfile. Only a request to a running container can.
#
#   ./scripts/check-web-container-headers.sh            # build the image, then test
#   ./scripts/check-web-container-headers.sh --no-build # reuse an existing image
#
# `MYNE_WEB_IMAGE` overrides the image name (CI reuses the image it just built
# rather than building a second one).

set -uo pipefail
cd "$(dirname "$0")/.."

IMAGE="${MYNE_WEB_IMAGE:-myne-web-headers-test}"
PORT=18098
SYNC_ORIGIN="https://sync.example.org"

if [ "${1:-}" != "--no-build" ]; then
  echo "building the web container ..."
  docker build -q -f web/container/Dockerfile -t "$IMAGE" . >/dev/null || {
    echo "FAIL: image build failed"; exit 1; }
fi

CID=$(docker run -d --rm -p "$PORT:8080" \
  -e MYNE_SYNC_ORIGIN="$SYNC_ORIGIN" "$IMAGE") || {
  echo "FAIL: container did not start"; exit 1; }
trap 'docker rm -f "$CID" >/dev/null 2>&1 || true' EXIT

BASE="http://127.0.0.1:$PORT"

up=0
for _ in $(seq 1 60); do
  if curl -fsS -o /dev/null "$BASE/healthz" 2>/dev/null; then up=1; break; fi
  sleep 0.25
done
if [ "$up" -ne 1 ]; then
  echo "FAIL: the container never answered — nothing was tested."
  docker logs "$CID" 2>&1 | tail -20
  exit 1
fi

HEADERS=$(curl -sS -D- -o /dev/null "$BASE/")
fail=0

require() {
  local name="$1"
  if ! grep -qi "^${name}:" <<<"$HEADERS"; then
    echo "FAIL: ${name} is missing from the response"
    fail=1
  else
    echo "  ok  ${name}"
  fi
}

# The set that carries the client's security posture. Each is load-bearing:
# without COOP+COEP the page is not cross-origin isolated, without the CSP the
# bundle is not the only code that can run, without CORP its assets are readable
# cross-origin, without HSTS a first request can be downgraded.
require "Content-Security-Policy"
require "Cross-Origin-Opener-Policy"
require "Cross-Origin-Embedder-Policy"
require "Cross-Origin-Resource-Policy"
require "Strict-Transport-Security"
require "X-Content-Type-Options"
require "Referrer-Policy"
require "Permissions-Policy"

# The header whose NAME is `header` is the signature of the block/top-level form
# mix-up. Pinned by name so the specific regression cannot come back quietly.
if grep -qiE '^header:' <<<"$HEADERS"; then
  echo "FAIL: a header literally named 'header' is present — the generated"
  echo "      snippet is in the wrong Caddyfile form (top-level vs block)."
  fail=1
fi

# The CSP must name the origin the container was CONFIGURED with (task 50). A
# policy that omits it means a client that cannot sync at all, from a page that
# looks perfectly healthy.
CSP=$(grep -i '^content-security-policy:' <<<"$HEADERS")
if ! grep -q "$SYNC_ORIGIN" <<<"$CSP"; then
  echo "FAIL: the CSP does not name the configured sync origin ${SYNC_ORIGIN}"
  echo "      got: ${CSP}"
  fail=1
else
  echo "  ok  CSP connect-src names the configured sync origin"
fi

# ── operational endpoints (task 111) ────────────────────────────────────────
# Body, not status. The broken version returned 200 with the SPA in it.
HEALTH_BODY=$(curl -sS "$BASE/healthz")
if [ "$HEALTH_BODY" != "ok" ]; then
  echo "FAIL: /healthz did not answer with its static body — got $(printf '%s' "$HEALTH_BODY" | head -c 60)…"
  echo "      (a 200 carrying the SPA means the route lost to the try_files rewrite)"
  fail=1
else
  echo "  ok  /healthz answers its static body, not the SPA"
fi

# The deployment's runtime configuration (task 50). This is the document whose
# ABSENCE made a correctly-configured container serve a client that reported "no
# sync server configured" and sent not one request — the CSP named the origin,
# nothing handed it to the app. Asserted as a value, not just a 200, and cross-
# checked against the CSP so the two cannot drift.
CONFIG=$(curl -sS "$BASE/config.json")
CONFIG_ORIGIN=$(printf '%s' "$CONFIG" | sed -n 's/.*"sync_origin"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p')
if [ "$CONFIG_ORIGIN" != "$SYNC_ORIGIN" ]; then
  echo "FAIL: /config.json does not name the configured sync origin"
  echo "      expected ${SYNC_ORIGIN}, got: $(printf '%s' "$CONFIG" | head -c 120)"
  fail=1
else
  echo "  ok  /config.json hands the client the configured sync origin"
fi

VERSION=$(curl -sS -D- "$BASE/version.json")
if ! grep -qi '^cache-control:.*no-store' <<<"$VERSION"; then
  echo "FAIL: version.json is not served no-store — it would describe a cached build"
  fail=1
elif ! grep -q '"bundle_hash"' <<<"$VERSION"; then
  echo "FAIL: version.json carries no bundle_hash"
  fail=1
else
  echo "  ok  version.json served no-store with a bundle hash"
fi

# ── SPA fallback ────────────────────────────────────────────────────────────
# Routes are path segments, so without the fallback every deep link 404s and
# nothing in the client can detect it.
DEEP=$(curl -sS -o /dev/null -w '%{http_code}' "$BASE/editor/00000000-0000-7000-8000-000000000000")
if [ "$DEEP" != "200" ]; then
  echo "FAIL: a deep link answered ${DEEP} — the SPA fallback is missing"
  fail=1
else
  echo "  ok  SPA fallback serves the entry document on a deep link"
fi

if [ "$fail" -eq 0 ]; then
  echo "ok — the running container serves every required header, its health"
  echo "     endpoint answers with its own body, and deep links resolve"
fi
exit $fail
