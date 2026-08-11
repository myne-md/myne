#!/usr/bin/env bash
# ai-no-network-check.sh — the AI egress gate (local-ai epic, MYND-406/407,
# task 7a; SYNC-2 lens). **Read what each check proves before citing it.**
#
# The file name is HISTORICAL and is now a misnomer, kept deliberately: "no
# network" was never what checks 1–2 proved (`decisions.md` 2026-08-04), and
# after `decisions.md` 2026-08-09 it is not the product's claim either. Renaming
# it would touch `.woodpecker.yml`, the root CLAUDE.md guard table and every doc
# that cites it, for no safety gain — so the name stays and the header carries
# the truth.
#
# THE PROPERTY THE PRODUCT NOW CLAIMS, as of 2026-08-09: *no byte leaves the
# device unless the user has named a provider.* A user may name a local model
# runtime (loopback, TB12) or a remote provider (off-device, TB13); both are
# opt-in and default off, and unset means the path is unreachable rather than
# disabled. That property is NOT expressible as a crate denylist, which is why
# check 4 exists.
#
# As of `decisions.md` 2026-07-02 the on-device AI ships in the DEFAULT build
# (the `local-inference` feature moved into `default`), so no-egress is now an
# ABSOLUTE property of the single shipped dependency tree, not a feature delta:
# the shipped binary must contain NO networked / HTTP-client / model-download /
# socket-opening / telemetry crate — with one narrow, documented exception, the
# TLS stack (rustls + pki-types + webpki), which is a set of transport
# primitives and is NOT an HTTP client.
#
# THE "NOT AN AI DEPENDENCY" CLAUSE THIS SENTENCE USED TO CARRY IS NOW FALSE,
# and it is corrected here rather than deleted (myne#415 task 11). Until
# 2026-08-09 that stack was reachable from exactly one path: the Phase-2 sync
# transport, gated by CSP `connect-src` + Tauri sync capabilities. It is now
# reachable from TWO:
#
#   (1) sync — unchanged, and unchanged in its gating;
#   (2) the AI REMOTE PROVIDER arm
#       (`src/plugins/local_inference/provider_transport.rs`), gated by a
#       user-named provider PLUS a recorded per-provider consent PLUS a stored
#       key PLUS `ai_enabled` PLUS `developer_mode` — five preconditions
#       re-read host-side at request time, every one of which defaults to off
#       (`provider_gate.rs`). With none named, the arm is UNREACHABLE, which
#       an accept-counting probe with a control arm proves rather than asserts
#       (`provider_gate.rs::default_off_proof`).
#
# So the honest reading of the allowlist is no longer "these crates have
# nothing to do with AI". It is: these crates are transport primitives, they
# originate nothing on their own, and every path that drives them is gated —
# differently, and each gate is named above. What the allowlist has NEVER
# proved, and still does not, is that the process has no network path; see
# check 1.
#
# `webpki-roots` (the AI arm's trust anchor, task 4) is deliberately NOT on
# this list and needs no entry: it is a `const` bundle of certificate DATA. It
# opens nothing, speaks no protocol, and is not denylist-family. Adding it
# would dilute a list whose value is that every line is a decision.
#
# (Measured 2026-07-02: the only denylist-family crates in the shipped tree
# are those three; the AI delta adds zero networked crate. Re-measured
# 2026-08-09 with the remote arm in the tree: still those three.)
#
# FOUR checks run, and checks 1-2 prove LESS than their names suggest:
#   1. ABSOLUTE — scan the shipped (default, AI-on) closure; fail on any
#      denylisted crate that is NOT in the SYNC_TLS_ALLOW allowlist. If sync
#      ever swaps its TLS crate, this fails on purpose and forces a conscious
#      TB9 review rather than silently widening the network surface.
#      PROVES: no third-party crate in the closure originates outbound
#      requests. DOES NOT PROVE: that this binary has no network path. It is
#      destination-blind and matches crate NAMES; `std::net` is reachable from
#      any code in a Rust binary regardless of its dependency graph, and the
#      first-party sync codec already uses it. (`decisions.md` 2026-08-04.)
#   2. AI DELTA (belt-and-suspenders) — diff the shipped tree against the
#      `--no-default-features` baseline; the crates the AI path adds must
#      contain none of the denylist. PROVES: enabling AI pulls in no networked
#      crate. DOES NOT PROVE: that the AI path opens no socket — same reason.
#      Both remain worth running: they are what rejects `reqwest`/`ureq`/
#      `hyper`, which stay forbidden (`dependency-policy.md`).
#   3. OCR UNGATED (MYND-441) — assert the OCR runtime is present in BOTH
#      trees. OCR is search correctness, not an AI feature, so it deliberately
#      ships in the `--no-default-features` build too. This check exists so a
#      later refactor cannot quietly move it behind `local-inference` and
#      change what the audit build actually does. UNRELATED to the provider
#      work and deliberately untouched by it.
#   4. AI-PATH EGRESS CALL SITES (2026-08-09) — the source-level ratchet that
#      carries the property checks 1-2 cannot express. Full rationale sits at
#      its own section below, next to the code. It lands with an EMPTY
#      allowlist, before any provider code exists.
#
# NOTE on the `--no-default-features` build (MYND-441): it is no longer
# "ML-free". It drops the generation model, the embedding model and ASR, and it
# still has no network path — but it DOES contain the OCR neural network, by
# design. `src-tauri/Cargo.toml`'s build-configuration comment carries the
# corrected claim; do not reintroduce "zero ML symbols" language here.
#
# The OCR crates need no denylist entry of their own: they live in `myne-core`,
# which is in the shipped tree, so check 1 already scans them. `rten` has no
# network surface and the loader only ever reads the bundled resource dir.
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
# — the shared TLS transport stack. These are transport primitives (no HTTP
# client, no model download). They are reachable from TWO paths, not one: the
# Phase-2 sync transport (CSP `connect-src` + Tauri sync capabilities) and, as
# of myne#415, the AI remote-provider arm (five host-side preconditions, all
# defaulting to off). The header above spells both out; the short version is
# that "not an AI dependency" stopped being true on 2026-08-09 and the list did
# not grow to accommodate that — the RATIONALE changed, which is the honest
# edit. Keep this list minimal: a new entry is a deliberate TB9 decision.
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

# ── Check 3: OCR UNGATED — the OCR runtime must be in BOTH trees (MYND-441).
#    OCR is search correctness, not an AI feature: gating it would make the
#    audit build search differently from the shipped product. ───────────────
echo "== OCR is ungated (present in the --no-default-features tree too) =="
OCR_CRATES="rten"
for crate in $OCR_CRATES; do
  in_on=0; in_off=0
  printf '%s\n' "$on"  | grep -qx "$crate" && in_on=1
  printf '%s\n' "$off" | grep -qx "$crate" && in_off=1
  if [ "$in_on" -eq 1 ] && [ "$in_off" -eq 1 ]; then
    echo "  ✓ $crate present in both trees (OCR ships ungated)"
  elif [ "$in_on" -eq 1 ] && [ "$in_off" -eq 0 ]; then
    echo "  ✗ $crate is in the default tree but NOT in --no-default-features:"
    echo "    OCR has been feature-gated. That silently changes what the AI-free"
    echo "    audit build does (search stops reaching inside images) and reverses"
    echo "    a deliberate MYND-441 decision. Ungate it, or land a decisions.md"
    echo "    entry that supersedes it."
    violation=1
  else
    echo "  ✗ $crate missing from the shipped tree — OCR would not build"
    violation=1
  fi
done

# ── Check 4: AI-PATH EGRESS CALL SITES — the ratchet that carries the property
#    checks 1–2 cannot express (`decisions.md` 2026-08-09). ─────────────────
#
#    Why this exists. Checks 1–2 are destination-blind: they match crate NAMES
#    over `cargo tree`. A socket opened with `std::net` — which is exactly what
#    the first-party sync codec already does, and what an AI provider arm would
#    reuse — adds no crate and passes them both. The blind spot is total for
#    the AI path: `core/src/plugins/sync/no_bypass.rs`'s socket ratchet scans
#    only `core/src/plugins/sync/`, the crate denylist sees no new crate, and
#    the CSP check binds the WebView rather than the host. Three gates, one
#    hole, and it is precisely where the provider work lands.
#
#    What it asserts. Every source location under the scanned roots that opens
#    a socket must be recorded in AI_EGRESS_SITES with an exact count and a
#    written reason — and the comparison runs BOTH ways, so an unrecorded site
#    and a recorded-but-removed site are equally loud. It is the shape
#    `no_bypass.rs`'s DIRECT_CONNECT_SITES already uses, because that one has
#    caught a real reintroduced fallback.
#
#    It lands EMPTY, deliberately, before any provider code exists. That is the
#    value: #189 and #415 each have to add their own line and argue for it in
#    review, rather than arriving inside a change that is about something else.
#
#    WHO OWNS WHAT, so no reader concludes from one file alone that a tree is
#    unwatched. THIS check owns the AI provider path,
#    `src-tauri/src/plugins/local_inference/`. The socket ratchet in
#    `core/src/plugins/sync/no_bypass.rs` owns two roots on the other side of the
#    crate boundary: `core/src/plugins/sync/` and, since ai-ollama-local task 1,
#    `core/src/http/` — the shared HTTP codec, which must stay socket-free
#    because every transport reaches it, including callers that never consult
#    the Tor routing gate. That module stays in-crate on purpose: it is
#    test-only, resolves from `CARGO_MANIFEST_DIR`, and also compiles for mobile
#    and wasm, so reaching across to a sibling crate from it would be fragile in
#    three build configurations to watch a tree that already has an owner here.
#
#    Why it lives in this file rather than a sibling script. Two reasons, and
#    the second is the load-bearing one. (a) Contributors look for "the AI
#    egress gate" in one place. (b) This script already runs in CI as the
#    `ai-no-network` step; a new script needs a new step, and a CI step that
#    has never run green is a known way to ship a gate that does not gate.
#    Note the FILE NAME is now historical — "no-network" was never what checks
#    1–2 proved (`decisions.md` 2026-08-04) and is not what check 4 asserts.
#    It is kept because renaming it would touch `.woodpecker.yml`, the root
#    CLAUDE.md guard table and every doc that cites it, for no safety gain.
echo "== AI-path egress call sites (ratchet) =="

AI_EGRESS_ROOTS="src-tauri/src/plugins/local_inference"

# One record per line: <repo-relative-path>|<exact count>|<reason>
#
# Landed empty by #414, on purpose, before any provider code existed. The first
# entry below arrived the way it was supposed to: #189 task 5 wrote a socket,
# this guard went red, and the reason had to be written before it could go green
# again. A guard added after the thing it watches cannot do that.
AI_EGRESS_SITES=$(cat <<'EOF'
src-tauri/src/plugins/local_inference/engine_ollama.rs|8|The local model-runtime arm (#189). Loopback-only BY CONSTRUCTION rather than by a check written at the socket: the host and port it connects to can only have come from `endpoint_config::validate`, which resolves through myne-core's single `is_loopback` predicate — a literal match against `127.0.0.1` / `localhost` / `::1`, never a resolved address, which is what closes the DNS-rebind hole a free-form URL field would open. There is therefore no source IP to expose and nothing for Tor mode to route around, the same argument `no_bypass.rs`'s `http_transport.rs` entry makes about the sync loopback transport. The count is 8, not 1. Production contributes 2 — `to_socket_addrs` (needed because `connect_timeout` takes a resolved address) and `connect_timeout` itself. The other 6 are `TcpListener::bind` in the test module's fake servers, one per timing scenario. The count moved 3 -> 8 when the deadlines landed, and this ratchet is what noticed; an exact count rather than a boolean is the whole reason it could. This guard does not strip `#[cfg(test)]` — it is a shell script, not a Rust parser — and that is left deliberately strict: a socket parked in a test-only block that production can still reach would otherwise be invisible here.
src-tauri/src/plugins/local_inference/provider_gate.rs|2|TEST FIXTURES ONLY — the gate itself opens nothing; it returns a decision. The two matches are a `TcpListener::bind` and a `TcpStream::connect` inside `default_off_proof`, the accept-counting probe for the invariant this whole slice rests on: with no provider named, SEVEN distinct unconfigured states each open ZERO sockets. The probe must be able to open one — that is the CONTROL ARM, and without it the seven zeros would be compatible with a probe that could never see anything (`rustls_transport.rs`: "the probe must be able to see a direct connection, or the zero above proves nothing"). Recording the fixture is the price of a probe that measures rather than asserts.
src-tauri/src/plugins/local_inference/state.rs|5|TEST FIXTURES ONLY — the seam itself opens nothing. `state.rs` is the SYNC-14/SYNC-16 bar, and its two matches are a `TcpListener::bind` and a `TcpStream::connect` inside `remote_bar_proof`: a counting listener plus a deliberately-connecting fake engine, which together prove that an ambient request against a Remote-class backend reaches the network ZERO times. The probe has to be able to open a socket, or its zero would prove nothing — that is the point of the control arm, and it is why this file appears here at all. This guard does not strip `#[cfg(test)]`, deliberately; recording the fixture is the cost of a probe that can actually see a connection. Moved 2 -> 5 in task 18, when the selection became prefs-driven and a second probe was needed: `selection_proof` registers a Remote-class arm that CONNECTS when reached and drives the wired seam (`engine_for` / `embedding_engine`) across eight unconfigured states, asserting zero accepts, then one in the control arm. Its three matches are that module's `TcpListener::bind` and two `TcpStream::connect` (one in the fake engine's `infer`, one in its `embed` — the embed fixture connects on purpose, because a fake that refused would make "embedding opened no socket" true of the fake rather than of the seam). Production in this file remains ZERO: the bar and the selection both return an `Arc<dyn Engine>` and neither touches a socket.
src-tauri/src/plugins/local_inference/provider_transport.rs|8|The REMOTE provider arm (myne#415). TWO callers now reach it, both user-initiated and both through the same five-precondition gate: a completion (`RemoteEngine::chat_streaming`) and the model listing the chooser populates from (`commands::list_provider_models`, task 17 / SYNC-24). The listing fetches model NAMES and no weights, so it stays on the permitted side of the pull-or-download line `decisions.md` 2026-08-09 draws; it is recorded here rather than waved past because an authenticated listing call still tells the provider this account exists. The count below does not move for it — it opens no socket of its own, it borrows this module's one `connect`. This is the entry the ratchet was landed empty to force an argument for, and the argument is not "loopback, so it is fine" — this socket leaves the device, carrying note plaintext, which is the whole of what `decisions.md` 2026-08-09 superseded the old no-egress claim to permit. What bounds it is not the check at the socket but the SHAPE of the type: `TcpStream::connect_timeout` is reachable only from `ProviderTransport::connect`, which takes a `ProviderHost` — a struct with a PRIVATE `&'static str` field, minted only by `ProviderHost::resolve` against the compiled-in `PROVIDER_HOSTS` table. There is no constructor taking caller-supplied text, so a tampered `vault.prefs`, a compromised WebView, or a careless future caller can select AMONG the hosts this build ships and cannot invent one. TLS verification is the stock rustls chain+hostname check against the static `webpki-roots` bundle, with no `.dangerous()` and no custom verifier anywhere in the module — asserted by `there_is_no_verification_bypass_in_this_module`, which reads production lines with comments stripped, because this file's own doc comment says the words. The count is 8, not 1. Production contributes 2 — `to_socket_addrs` (needed because `connect_timeout` takes a resolved address) and `connect_timeout` itself. The other 6 are test fixtures: 3 `TcpListener::bind` and 3 `TcpStream::connect` across the untrusted-certificate arm, the never-responding-provider deadline test and the pre-first-byte cancel test. It moved 4 -> 8 when task 6's deadline and cancel landed, and this ratchet is what noticed — an exact count rather than a boolean is the whole reason it could. As with the loopback entry, `#[cfg(test)]` is NOT stripped, deliberately.
EOF
)

# Anything that opens or accepts a socket. Deliberately broader than
# `TcpStream::connect`: a provider arm reaching the shared codec, a listener,
# or a UDP socket are all egress surfaces, and none of them adds a crate.
EGRESS_PATTERNS='TcpStream::connect|TcpListener::bind|UdpSocket::bind|connect_timeout|to_socket_addrs|SocketAddr::from'

egress_violation=0
scanned_any=0
declare -a found_files=()

for root in $AI_EGRESS_ROOTS; do
  [ -d "$REPO_ROOT/$root" ] || continue
  scanned_any=1
  while IFS= read -r f; do
    rel="${f#"$REPO_ROOT"/}"
    count="$(grep -cE "$EGRESS_PATTERNS" "$f" || true)"
    [ "$count" -eq 0 ] && continue
    found_files+=("$rel")
    recorded="$(printf '%s\n' "$AI_EGRESS_SITES" | grep -E "^${rel}\|" || true)"
    if [ -z "$recorded" ]; then
      echo "  ✗ UNRECORDED egress call site: $rel ($count match(es))"
      echo "    A socket on the AI path must be recorded in AI_EGRESS_SITES with"
      echo "    an exact count and a written reason. See the header of this file"
      echo "    and \`decisions.md\` 2026-08-09."
      egress_violation=1
    else
      want="$(printf '%s\n' "$recorded" | cut -d'|' -f2 | tr -d '[:space:]')"
      if [ "$count" != "$want" ]; then
        echo "  ✗ COUNT DRIFT at $rel — recorded $want, found $count"
        egress_violation=1
      fi
    fi
  done < <(find "$REPO_ROOT/$root" -name '*.rs' -type f | sort)
done

if [ "$scanned_any" -eq 0 ]; then
  echo "  ✗ none of the scanned roots exist — the ratchet is scanning nothing."
  echo "    AI_EGRESS_ROOTS is stale; a guard over an empty set is not a guard."
  egress_violation=1
fi

# The other direction: a recorded site that no longer has a socket is a stale
# permission, and a stale permission is how the next one gets waved through.
while IFS= read -r line; do
  [ -z "$line" ] && continue
  case "$line" in \#*) continue ;; esac
  rel="$(printf '%s' "$line" | cut -d'|' -f1)"
  still_there=0
  for f in "${found_files[@]:-}"; do [ "$f" = "$rel" ] && still_there=1; done
  if [ "$still_there" -eq 0 ]; then
    echo "  ✗ STALE record: $rel is in AI_EGRESS_SITES but opens no socket."
    echo "    Remove the record in the same change that removed the call."
    egress_violation=1
  fi
done <<< "$AI_EGRESS_SITES"

if [ "$egress_violation" -eq 0 ]; then
  if [ -z "$AI_EGRESS_SITES" ]; then
    echo "  ✓ no egress call site on the AI path (allowlist empty, as landed)"
  else
    echo "  ✓ every AI-path egress call site is recorded with a matching count"
  fi
else
  violation=1
fi

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
  echo "FAIL: AI egress invariant violated"
  exit 1
fi
echo "PASS: no networked crate beyond the sync-TLS allowlist; no unrecorded egress call site on the AI path; lockfile + version discipline intact"
