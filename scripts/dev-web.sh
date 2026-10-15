#!/usr/bin/env bash
# One command that brings the WEB client up locally (myne-md/myne#873).
#
#   pnpm web:local                      # dev client on :1421 + a local sync server
#   MYNE_DEV_NO_OPEN=1 pnpm web:local   # do not open a browser
#   MYNE_DEV_SYNC_PORT=9000 pnpm web:local
#   MYNE_DEV_REBUILD_WASM=1 pnpm web:local
#   MYNE_SERVER_DIR=~/other/myne-server pnpm web:local
#
# Reset: `rm -rf .opencode/dev-sync-store*` with nothing running, or
# `pnpm dev:two:reset` for the store the two dev commands share.
#
# # Why this exists rather than just `pnpm web:dev`
#
# `pnpm web:dev` alone reaches the environment refusal screen, and did from the day
# the client landed. Two deployment facts were missing, and neither is a bug in the
# app: cross-origin isolation (no COOP/COEP means `crossOriginIsolated` is false and
# `SharedArrayBuffer` is undefined, which `web/src/environment-gate.ts` refuses at
# boot) and the `/config.json` document that names the sync origin, which only the
# container wrote. `web/vite.config.ts` now supplies both to the dev server; this
# script supplies the other half, a sync server to point at.
#
# # Why a sync server is not optional here
#
# The web client has no offline first run (`decisions.md` 2026-07-26): creating a
# vault, and every later session, needs the server. So unlike `dev-two-desktop.sh`,
# which warns and starts the desktop windows anyway, this script FAILS when it cannot
# bring a server up. A desktop window with no sync server is still a desktop app; a
# browser tab with no sync server can do nothing at all, and failing is the honest
# answer.
#
# # Why the store is on disk
#
# `MYNE_STORAGE_BACKEND=fs` is explicit because the server's default is `mem`
# (`myne-server/internal/httpapi/config.go`), which throws every account and vault
# away at exit while `MYNE_STORAGE_PATH` sits there looking persistent. The two
# variables are read together or not at all, and this script sets both.
#
# The store lives under this checkout's `.opencode/`, like `dev:two`'s, so a run
# survives a restart and the same account opens in the desktop app and the browser
# when both run from the same directory. It is per-checkout rather than global, and
# inside the checkout rather than in a user-data directory, for one reason: a
# checkout is what gets REMOVED. `/done` deletes the worktree this store belongs to,
# so the state goes with it instead of accumulating somewhere nobody remembers.
#
# What it holds is worth naming, since the change to `fs` is what makes the directory
# non-empty: the account's hashed identifier, its Argon2id verifier and the vault's
# ciphertext, which is the material `docs/threat-model.md` TB5/TB6 already classifies
# as server-side and adversarially readable. The only thing standing between it and a
# commit is one `.gitignore` line, which is hygiene and not a control, exactly as the
# root `AGENTS.md` says of `protected-branch`.
set -euo pipefail
cd "$(dirname "$0")/.."

# Job control: each background job gets its own process group, which is what lets
# cleanup kill the WHOLE tree (`pnpm web:dev` -> vite -> esbuild, and the server)
# instead of orphaning them on Ctrl-C.
set -m

PIDS=()
cleanup() {
  echo
  echo "==> stopping"
  for pid in "${PIDS[@]}"; do
    kill -- "-$pid" 2>/dev/null || kill "$pid" 2>/dev/null || true
  done
  wait 2>/dev/null || true
}
trap cleanup EXIT INT TERM

WEB_PORT=1421
SYNC_PORT_REQUESTED="${MYNE_DEV_SYNC_PORT:-8787}"
SYNC_STORE="$(pwd)/.opencode/dev-sync-store"

# `nc` rather than bash's `/dev/tcp`, which macOS's bash 3.2 does not compile in.
# Same dependency `dev-two-desktop.sh` already has, but checked here, because a
# missing probe tool reads as "closed"/"not serving" and would quietly turn every
# check below into its opposite. `curl` is required for the same class of reason:
# the confirmation that the dev server is really this script's cannot be skipped
# without becoming a pass.
for tool in nc curl; do
  if ! command -v "$tool" >/dev/null 2>&1; then
    echo "!! '$tool' is not on PATH. This script probes ports with nc and confirms the" >&2
    echo "!! dev server with curl; neither can be skipped safely." >&2
    exit 2
  fi
done
# Two hosts, because the two servers bind differently. The sync server is given
# `127.0.0.1` explicitly (below), while Vite binds `localhost`, which on macOS resolves
# to `[::1]` alone. Probing Vite's port on `127.0.0.1` reports CLOSED for a port this
# script is itself serving, and that is not a subtle failure: the pre-flight check would
# never fire, and every run would sit through the readiness wait's full 18 seconds.
port_in_use() { nc -z "$1" "$2" 2>/dev/null; }

# ── the dev client's port is checked BEFORE anything is started ───────────────
#
# A server already on :1421 was not necessarily started by this script, and the
# ones that were not (an older checkout, a bare `pnpm web:dev`, a session that
# predates the headers) serve the refusal screen. Reusing one silently would make
# this command's whole promise unverifiable, so it stops here instead.
if port_in_use localhost "$WEB_PORT"; then
  echo "!! :$WEB_PORT is already serving. Stop that server and re-run: a dev server" >&2
  echo "!! started outside this script has no cross-origin isolation headers and no" >&2
  echo "!! /config.json, so the page it serves is the environment refusal screen." >&2
  exit 2
fi

# ── the wasm package ──────────────────────────────────────────────────────────
#
# `web/wasm/pkg/` is a derived artefact and is NOT in git, and `src/worker/worker.ts`
# imports it by path, so a fresh worktree fails the bundle with a missing-export
# error rather than at runtime. Built once and then left alone, because it is the
# slowest step here by an order of magnitude; `MYNE_DEV_REBUILD_WASM=1` forces it
# after a change to `web/wasm/src/` or to `core/`.
if [ ! -f web/wasm/pkg/myne_web_wasm.js ] || [ -n "${MYNE_DEV_REBUILD_WASM:-}" ]; then
  echo "==> building the web wasm package (not in git; this takes a few minutes)"
  ./scripts/build-wasm.sh
fi

# ── the sync server ───────────────────────────────────────────────────────────
#
# A WORKTREE HAS NO COMPANION REPOS. `myne-server` is a separate GitHub repo cloned
# by `./workspace/setup.sh` into the MAIN checkout, so `myne-server/` simply does not
# exist beside this script when the session is in one. `--git-common-dir` is the
# shared `.git`, whose parent is the checkout the worktrees were cut from, so that
# is where the second look goes. `MYNE_SERVER_DIR` overrides both.
#
# The binary is written next to that companion (gitignored there, exactly as
# `dev-two-desktop.sh` does it); the STORE stays under THIS checkout's `.opencode/`,
# so two worktrees never share accounts.
server_dir() {
  if [ -n "${MYNE_SERVER_DIR:-}" ]; then printf '%s' "$MYNE_SERVER_DIR"; return; fi
  if [ -f myne-server/go.mod ]; then printf '%s' "myne-server"; return; fi
  local common main
  common="$(git rev-parse --path-format=absolute --git-common-dir 2>/dev/null || true)"
  if [ -n "$common" ]; then
    main="$(dirname "$common")"
    if [ -f "$main/myne-server/go.mod" ]; then printf '%s' "$main/myne-server"; return; fi
  fi
  printf '%s' ""
}

SERVER_DIR="$(server_dir)"
if [ -z "$SERVER_DIR" ]; then
  echo "!! no myne-server checkout found, beside this script or beside the main one." >&2
  echo "!! The web client cannot open a vault without a sync server, so this stops" >&2
  echo "!! rather than opening a page that cannot work. Clone the companions with" >&2
  echo "!! ./workspace/setup.sh, or point MYNE_SERVER_DIR at one." >&2
  exit 1
fi

if command -v go >/dev/null 2>&1; then
  echo "==> building myne-server (host binary, from $SERVER_DIR)"
  if ! (cd "$SERVER_DIR" && go build -o myne-server ./cmd/myne-server); then
    echo "!! could not build myne-server in $SERVER_DIR." >&2
    exit 1
  fi
fi

SERVER_BIN="$SERVER_DIR/myne-server"
if [ ! -x "$SERVER_BIN" ]; then
  echo "!! $SERVER_BIN is missing, and no Go toolchain is here to build it." >&2
  exit 1
fi

# The store is what carries the account, so the PORT is the cheap thing to move. A run
# that does move gets its OWN store, and that is the part worth spelling out:
# `myne-server` locks per vault IN PROCESS only (`myne-server/internal/store/fsstore.go`:
# "Locking is PER VAULT, not per store"), so two server processes over one store root
# are two writers with nothing between them. A first run, where the port is free, shares
# the store with `pnpm dev:two` on purpose: that is how one account opens in the desktop
# app and in the browser. A second one does not, and says so rather than promising an
# account that is not in the store it just started.
SYNC_PORT="$SYNC_PORT_REQUESTED"
moved=0
while port_in_use 127.0.0.1 "$SYNC_PORT"; do
  SYNC_PORT=$((SYNC_PORT + 1))
  moved=$((moved + 1))
  if [ "$moved" -gt 20 ]; then
    echo "!! no free sync port in $SYNC_PORT_REQUESTED..$SYNC_PORT. Set MYNE_DEV_SYNC_PORT." >&2
    exit 2
  fi
done
if [ "$moved" -ne 0 ]; then
  SYNC_STORE="${SYNC_STORE}-${SYNC_PORT}"
  echo "==> :$SYNC_PORT_REQUESTED is taken; using :$SYNC_PORT with its own store"
fi
SYNC_ENDPOINT="http://127.0.0.1:${SYNC_PORT}"

# `MYNE_ALLOWED_ORIGINS` is what makes the browser's calls legal at all: the page is
# on a different origin from the server by construction, CORS is off unless an
# operator lists origins, and an unlisted one is refused at the preflight with a 403
# and no explanation. Both spellings, because `localhost` and `127.0.0.1` are two
# different origins to a browser and both are things a person types.
mkdir -p "$SYNC_STORE"
echo "==> starting the local sync server on $SYNC_ENDPOINT (store: $SYNC_STORE)"
MYNE_SERVER_ADDR="127.0.0.1:${SYNC_PORT}" \
  MYNE_STORAGE_BACKEND=fs \
  MYNE_STORAGE_PATH="$SYNC_STORE" \
  MYNE_ALLOWED_ORIGINS="http://localhost:${WEB_PORT},http://127.0.0.1:${WEB_PORT}" \
  "$SERVER_BIN" &
SYNC_PID="$!"
PIDS+=("$SYNC_PID")
for _ in $(seq 1 40); do
  port_in_use 127.0.0.1 "$SYNC_PORT" && break
  sleep 0.3
done

# The same two questions as for the dev client below, and for the same reason: a
# port that answers is not the same thing as OUR server. Here the stakes differ in
# kind, because the client would be handed a `/config.json` naming a server this run
# did not start, which is the "two writers of one value" failure the container's
# generator exists to prevent.
if ! kill -0 "$SYNC_PID" 2>/dev/null; then
  echo "!! the sync server exited before it was listening. A taken :$SYNC_PORT is the" >&2
  echo "!! usual reason; the store is untouched and a re-run picks the next free port." >&2
  exit 1
fi
if ! curl -sf "http://127.0.0.1:${SYNC_PORT}/healthz" >/dev/null 2>&1; then
  echo "!! :$SYNC_PORT answers, but not with the sync server's /healthz." >&2
  exit 1
fi

# ── the dev client ─────────────────────────────────────────────────────────────
echo "==> starting the web dev client on :$WEB_PORT"
MYNE_DEV_SYNC_ORIGIN="$SYNC_ENDPOINT" pnpm web:dev &
VITE_PID="$!"
PIDS+=("$VITE_PID")
for _ in $(seq 1 60); do
  port_in_use localhost "$WEB_PORT" && break
  sleep 0.3
done

# ── the two checks that make this command's output TRUE rather than plausible ──
#
# The loop above only asks whether the port ANSWERS, which cannot tell this
# script's server from somebody else's. Both checks below were added after the
# failure they catch happened for real: the config file was edited while a dev
# server was running, Vite restarted it (freeing the port for a moment), this
# script's own server lost the race for :1421 and exited, and the run still printed
# "web client: http://localhost:1421" over a window that was not the one it built.
#
# 1. The client is still alive. `pnpm web:dev` is the process-group leader, so the
#    moment vite exits (a taken port is the common cause), this pid is gone.
# 2. The response carries the isolation headers. This is the promise of the whole
#    command, and asking for it directly is the only way to know the URL printed
#    below leads to the app rather than to the environment refusal screen.
if ! kill -0 "$VITE_PID" 2>/dev/null; then
  echo "!! the web dev client exited before it was serving. Read its output above:" >&2
  echo "!! a taken :$WEB_PORT is the usual reason." >&2
  exit 1
fi
# Both halves of the pair, not one. They are two separate headers and
# `web/src/environment-gate.ts` requires `crossOriginIsolated` AND a constructible
# `SharedArrayBuffer`, so a regression that drops only COEP would pass a single-header
# check and still print a URL that leads to the refusal screen.
WEB_HEADERS="$(curl -sfI "http://localhost:${WEB_PORT}/" 2>/dev/null || true)"
for header in cross-origin-opener-policy cross-origin-embedder-policy; do
  if ! printf '%s' "$WEB_HEADERS" | grep -qi "^${header}:"; then
    echo "!! :$WEB_PORT answers without the $header header, so this is not the dev" >&2
    echo "!! server this script started. The page it serves is the refusal screen." >&2
    exit 1
  fi
done

WEB_URL="http://localhost:${WEB_PORT}"
echo
echo "==> web client: $WEB_URL"
echo "    sync server: $SYNC_ENDPOINT, already wired in through /config.json"
echo "    the dev server sends NO CSP (Vite's dev client is an inline module script),"
echo "    so nothing about the security posture is verified here: that lives in the"
echo "    container and in \`pnpm test:e2e:web\`, which load the built bundle."
echo "    Ctrl-C stops both."
if [ -z "${MYNE_DEV_NO_OPEN:-}" ] && command -v open >/dev/null 2>&1; then
  open "$WEB_URL"
fi

wait
