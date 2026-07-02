#!/usr/bin/env bash
# ai-no-network-check.sh — enforce the local-ai runtime's no-egress invariant
# at the dependency level (local-ai epic, MYND-406, task 7a; SYNC-2 lens).
#
# The `local-inference` cargo feature must NOT introduce a networked / HTTP-
# client / socket-opening transitive crate. This is the runtime side of the
# guarantee: the *enforcing* CI gate (CSP, sidecar OS-sandbox, entitlement
# scan) is sibling 2 (ai-egress-guardrail); this check is the negative — the
# AI feature's dependency DELTA over the default build must contain none of a
# denylist of network crates.
#
# Method: compare the normal-dependency closure WITH the feature on vs off and
# fail if any crate the feature ADDS is on the denylist. The delta (not the
# whole lock) is checked deliberately — the workspace legitimately carries
# `rustls` for Phase-2 sync, which is NOT under the AI feature and must not
# false-positive. Also asserts the single-shared `Cargo.lock` (TB9 anchor) and
# no wildcard version specs.
#
# Exit non-zero on any violation. Intended for CI (woodpecker) + local runs.
set -euo pipefail

cd "$(dirname "$0")/.."          # src-tauri/
REPO_ROOT="$(cd .. && pwd)"

PKG="myne-desktop"
FEATURE="local-inference"

# Socket-opening / HTTP-client / TLS-transport crates. A crate appearing here
# in the FEATURE DELTA means the AI runtime gained a network capability.
DENYLIST=$(cat <<'EOF'
reqwest
hyper
hyper-util
ureq
isahc
surf
attohttpc
curl
curl-sys
http-client
actix-web
warp
axum
tide
rocket
tungstenite
tokio-tungstenite
async-tungstenite
websocket
ws
rustls
native-tls
openssl
openssl-sys
schannel
quinn
h2
h3
trust-dns-resolver
hickory-resolver
tokio-socks
socket2
sentry
sentry-core
EOF
)

echo "== AI no-network dependency check (feature: $FEATURE) =="

closure() {
  # crate names only, one per line, sorted-unique. `-e normal` excludes
  # build/dev deps; `--prefix none` drops the tree glyphs.
  cargo tree -p "$PKG" --no-default-features "$@" -e normal --prefix none 2>/dev/null \
    | sed -E 's/ v[0-9].*$//' \
    | sed -E 's/[[:space:]]+.*$//' \
    | grep -E '^[a-zA-Z0-9_-]+$' \
    | sort -u
}

off="$(closure)"
on="$(closure --features "$FEATURE")"

# Crates ADDED by turning the feature on.
delta="$(comm -13 <(printf '%s\n' "$off") <(printf '%s\n' "$on") || true)"

if [ -z "$delta" ]; then
  echo "  feature delta: (none — the AI feature adds zero dependencies)"
else
  echo "  feature delta adds:"
  printf '    %s\n' $delta
fi

violation=0
for crate in $delta; do
  if printf '%s\n' "$DENYLIST" | grep -qx "$crate"; then
    echo "  ✗ DENYLISTED networked crate added by '$FEATURE': $crate"
    violation=1
  fi
done
[ "$violation" -eq 0 ] && echo "  ✓ no networked crate in the AI feature delta"

echo "== Cargo.lock single-shared (TB9 anchor) =="
tracked_locks="$(git -C "$REPO_ROOT" ls-files '*Cargo.lock' | grep -v '/fuzz/' || true)"
lock_count="$(printf '%s\n' "$tracked_locks" | grep -c . || true)"
if [ "$lock_count" = "1" ] && [ "$tracked_locks" = "Cargo.lock" ]; then
  echo "  ✓ exactly one tracked Cargo.lock at the workspace root"
else
  echo "  ✗ expected one tracked Cargo.lock (root), found: $tracked_locks"
  violation=1
fi

echo "== no wildcard version specs =="
if git -C "$REPO_ROOT" grep -nE '^[a-zA-Z0-9_-]+[[:space:]]*=[[:space:]]*"\*"' -- '*Cargo.toml' >/dev/null 2>&1; then
  echo "  ✗ wildcard version spec found:"
  git -C "$REPO_ROOT" grep -nE '^[a-zA-Z0-9_-]+[[:space:]]*=[[:space:]]*"\*"' -- '*Cargo.toml'
  violation=1
else
  echo "  ✓ no wildcard version specs"
fi

if [ "$violation" -ne 0 ]; then
  echo "FAIL: AI no-network invariant violated"
  exit 1
fi
echo "PASS: AI runtime introduces no networked crate; lockfile + version discipline intact"
