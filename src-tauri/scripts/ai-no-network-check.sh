#!/usr/bin/env bash
# ai-no-network-check.sh — enforce the local-ai runtime's no-egress invariant
# at the dependency level (local-ai epic, MYND-406/407, task 7a; SYNC-2 lens).
#
# As of `decisions.md` 2026-07-02 the on-device AI ships in the DEFAULT build
# (the `local-inference` feature moved into `default`), so no-egress is now an
# ABSOLUTE property of the single shipped dependency tree, not a feature delta:
# the shipped binary must contain NO networked / HTTP-client / model-download /
# socket-opening / telemetry crate — with one narrow, documented exception, the
# Phase-2 sync TLS stack (rustls + pki-types + webpki), which is a transport
# primitive gated by CSP + Tauri capabilities, is NOT an AI dependency, and is
# NOT an HTTP client. (Measured 2026-07-02: the only denylist-family crates in
# the shipped tree are those three; the AI delta adds zero networked crate.)
#
# Two checks run:
#   1. ABSOLUTE — scan the shipped (default, AI-on) closure; fail on any
#      denylisted crate that is NOT in the SYNC_TLS_ALLOW allowlist. If sync
#      ever swaps its TLS crate, this fails on purpose and forces a conscious
#      TB9 review rather than silently widening the network surface.
#   2. AI DELTA (belt-and-suspenders) — diff the shipped tree against the
#      AI-free `--no-default-features` baseline; the crates the AI path adds
#      must contain none of the denylist. Proves "enabling AI adds no egress".
#
# Also asserts the single-shared `Cargo.lock` (TB9 anchor) and no wildcard
# version specs. `cargo tree` only RESOLVES the graph (no compile), so this is
# a cheap gate. Exit non-zero on any violation. Intended for CI + local runs.
set -euo pipefail

cd "$(dirname "$0")/.."          # src-tauri/
REPO_ROOT="$(cd .. && pwd)"

PKG="myne-desktop"
FEATURE="local-inference"

# Narrow allowlist: networked crates that are legitimately in the shipped tree
# and are NOT AI dependencies — the Phase-2 sync TLS transport stack. These are
# transport primitives (no HTTP client, no model download), reachable only
# through the CSP `connect-src` allowlist + Tauri sync capabilities. Keep this
# list minimal: a new entry is a deliberate TB9 decision.
SYNC_TLS_ALLOW=$(cat <<'EOF'
rustls
rustls-pki-types
rustls-webpki
EOF
)

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

echo "== AI no-network dependency check (shipped tree; AI is default-on) =="

closure() {
  # crate names only, one per line, sorted-unique. `-e normal` excludes
  # build/dev deps; `--prefix none` drops the tree glyphs.
  cargo tree -p "$PKG" --no-default-features "$@" -e normal --prefix none 2>/dev/null \
    | sed -E 's/ v[0-9].*$//' \
    | sed -E 's/[[:space:]]+.*$//' \
    | grep -E '^[a-zA-Z0-9_-]+$' \
    | sort -u
}

off="$(closure)"                           # AI-free baseline (--no-default-features)
on="$(closure --features "$FEATURE")"      # shipped tree (default == local-inference on)

violation=0

# ── Check 1: ABSOLUTE — no networked crate in the shipped tree except the
#    documented sync-TLS allowlist. ───────────────────────────────────────
echo "== absolute scan of the shipped tree =="
found_net=""
while IFS= read -r crate; do
  [ -z "$crate" ] && continue
  if printf '%s\n' "$DENYLIST" | grep -qx "$crate"; then
    if printf '%s\n' "$SYNC_TLS_ALLOW" | grep -qx "$crate"; then
      echo "  · allowed (sync TLS, not AI): $crate"
    else
      echo "  ✗ DENYLISTED networked crate present in the shipped tree: $crate"
      violation=1
    fi
    found_net="$found_net $crate"
  fi
done <<< "$on"
[ -z "$found_net" ] && echo "  (no denylist-family crate present at all)"
[ "$violation" -eq 0 ] && echo "  ✓ shipped tree carries no networked crate outside the sync-TLS allowlist"

# ── Check 2: AI DELTA — enabling the AI path over the AI-free baseline adds
#    no networked crate (belt-and-suspenders). ─────────────────────────────
echo "== AI delta over the --no-default-features baseline =="
delta="$(comm -13 <(printf '%s\n' "$off") <(printf '%s\n' "$on") || true)"
if [ -z "$delta" ]; then
  echo "  (delta empty — unexpected: AI should add tensor/tokenizer crates)"
fi
delta_net=0
for crate in $delta; do
  if printf '%s\n' "$DENYLIST" | grep -qx "$crate"; then
    echo "  ✗ DENYLISTED networked crate added by '$FEATURE': $crate"
    violation=1
    delta_net=1
  fi
done
[ "$delta_net" -eq 0 ] && echo "  ✓ the AI path adds zero networked crate"

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
