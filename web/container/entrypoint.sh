#!/bin/sh
# Fail before serving anything if the deployment is misconfigured
# (phase3-web-client task 50: "misconfigured or missing origin fails startup
# loudly").
set -e
#
# Two outputs: the header snippet Caddy imports, and the `/config.json` the
# CLIENT reads to learn which sync server this deployment talks to (task 50).
# Both from one validated value — see `generate-headers.mjs`.
node /opt/myne/generate-headers.mjs /etc/caddy/security-headers.caddy /srv/web/config.json
exec caddy run --config /etc/caddy/Caddyfile --adapter caddyfile
