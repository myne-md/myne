#!/usr/bin/env node
// Container start-up: turn the runtime sync-origin configuration into the
// header block the server will send (phase3-web-client tasks 49, 50, 55).
//
// Runs BEFORE the server starts. If `MYNE_SYNC_ORIGIN` is missing or malformed
// this exits non-zero with a message naming the problem, and the container
// never serves anything — because the alternative is a client that boots,
// looks fine, and cannot reach its sync server, or worse, one serving a policy
// with a hole where the origin should be.
//
// The policy logic itself lives in `web/csp.ts` so it is unit-tested
// (`tests/web/csp.test.ts`) rather than only exercised by starting a container.

import { writeFileSync } from "node:fs";
import { securityHeaders } from "./csp.js";

const origin = process.env.MYNE_SYNC_ORIGIN ?? "";
const out = process.argv[2];
// The same value, written where the CLIENT can read it. Two outputs from one
// input on purpose: the CSP names the origin the browser is ALLOWED to reach
// and this document names the origin the client actually reaches, and a client
// making requests its own policy blocks is what two independent writers of one
// value eventually produce.
const configOut = process.argv[3];

if (!out) {
  console.error("usage: generate-headers.mjs <output-caddy-snippet> [output-config-json]");
  process.exit(2);
}

let headers;
try {
  headers = securityHeaders({ syncOrigin: origin });
} catch (e) {
  console.error(`
myne-web: refusing to start.

  ${e instanceof Error ? e.message : String(e)}

Set MYNE_SYNC_ORIGIN to the origin of the sync server this client should talk
to — scheme, host and optional port, nothing else:

  MYNE_SYNC_ORIGIN=https://sync.example.org

It is runtime configuration rather than a build-time constant on purpose: the
bundle you run must be byte-identical to the published one so its hash can be
verified (myne-agents/docs/self-host-web.md). Baking your server's address into it would
make every self-hoster's bundle unique and that verification impossible.
`);
  process.exit(1);
}

// Emitted in the BLOCK form — `"Name" "value"` — because the Caddyfile imports
// this inside a `header { … }` block, next to its own `?Cache-Control` line.
//
// It used to emit the top-level form (`header "Name" "value"`) and that shipped
// a container serving NONE of these headers: inside a block, the first token is
// the header NAME, so every line set a header literally called `header` and
// Caddy accepted the file without a word. The failure is invisible from inside
// the container and total from outside it — no CSP, no COOP, no COEP — which is
// why `scripts/check-web-container-headers.sh` now asserts the response of a
// real container rather than the output of `securityHeaders()`.
writeFileSync(
  out,
  Object.entries(headers)
    .map(([k, v]) => `\t${JSON.stringify(k)} ${JSON.stringify(v)}`)
    .join("\n") + "\n",
);
// Written only after `securityHeaders` has accepted the origin above, so the
// document can never carry a value the policy rejected.
if (configOut) {
  writeFileSync(configOut, JSON.stringify({ sync_origin: origin }) + "\n");
}

console.error(`myne-web: security headers generated for sync origin ${origin}`);
