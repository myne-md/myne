#!/usr/bin/env bash
# Assert Myne's HTTP origins log no client IP (phase3-web-client task 110).
#
# "No persistent server-side IP logging" is a hard architectural commitment and
# AS14 is normative. Two origins are covered here, because they lose it the
# same way for different reasons:
#
#   web   the hosted web client's container (web/container/Dockerfile), served
#         at app.myne.md. **A page load here is a vault opening** — a default
#         access log would be an access-time record of when each user opens
#         their notes, precisely the record the design refuses to keep.
#
#   site  the marketing site's container (myne-website/Dockerfile), served at
#         myne.md and preview.myne.md. Lower stakes per request, but it is the
#         origin the privacy policy is published *on*, so a policy promising no
#         IP logs while the site writes them is the worst available shape. It
#         did exactly that until 2026-08-04: the config set no log_format and
#         no access_log, so nginx:alpine's stock `main` format applied, which
#         opens with $remote_addr — and with the default json-file log driver
#         those lines reach disk.
#
# Caddy's default access log emits the client IP, and `nginx:alpine` writes
# `$remote_addr` on every request, so a default anything would do it.
#
# Configuration is not evidence. This starts the real containers, drives real
# requests carrying a distinctive `X-Forwarded-For`, captures the whole log
# stream, and fails if either the connecting address or the injected value
# appears anywhere in it.
#
#   ./scripts/check-web-no-ip-logging.sh              # both origins, build first
#   ./scripts/check-web-no-ip-logging.sh --no-build   # reuse existing images
#   ./scripts/check-web-no-ip-logging.sh --web        # one origin only
#   ./scripts/check-web-no-ip-logging.sh --site

set -uo pipefail
cd "$(dirname "$0")/.."

NEEDLE="203.0.113.77"   # TEST-NET-3, RFC 5737 — never a real client address.
BUILD=1
TARGETS="web site"

for arg in "$@"; do
  case "$arg" in
    --no-build) BUILD=0 ;;
    --web)      TARGETS="web" ;;
    --site)     TARGETS="site" ;;
    *) echo "usage: $0 [--no-build] [--web|--site]"; exit 2 ;;
  esac
done

# probe <label> <image> <host-port> <container-port> <ready-path> <expect-healthz-skipped>
#
# Returns 0 if the origin served the requests and no client address reached the
# log stream. <expect-healthz-skipped> is "yes" only where a health route
# exists and is polled continuously; the marketing site has none.
probe() {
  local label="$1" image="$2" port="$3" cport="$4" ready="$5" healthz="$6"
  local fail=0

  echo
  echo "── $label ─────────────────────────────────────────────"

  local cid
  cid=$(docker run -d --rm -p "$port:$cport" \
    -e MYNE_SYNC_ORIGIN=https://sync.example.org "$image") || {
    echo "FAIL[$label]: container did not start"; return 1; }
  # shellcheck disable=SC2064
  trap "docker rm -f $cid >/dev/null 2>&1 || true" RETURN

  # Wait for the server rather than sleeping a guessed interval — and FAIL if it
  # never comes up. Without this the log check passes vacuously against a
  # container that served nothing, which is the worst possible shape for a test
  # whose whole job is to prove an absence. (It did exactly that on its first
  # run.)
  local up=0
  for _ in $(seq 1 60); do
    if curl -fsS -o /dev/null "http://127.0.0.1:$port$ready" 2>/dev/null; then up=1; break; fi
    sleep 0.25
  done
  if [ "$up" -ne 1 ]; then
    echo "FAIL[$label]: the container never served $ready — nothing was tested."
    docker logs "$cid" 2>&1 | tail -20
    return 1
  fi

  echo "driving requests ..."
  curl -fsS -o /dev/null "http://127.0.0.1:$port/" || true
  curl -fsS -o /dev/null "http://127.0.0.1:$port$ready" || true
  curl -fsS -o /dev/null -H "X-Forwarded-For: $NEEDLE" "http://127.0.0.1:$port/" || true
  curl -fsS -o /dev/null -H "X-Real-Ip: $NEEDLE" "http://127.0.0.1:$port/" || true
  curl -fsS -o /dev/null -H "Forwarded: for=$NEEDLE" "http://127.0.0.1:$port/nonexistent" || true
  sleep 1

  local logs
  logs=$(docker logs "$cid" 2>&1)

  if grep -q "$NEEDLE" <<<"$logs"; then
    echo "FAIL[$label]: an injected forwarded-for value reached the log stream."
    grep -n "$NEEDLE" <<<"$logs" | head -5
    fail=1
  fi

  # The connecting address inside a container network is an RFC 1918 or loopback
  # address; either appearing means the remote_ip field survived the filter.
  if grep -qE '"(remote_ip|client_ip|remote_port)"' <<<"$logs"; then
    echo "FAIL[$label]: an IP-bearing log FIELD is present (the field-delete filter is not applied)."
    grep -oE '"(remote_ip|client_ip|remote_port)":"?[^,"]*"?' <<<"$logs" | head -5
    fail=1
  fi
  if grep -qE '\b(10|172|192)\.[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}\b' <<<"$logs"; then
    echo "FAIL[$label]: something that looks like a client address is in the log stream."
    grep -oE '\b(10|172|192)\.[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}\b' <<<"$logs" | sort -u | head -5
    fail=1
  fi

  # Where a health route exists it is polled continuously; it must not log at all.
  if [ "$healthz" = "yes" ] && grep -q '/healthz' <<<"$logs"; then
    echo "FAIL[$label]: /healthz produced a log line (log_skip is not applied)."
    fail=1
  fi

  # An absence proved against an empty log proves nothing. Require evidence that
  # the server actually handled the requests.
  if ! grep -q 'GET' <<<"$logs" && ! grep -qi 'serving' <<<"$logs"; then
    echo "FAIL[$label]: the log stream shows no sign the server handled anything — an"
    echo "      absence asserted against an empty log is not evidence."
    echo "$logs" | tail -20
    fail=1
  fi

  if [ "$fail" -eq 0 ]; then
    echo "ok[$label] — server served the requests; no client IP, no forwarded-for"
    echo "     value$([ "$healthz" = yes ] && echo ", and no health-route line") anywhere in the log stream"
    echo "     ($(wc -l <<<"$logs") log lines inspected)"
  fi
  return $fail
}

rc=0

if [[ " $TARGETS " == *" web "* ]]; then
  if [ "$BUILD" -eq 1 ]; then
    echo "building the web-client container ..."
    docker build -q -f web/container/Dockerfile -t myne-web-iplog-test . >/dev/null || {
      echo "FAIL: web image build failed"; exit 1; }
  fi
  probe "web · app.myne.md" myne-web-iplog-test 18099 8080 /healthz yes || rc=1
fi

if [[ " $TARGETS " == *" site "* ]]; then
  # The marketing site lives in a companion repo. Skip rather than fail when it
  # is not cloned — a missing companion is a workspace state, not a violation.
  if [ ! -f myne-website/Dockerfile ]; then
    echo
    echo "skip[site]: myne-website/ is not cloned — the marketing origin was NOT checked."
  else
    if [ "$BUILD" -eq 1 ]; then
      echo "building the marketing-site container ..."
      docker build -q -f myne-website/Dockerfile -t myne-site-iplog-test myne-website >/dev/null || {
        echo "FAIL: site image build failed"; exit 1; }
    fi
    probe "site · myne.md" myne-site-iplog-test 18098 80 / no || rc=1
  fi
fi

echo
if [ "$rc" -eq 0 ]; then
  echo "PASS — every origin checked logs no client IP."
else
  echo "FAIL — at least one origin logs a client address; see above."
fi
exit $rc
