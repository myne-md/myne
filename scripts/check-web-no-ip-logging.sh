#!/usr/bin/env bash
# Assert the web-client container logs no client IP (phase3-web-client task 110).
#
# "No persistent server-side IP logging" is a hard architectural commitment and
# AS14 is normative. This origin is where it is easiest to lose silently, and
# the reason is worth stating plainly: **a page load here is a vault opening.**
# A default access log on this origin would be an access-time record of when
# each user opens their notes — precisely the record the whole design refuses to
# keep. Caddy's default access log emits the client IP, and `nginx:alpine`
# writes `$remote_addr` on every request, so a default anything would do it.
#
# Configuration is not evidence. This starts the real container, drives real
# requests carrying a distinctive `X-Forwarded-For`, captures the whole log
# stream, and fails if either the connecting address or the injected value
# appears anywhere in it.
#
#   ./scripts/check-web-no-ip-logging.sh            # build the image, then test
#   ./scripts/check-web-no-ip-logging.sh --no-build # reuse an existing image

set -uo pipefail
cd "$(dirname "$0")/.."

IMAGE=myne-web-iplog-test
PORT=18099
NEEDLE="203.0.113.77"   # TEST-NET-3, RFC 5737 — never a real client address.

if [ "${1:-}" != "--no-build" ]; then
  echo "building the web container ..."
  docker build -q -f web/container/Dockerfile -t "$IMAGE" . >/dev/null || {
    echo "FAIL: image build failed"; exit 1; }
fi

CID=$(docker run -d --rm -p "$PORT:8080" \
  -e MYNE_SYNC_ORIGIN=https://sync.example.org "$IMAGE") || {
  echo "FAIL: container did not start"; exit 1; }
trap 'docker rm -f "$CID" >/dev/null 2>&1 || true' EXIT

# Wait for the server rather than sleeping a guessed interval — and FAIL if it
# never comes up. Without this the log check passes vacuously against a
# container that served nothing, which is the worst possible shape for a test
# whose whole job is to prove an absence. (It did exactly that on its first
# run.)
up=0
for _ in $(seq 1 60); do
  if curl -fsS -o /dev/null "http://127.0.0.1:$PORT/healthz" 2>/dev/null; then up=1; break; fi
  sleep 0.25
done
if [ "$up" -ne 1 ]; then
  echo "FAIL: the container never served /healthz — nothing was tested."
  docker logs "$CID" 2>&1 | tail -20
  exit 1
fi

echo "driving requests ..."
curl -fsS -o /dev/null "http://127.0.0.1:$PORT/" || true
curl -fsS -o /dev/null "http://127.0.0.1:$PORT/healthz" || true
curl -fsS -o /dev/null -H "X-Forwarded-For: $NEEDLE" "http://127.0.0.1:$PORT/" || true
curl -fsS -o /dev/null -H "X-Real-Ip: $NEEDLE" "http://127.0.0.1:$PORT/version.json" || true
curl -fsS -o /dev/null -H "Forwarded: for=$NEEDLE" "http://127.0.0.1:$PORT/nonexistent" || true
sleep 1

LOGS=$(docker logs "$CID" 2>&1)
fail=0

if grep -q "$NEEDLE" <<<"$LOGS"; then
  echo "FAIL: an injected forwarded-for value reached the log stream."
  grep -n "$NEEDLE" <<<"$LOGS" | head -5
  fail=1
fi

# The connecting address inside a container network is an RFC 1918 or loopback
# address; either appearing means the remote_ip field survived the filter.
if grep -qE '"(remote_ip|client_ip|remote_port)"' <<<"$LOGS"; then
  echo "FAIL: an IP-bearing log FIELD is present (the field-delete filter is not applied)."
  grep -oE '"(remote_ip|client_ip|remote_port)":"?[^,"]*"?' <<<"$LOGS" | head -5
  fail=1
fi
if grep -qE '\b(10|172|192)\.[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}\b' <<<"$LOGS"; then
  echo "FAIL: something that looks like a client address is in the log stream."
  grep -oE '\b(10|172|192)\.[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}\b' <<<"$LOGS" | sort -u | head -5
  fail=1
fi

# The health route is polled continuously; it must not log at all.
if grep -q '/healthz' <<<"$LOGS"; then
  echo "FAIL: /healthz produced a log line (log_skip is not applied)."
  fail=1
fi

# An absence proved against an empty log proves nothing. Require evidence that
# the server actually handled the requests.
if ! grep -q 'GET' <<<"$LOGS" && ! grep -qi 'serving' <<<"$LOGS"; then
  echo "FAIL: the log stream shows no sign the server handled anything — an"
  echo "      absence asserted against an empty log is not evidence."
  echo "$LOGS" | tail -20
  fail=1
fi

if [ "$fail" -eq 0 ]; then
  echo "ok — server served the requests; no client IP, no forwarded-for value,"
  echo "     and no health-route line anywhere in the log stream"
  echo "     ($(wc -l <<<"$LOGS") log lines inspected)"
fi
exit $fail
