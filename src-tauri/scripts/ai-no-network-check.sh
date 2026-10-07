#!/usr/bin/env bash
# ai-no-network-check.sh — the AI egress gate (local-ai epic, MYND-406/407,
# task 7a; SYNC-2 lens). **Read what each check proves before citing it.**
#
# The file name is HISTORICAL and is now a misnomer, kept deliberately: "no
# network" was never what checks 1–2 proved (`decisions.md` 2026-08-04), and
# after `decisions.md` 2026-08-09 it is not the product's claim either. Renaming
# it would touch `.woodpecker/main.yml`, the root AGENTS.md guard table and every doc
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
#       (`core/src/inference/provider_transport.rs`, moved out of the desktop
#       plugin by myne-md/myne#456), gated by a
#       user-named provider PLUS a recorded per-provider consent PLUS a stored
#       key PLUS `ai_enabled`, FOUR preconditions re-read host-side at request
#       time, every one of which defaults to off (`provider_gate.rs`). It was
#       five until myne-md/myne#456 dropped `developer_mode`: per-provider
#       consent names the recipient and is compared for equality, which is a
#       sharper marker of leaving the vouched path than a global switch that
#       also governs CLI access and the Vim keymap. `ai_enabled` is now the only
#       device-local switch here, and the compensating control landed in the
#       same change, `ai_provider_consent` became `DeviceLocal`, so a synced
#       key cannot make a device a sending device without somebody agreeing on
#       that device. With none named, the arm is UNREACHABLE, which an
#       accept-counting probe with a control arm proves rather than asserts
#       (`provider_gate.rs::default_off_proof`).
#
# So the honest reading of the allowlist is no longer "these crates have
# nothing to do with AI". It is: these crates are transport primitives, they
# originate nothing on their own, and every path that drives them is gated —
# differently, and each gate is named above. What the allowlist has NEVER
# proved, and still does not, is that the process has no network path; see
# check 1.
#
# `webpki-roots` (shared by sync TLS and the AI provider arm) is deliberately
# NOT on this list and needs no entry: it is a `const` bundle of certificate DATA. It
# opens nothing, speaks no protocol, and is not denylist-family. Adding it
# would dilute a list whose value is that every line is a decision.
#
# (Measured 2026-07-02: the only denylist-family crates in the shipped tree
# are those three; the AI delta adds zero networked crate. Re-measured
# 2026-08-09 with the remote arm in the tree: still those three.)
#
# FIVE checks run, and checks 1-2 prove LESS than their names suggest:
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
#   5. THE REMOTE ARM IS STILL GATED (myne-md/myne#456), the arm moved into
#      `myne-core`, which compiles unconditionally, so what keeps it out of the
#      auditable build is now a feature CHAIN rather than the file's location.
#      Asserts both directions of that chain. Full rationale next to the code.
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
# of myne#415, the AI remote-provider arm (four host-side preconditions since
# myne-md/myne#456, all defaulting to off). The header above spells both out; the short version is
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

# ── Check 5: THE REMOTE ARM IS STILL GATED (myne-md/myne#456). ────────────
#    The remote-provider arm moved out of this crate and into `myne-core`,
#    which (unlike the desktop plugin it left) compiles unconditionally. The
#    property that survived that move is a chain: the desktop `local-inference`
#    feature turns on `myne-core/remote-ai`, and nothing else does. Break any
#    link (enable `remote-ai` at the dependency line, drop the `#[cfg]` on the
#    module, make the feature default-on in `myne-core`) and the auditable
#    `--no-default-features` build silently starts carrying provider-transport
#    code for the first time.
#
#    WHAT IT MEASURES, and what it no longer uses. This check used to read the
#    dependency closure for `webpki-roots`, which was a tight tell BECAUSE it
#    was optional and reached only through `remote-ai`. Native sync needs the
#    same crate with AI off (its bundled Mozilla roots, myne#786), so presence
#    stopped being evidence and the tell had to go. Dependency presence was
#    never the property anyway; the property is which FEATURES are on.
#
#    So this now reads the resolved feature graph, in BOTH directions, and both
#    halves are reported by name because either one alone is satisfied by the
#    wrong tree:
#      - `remote-ai` ABSENT from the audit build, and
#      - `remote-ai` PRESENT in the shipped build (its absence there means the
#        arm is not being built at all, which this reports as a failure rather
#        than passing on a tree it could not measure).
#    Plus the source-level `#[cfg]` on `pub mod inference;`, which no graph can
#    see: a feature turned on with the module gate dropped compiles the arm in
#    every configuration, and the graph above would call that correct.
#
#    WHAT IT DOES NOT PROVE. `cargo tree` resolves; it does not compile. That
#    the audit build still COMPILES with these edges is CI's
#    `cargo clippy -p myne-desktop --all-targets --no-default-features -D warnings`
#    in the same `ai-no-network` step, and the two together are what back the
#    claim. Neither alone would: a green resolve with a dropped module gate
#    compiles provider-transport code into the audit build, and a green compile
#    says nothing about which features were requested.
echo "== the remote-AI arm is gated out of the --no-default-features build =="

# The enabled-feature list cargo resolved for `myne-core`, from the DESKTOP
# package, the audit target, under one feature set. One line per package, so
# the first `myne-core` line is the whole answer.
core_features() {
  cargo tree -p "$PKG" "$@" -e features --prefix none --format '{p} {f}' 2>/dev/null \
    | grep -E '^myne-core v' \
    | head -1 \
    | sed -E 's/^.*\) //'   # drop `myne-core v0.1.0 (/path/to/core) `, keep the feature list
}

audit_features="$(core_features --no-default-features)"
shipped_features="$(core_features --no-default-features --features "$FEATURE")"

if [ -z "$audit_features" ]; then
  echo "  ✗ could not read myne-core's resolved features for the audit build."
  echo "    A check that skips on a missing input reads as a pass; treat this"
  echo "    as a failure and re-run with the workspace lockfile present."
  violation=1
else
  case ",$audit_features," in
    *,remote-ai,*)
      echo "  ✗ 'remote-ai' is ON in the --no-default-features closure:"
      echo "    myne-core features = $audit_features"
      echo "    The remote-provider arm now compiles into the AI-free auditable"
      echo "    build, which it never did while it lived in this crate. Check that"
      echo "    'myne-core/remote-ai' rides on the 'local-inference' feature rather"
      echo "    than on the myne-core dependency line, and that 'remote-ai' is not"
      echo "    in myne-core's default feature set."
      violation=1
      ;;
    *)
      echo "  ✓ 'remote-ai' is OFF in the --no-default-features closure (features = $audit_features)"
      ;;
  esac
fi

case ",$shipped_features," in
  *,remote-ai,*)
    echo "  ✓ 'remote-ai' is ON in the shipped closure (features = $shipped_features)"
    ;;
  *)
    echo "  ✗ 'remote-ai' is OFF in the shipped closure (features = ${shipped_features:-<unreadable>}):"
    echo "    the remote-provider arm is not being built at all. Either the"
    echo "    'local-inference' feature stopped implying 'myne-core/remote-ai',"
    echo "    or the arm was removed."
    violation=1
    ;;
esac

# The module gate the graph cannot see.
#
# ADJACENCY, and the reason it is two greps and not one. A feature turned on
# with the `#[cfg]` dropped compiles the arm in every configuration, and the
# feature graph above would call that correct, so the source has to be read.
#
# A COMMENT-AWARE READER IS A READER WITH A BYPASS, and this one had one. The
# first version skipped lines matching `^//`, `^/\*` and `^\*` and then required
# the attribute and the declaration to be adjacent. A column-0 block comment
# whose interior is not `*`-prefixed leaves its interior visible, so this shape
#
#     /* Temporarily ungated for debugging.
#     #[cfg(feature = "remote-ai")]
#     pub mod inference;
#     */
#     pub mod inference;
#
# satisfied the check with the real gate deleted, and the audit build compiled
# provider-transport code while this printed a green tick. Check 4 below is a
# plain grep and says in its own header why ("prose must not spell the
# identifier either, a comment-aware scanner is a scanner with a bypass"); this
# half now matches that discipline rather than half-contradicting it.
#
# So: no comment handling at all, and the property is stated as a UNIVERSAL
# rather than an existential: EVERY exact `pub mod inference;` line in the file
# must be immediately preceded by the attribute. A single ungated declaration
# fails, and that is the shape that matters: one ungated `pub mod inference;` is
# the whole of provider-transport code in the audit build.
#
# An existential ("is there such a pair anywhere") is not enough, and the
# comment-skipping version was exactly that: `grep -A1` found the attribute
# inside a block comment and the declaration on the comment's next line, so the
# pair it proved was the commented-out copy and the live one below was never
# examined.
#
# The cost is stated rather than hidden: a line-initial `//` comment wedged
# between the attribute and the declaration fails this check, which is a shape a
# real gate does not have.
inference_gate() {
  awk -v attr='#[cfg(feature = "remote-ai")]' '
    {
      if ($0 == "pub mod inference;") {
        found = 1
        if (prev != attr) { print "ungated"; exit 1 }
      }
      prev = $0
    }
    END { if (found != 1) exit 1 }
  ' "$REPO_ROOT/core/src/lib.rs"
}
if inference_gate; then
  echo "  ✓ \`pub mod inference;\` sits behind \`#[cfg(feature = \"remote-ai\")]\`"
else
  echo "  ✗ \`pub mod inference;\` in core/src/lib.rs is not behind an"
  echo "    \`#[cfg(feature = \"remote-ai\")]\` on the line above it. The feature"
  echo "    graph can look correct while the module compiles unconditionally,"
  echo "    which puts provider-transport code in the audit build."
  violation=1
fi


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
#    It is kept because renaming it would touch `.woodpecker/main.yml`, the root
#    AGENTS.md guard table and every doc that cites it, for no safety gain.
echo "== AI-path egress call sites (ratchet) =="

# myne#529: the agent is a NEW AI path carrying note plaintext to whatever
# backend serves the run, and it lives in two trees this ratchet did not scan.
# No socket exists on either today, so adding them starts their allowlist empty
# exactly as #414 landed this check: a later shortcut in `EngineAdapter` would
# add no crate, pass checks 1 and 2, and have to argue for its own entry here.
# `core/src/inference` joined the roots when the inference seam and the remote
# arm moved out of the desktop plugin (myne-md/myne#456). The move alone would
# have taken the whole remote transport OUT of this scan while every record
# below still named its old path, so the roots and the four records are edited
# in the same commit as the move. The other direction is what makes that
# reliable: a recorded site whose file no longer exists fails below, so a move
# that forgets this line cannot report ok.
# The last entry is the SECOND client that ships the remote arm
# (myne-md/myne#456). It lands with zero matches, which is the point: the entry
# has to exist before the first socket, not after one. `mobile/src-tauri/Cargo.toml`
# enables `myne-core/remote-ai` directly, so that tree compiles
# `provider_transport.rs`, and a call site added there would otherwise add no
# crate, pass checks 1 and 2, and never be opened by check 4.
AI_EGRESS_ROOTS="src-tauri/src/plugins/local_inference src-tauri/src/plugins/agent core/src/plugins/agent core/src/inference mobile/src-tauri/src/plugins/agent"

# One record per line: <repo-relative-path>|<exact count>|<reason>
#
# Landed empty by #414, on purpose, before any provider code existed. The first
# entry below arrived the way it was supposed to: #189 task 5 wrote a socket,
# this guard went red, and the reason had to be written before it could go green
# again. A guard added after the thing it watches cannot do that.
AI_EGRESS_SITES=$(cat <<'EOF'
src-tauri/src/plugins/local_inference/engine_ollama.rs|9|The local model-runtime arm (#189). Loopback-only BY CONSTRUCTION rather than by a check written at the socket: the host and port it connects to can only have come from `endpoint_config::validate`, which resolves through myne-core's single `is_loopback` predicate — a literal match against `127.0.0.1` / `localhost` / `::1`, never a resolved address, which is what closes the DNS-rebind hole a free-form URL field would open. There is therefore no source IP to expose and nothing for Tor mode to route around, the same argument `no_bypass.rs`'s `http_transport.rs` entry makes about the sync loopback transport. The count is 9, not 1, and it counts LINES because the guard is a grep: 2 production calls (`to_socket_addrs`, needed because `connect_timeout` takes a resolved address, and `connect_timeout` itself), 6 `TcpListener::bind` fake servers in the test module (one per timing scenario), and 1 COMMENT line that happens to name `connect_timeout`. That comment is counted on purpose — see the strictness note below; it is also why the arithmetic here reads 2+6+1 rather than 2+6. The count moved 3 -> 8 when the deadlines landed and 8 -> 9 at b36dc7d2 (#445), which added a seventh fake server for the cancel-one-request test and left this number behind; the drift sat undetected for days because CI was not running on push at all. An exact count rather than a boolean is the whole reason this was catchable. This guard does not strip `#[cfg(test)]` — it is a shell script, not a Rust parser — and that is left deliberately strict: a socket parked in a test-only block that production can still reach would otherwise be invisible here.
core/src/inference/provider_gate.rs|2|TEST FIXTURES ONLY (the gate itself opens nothing; it returns a decision. The two matches are a `TcpListener::bind` and a `TcpStream::connect` inside `default_off_proof`, the accept-counting probe for the invariant this whole slice rests on: with no provider named, SIX distinct unconfigured states each open ZERO sockets. Six rather than seven since myne-md/myne#456 removed `developer_mode` from the precondition set; the row went with the precondition rather than being converted, because with the flag unread it would have been the fully-configured state asserting zero sockets, which is what the control arm proves the opposite of. The probe must be able to open one) that is the CONTROL ARM, and without it the six zeros would be compatible with a probe that could never see anything (`rustls_transport.rs`: "the probe must be able to see a direct connection, or the zero above proves nothing"). Recording the fixture is the price of a probe that measures rather than asserts.
core/src/inference/state.rs|5|TEST FIXTURES ONLY (the seam itself opens nothing. `state.rs` is the SYNC-14/SYNC-16 bar, and its two matches are a `TcpListener::bind` and a `TcpStream::connect` inside `remote_bar_proof`: a counting listener plus a deliberately-connecting fake engine, which together prove that an ambient request against a Remote-class backend reaches the network ZERO times. The probe has to be able to open a socket, or its zero would prove nothing) that is the point of the control arm, and it is why this file appears here at all. This guard does not strip `#[cfg(test)]`, deliberately; recording the fixture is the cost of a probe that can actually see a connection. Moved 2 -> 5 in task 18, when the selection became prefs-driven and a second probe was needed: `selection_proof` registers a Remote-class arm that CONNECTS when reached and drives the wired seam (`engine_for` / `embedding_engine`) across eight unconfigured states, asserting zero accepts, then one in the control arm. Its three matches are that module's `TcpListener::bind` and two `TcpStream::connect` (one in the fake engine's `infer`, one in its `embed`: the embed fixture connects on purpose, because a fake that refused would make "embedding opened no socket" true of the fake rather than of the seam). Production in this file remains ZERO: the bar and the selection both return an `Arc<dyn Engine>` and neither touches a socket.
core/src/inference/provider_transport.rs|10|The REMOTE provider arm (myne#415). TWO callers now reach it, both user-initiated and both through the same four-precondition gate: a completion (`RemoteEngine::chat_streaming`) and the model listing the chooser populates from (`commands::list_provider_models`, task 17 / SYNC-24). The listing fetches model NAMES and no weights, so it stays on the permitted side of the pull-or-download line `decisions.md` 2026-08-09 draws; it is recorded here rather than waved past because an authenticated listing call still tells the provider this account exists. The count below does not move for it (it opens no socket of its own, it borrows this module's one `connect`). This is the entry the ratchet was landed empty to force an argument for, and the argument is not "loopback, so it is fine": this socket leaves the device, carrying note plaintext, which is the whole of what `decisions.md` 2026-08-09 superseded the old no-egress claim to permit. What bounds it is not the check at the socket but the SHAPE of the type: the direct dial lives in the module-private `open_socket_via(proxy, host, port)`, whose sole PRODUCTION caller is `ProviderTransport::open_socket`, passing `self.host.host()` from a `ProviderHost` (a PRIVATE `&.static str` field, minted only by `ProviderHost::resolve` against the compiled-in `PROVIDER_HOSTS` table). The `&str` seam is what lets the two Tor tests below drive a loopback host, so the older claim that `connect_timeout` is reachable only through a `ProviderHost` no longer holds of the helper itself; the bound is now that the helper is module-private and its only production caller passes a compiled-in host, and this guard does not match the helper or `connect_via_socks5`, so an in-module call with arbitrary text would be a review finding rather than a count change. TLS verification is the stock rustls chain+hostname check against the static `webpki-roots` bundle, with no `.dangerous()` and no custom verifier anywhere in the module, asserted by `there_is_no_verification_bypass_in_this_module`, which reads production lines with comments stripped, because this file's own doc comment says the words. The count is 10, not 1. Production contributes 2: `to_socket_addrs` (needed because `connect_timeout` takes a resolved address) and `connect_timeout` itself. The other 6 are test fixtures: 3 `TcpListener::bind` and 3 `TcpStream::connect` across the untrusted-certificate arm, the never-responding-provider deadline test and the pre-first-byte cancel test. It moved 4 -> 8 when task 6's deadline and cancel landed, and this ratchet is what noticed: an exact count rather than a boolean is the whole reason it could. It moved 8 -> 10 with myne-md/myne#607's two Tor tests, each binding one probe `TcpListener` (the fail-closed probe, and the splice target the ready-proxy test tunnels to; the fake SOCKS5 server those reach is the inline test-only `mod fake` inside `core/src/plugins/sync/socks5.rs`, which no guard counts (it is `#[cfg(test)]`-gated and opens no outbound socket of its own)). As with the loopback entry, `#[cfg(test)]` is NOT stripped, deliberately. Tor mode is honoured since myne-md/myne#607: `ProviderTransport::open_socket` consults `proxy::installed_for(host).route()` and, with Tor on and the sidecar not `Ready`, returns WITHOUT opening a socket; there is no direct-connect fallback, the same fail-closed rule `model_download.rs` documents one row below. The name is resolved on the `Socks5` arm by the proxy, inside the circuit, never by this device's resolver. The count below the test fixtures stays 10 because the change moved the direct dial into `open_socket_via` and added only `connect_via_socks5`, which this guard's patterns do not match: production still contributes the same `to_socket_addrs` + `connect_timeout` pair, and the two new entries are test-only.
core/src/inference/model_download.rs|3|The on-demand MODEL DOWNLOAD transport (myne-md/myne#805, `decisions/ai/0627`). This is egress with NO provider named, and it is the whole point of the entry that the argument is not "it carries no note content". It carries none, the request is a bare GET of a model file, with no account number, no key and no note bytes, but it is still an outbound connection the user did not name, so it earns a record rather than a wave-past. What bounds it: the fetch happens only on an explicit user action (a card in onboarding or the AI settings panel); the destination is a compiled-in constant, `downloads.myne.md`, so a tampered prefs blob or a compromised WebView can select nothing else; every fetched file is verified against a SHA-256 compiled into the client binary before the model is registered, so a tampered origin cannot serve bytes that agree with the check; and the origin keeps no IP logs and no analytics (`decisions/ai/0627`, threat-model TB14). TLS is the stock rustls chain+hostname check against the static `webpki-roots` bundle, with no `.dangerous()` and no custom verifier. Tor mode is honoured: `open_socket_via` consults `proxy::installed_for(host).route()` and, with Tor on and the sidecar not Ready, returns WITHOUT opening a socket, there is no direct fallback. The count is 3, not 1: production contributes 1 (`TcpStream::connect` in `open_socket_via`; `connect_via_socks5` is not matched by these patterns), and the tests contribute 2 `TcpListener::bind`, the probe in `tor_on_with_no_ready_proxy_fails_closed_and_dials_nothing`, whose control arm proves the probe can see a connection so the zero is meaningful, and the splice target in `a_tor_ready_gate_routes_the_download_socket_through_the_proxy`, the positive half that proves a ready proxy is actually used. `#[cfg(test)]` is NOT stripped, deliberately, out of the two records above.
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
