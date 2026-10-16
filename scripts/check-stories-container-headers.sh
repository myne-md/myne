#!/usr/bin/env bash
# Assert the design-system catalogue's container actually SERVES its security
# headers and the public variant, and that its operational endpoint is not the
# page (myne-md/myne#832's catalogue, public since the design.myne.md work).
#
# ── Why a running container, and not a read of the Caddyfile ────────────────
#
# `web/container/` shipped two failures of the same kind and every other check
# was green for both: the configuration was right, its EFFECT was not, and
# nothing looked at the effect.
#
#   * a generated snippet in the wrong Caddyfile form (`header "Name" "value"` at
#     top level inside an `header { … }` block, where the first token is the
#     header NAME) meant the container served NO CSP, NO COOP, NO CORP — the
#     entire posture, absent, from a valid config;
#   * `respond /healthz` beside a `try_files` fallback answered 200 with the whole
#     SPA, because `try_files` rewrites the unmatched path before the matcher
#     runs. Every naive health check passes that.
#
# This container has no generated snippet, so that first bug cannot occur here.
# The second one CAN — it is a property of Caddy's directive matching, not of
# generation — and it is asserted by BODY below rather than by status.
#
#   ./scripts/check-stories-container-headers.sh             # build, then test
#   ./scripts/check-stories-container-headers.sh --no-build  # reuse an image
#
# `MYNE_STORIES_IMAGE` overrides the image name (CI reuses the image it just
# built rather than building a second one).

set -uo pipefail
cd "$(dirname "$0")/.."

IMAGE="${MYNE_STORIES_IMAGE:-myne-stories-headers-test}"
# 18099, one past `check-web-container-headers.sh`'s 18098, so both can run.
PORT=18099
# In CI this runs INSIDE the container-check step container, whose 127.0.0.1 is
# its own netns — a published host port is unreachable from it. When the network
# name is set, attach the probe to that same docker network and reach the
# container by name instead. Unset (local dev) keeps the published-port path.
NET="${MYNE_STORIES_TEST_NETWORK:-}"

if [ "${1:-}" != "--no-build" ]; then
  echo "building the catalogue container ..."
  docker build -q -f stories/container/Dockerfile -t "$IMAGE" . >/dev/null || {
    echo "FAIL: image build failed"; exit 1; }
fi

if [ -n "$NET" ]; then
  CNAME="myne-stories-headers-$$"
  CID=$(docker run -d --rm --network "$NET" --name "$CNAME" "$IMAGE") || {
    echo "FAIL: container did not start"; exit 1; }
  BASE="http://$CNAME:8080"
else
  CID=$(docker run -d --rm -p "$PORT:8080" "$IMAGE") || {
    echo "FAIL: container did not start"; exit 1; }
  BASE="http://127.0.0.1:$PORT"
fi
trap 'docker rm -f "$CID" >/dev/null 2>&1 || true' EXIT

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

# The set that carries this origin's posture. HSTS is deliberately NOT here and
# is set at the TLS edge instead (`myne-ops/deploy/caddy/design.myne.md.caddy`):
# HSTS is a property of the HTTPS origin, and this container terminates no TLS.
require "Content-Security-Policy"
require "Cross-Origin-Opener-Policy"
require "Cross-Origin-Resource-Policy"
require "X-Content-Type-Options"
require "X-Frame-Options"
require "Referrer-Policy"
require "Permissions-Policy"

CSP=$(grep -i '^content-security-policy:' <<<"$HEADERS")

# `connect-src 'none'` is what separates this policy from the web client's, and
# it is only true while nothing is fetched at runtime — the story host is
# in-page and every asset is same-origin. A regression that introduces a fetch
# would otherwise fail silently in a browser console nobody reads.
if ! grep -q "connect-src 'none'" <<<"$CSP"; then
  echo "FAIL: the CSP does not say connect-src 'none'"
  echo "      got: ${CSP}"
  fail=1
else
  echo "  ok  CSP connect-src is 'none' (the catalogue fetches nothing)"
fi

# `'unsafe-inline'` for STYLE is required, because Myne's components style
# themselves through inline `style={{…}}` props. Asserted so that it reads as a
# decision rather than an oversight, and so that removing it is a visible change
# rather than a silent one.
if ! grep -qE "style-src [^;]*'unsafe-inline'" <<<"$CSP"; then
  echo "FAIL: the CSP does not allow inline styles, so the catalogue renders unstyled"
  echo "      got: ${CSP}"
  fail=1
else
  echo "  ok  CSP style-src allows 'unsafe-inline' (Myne's inline style props)"
fi

# The two relaxations that must never appear. `'unsafe-eval'` would let injected
# text execute; a wildcard `connect-src` would undo the line above.
if grep -qE "'unsafe-eval'|connect-src[^;]*\*" <<<"$CSP"; then
  echo "FAIL: the CSP carries 'unsafe-eval' or a wildcard connect-src"
  echo "      got: ${CSP}"
  fail=1
fi

# ── the operational endpoint: BODY, not status ──────────────────────────────
# The broken shape returns 200 with the catalogue in it, which every status-only
# check passes.
HEALTH_BODY=$(curl -sS "$BASE/healthz")
if [ "$HEALTH_BODY" != "ok" ]; then
  echo "FAIL: /healthz did not answer with its static body — got $(printf '%s' "$HEALTH_BODY" | head -c 60)…"
  echo "      (a 200 carrying the catalogue means the route lost to a path rewrite)"
  fail=1
else
  echo "  ok  /healthz answers its own static body"
fi

# ── cache policy, which is how a reader gets a rebuilt catalogue ────────────
ENTRY_HEADERS=$(curl -sS -D- -o /dev/null "$BASE/")
if ! grep -qi '^cache-control:.*no-cache' <<<"$ENTRY_HEADERS"; then
  echo "FAIL: the entry document is cacheable, so a reader can be pinned to an old build"
  fail=1
else
  echo "  ok  the entry document is not cached"
fi

# An unknown path must NOT be answered with the catalogue: there is no server-side
# route here (every route is a URL fragment), so a fallback would answer a missing
# asset with HTML, which reads like a broken build rather than a 404.
MISSING=$(curl -sS -o /dev/null -w '%{http_code}' "$BASE/no/such/path")
if [ "$MISSING" != "404" ]; then
  echo "FAIL: an unknown path answered ${MISSING}, not 404 — an SPA fallback was added"
  fail=1
else
  echo "  ok  an unknown path is a 404, not the page"
fi

# ── what is actually SERVED is the public variant ───────────────────────────
# The strongest assertion here, and the one that ties the deployment to the
# property: the entry bundle this container hands out carries no link into a
# private repository. `check-stories-public-bundle.mjs` makes the same claim
# about `stories/dist-public`; this one makes it about the running image, so a
# container accidentally built from the DEFAULT variant fails here.
ENTRY_JS=$(curl -sS "$BASE/" | grep -oE '/assets/[^"]+\.js' | head -1)
if [ -z "$ENTRY_JS" ]; then
  echo "FAIL: could not find the entry script in the served index — nothing was checked"
  fail=1
else
  SERVED_JS=$(curl -sS "$BASE$ENTRY_JS")
  if grep -q "github.com/myne-md" <<<"$SERVED_JS"; then
    echo "FAIL: the served bundle ($ENTRY_JS) links into a private repository"
    echo "      the container is serving the DEFAULT variant, not the public one"
    fail=1
  else
    echo "  ok  the served bundle carries no private-repository link"
  fi
fi

if [ "$fail" -ne 0 ]; then
  echo
  echo "FAIL: the container's served effects do not match its configuration."
  exit 1
fi

echo
echo "ok: headers, health endpoint and served bundle all verified on the running image"
