#!/usr/bin/env node
// No production test hooks in the served bundle (phase3-web-client task 105).
//
// `e2e/CLAUDE.md`'s second non-negotiable, inherited by the web lane: at-rest
// state is arranged by writing FIXTURE BYTES, never by a backdoor the app ships.
// The rule exists because a test hook is indistinguishable from an attack
// surface — a `window.__test.unlock(...)` that a scenario calls is a
// `window.__test.unlock(...)` that any script on the page can call, and on this
// client "any script on the page" is the whole threat model (TB11).
//
// The desktop lane can lean on Tauri's ACL for part of this. A browser cannot:
// everything the bundle defines on `window` is reachable by anything that gets
// script execution, so the only durable guarantee is that the hooks are not
// there.
//
// # Why this greps the ARTEFACT and not the source
//
// The same reason `check-web-no-phrase.mjs` does. A hook can be added under a
// `import.meta.env.DEV` guard that a reviewer reads as safe and a misconfigured
// build ships anyway; a hook can arrive inside a dependency; a hook can be
// introduced by a bundler plugin. Reading the bytes that will be served is the
// only check that covers all three.

import { readdirSync, readFileSync, existsSync, statSync } from "node:fs";
import { join } from "node:path";

const DIST = process.argv[2] ?? "web/dist";

/**
 * Patterns that would each be a backdoor, with what each one is.
 *
 * Deliberately NOT a generic "any `window.__*`" scan: minifiers emit
 * double-underscore names of their own, and a guard that cries wolf on those
 * gets an allowlist and then gets ignored. Each entry here names a shape this
 * project would plausibly reach for.
 */
const FORBIDDEN = [
  [/window\.__test\b/, "`window.__test` — the classic hook the desktop lane's rule names"],
  [/__TEST_HOOKS__/, "a `__TEST_HOOKS__` bag"],
  [/window\.__myne\b/i, "a `window.__myne` escape hatch"],
  [
    /["'`]\?test-stage=/,
    "a `?test-stage=` query-parameter backdoor — `src/CLAUDE.md` records that this " +
      "was considered for the desktop app and REFUSED (dev may not bypass production guards)",
  ],
  [
    /["'`]e2e["'`]\s*[,:)]/,
    "a literal `e2e` flag reaching the bundle — usually a mode switch that should not ship",
  ],
];

if (!existsSync(DIST)) {
  console.error(`web test-hook check: no bundle at ${DIST} — run \`pnpm web:build\` first.`);
  process.exit(2);
}

/** Every emitted JS/HTML file, walked. */
function files(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) out.push(...files(full));
    else if (/\.(js|html)$/.test(name)) out.push(full);
  }
  return out;
}

const hits = [];
for (const file of files(DIST)) {
  const text = readFileSync(file, "utf8");
  for (const [re, why] of FORBIDDEN) {
    if (re.test(text)) hits.push({ file, why });
  }
}

if (hits.length > 0) {
  console.error("web bundle carries a PRODUCTION TEST HOOK:\n");
  for (const h of hits) console.error(`  ${h.file}\n      ${h.why}`);
  console.error(`
A test hook in a served bundle is not a testing convenience, it is an API. Any
script that gets execution on the page can call it, and on this client that is
the whole threat model (threat-model.md TB11).

Arrange at-rest state by writing FIXTURE BYTES into OPFS before the app boots —
the browser analogue of the desktop lane's byte surgery on a seeded vault
directory (e2e-web/CLAUDE.md, non-negotiable 2).`);
  process.exit(1);
}

console.log(`web test-hook check: ok (${files(DIST).length} emitted file(s), ${FORBIDDEN.length} pattern(s))`);
