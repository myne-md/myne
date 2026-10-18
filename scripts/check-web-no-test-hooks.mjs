#!/usr/bin/env node
// No production test hooks in the served bundle (phase3-web-client task 105).
//
// `e2e/AGENTS.md`'s second non-negotiable, inherited by the web lane: at-rest
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
// The same reason `check-web-third-party.mjs` does. A hook can be added under a
// `import.meta.env.DEV` guard that a reviewer reads as safe and a misconfigured
// build ships anyway; a hook can arrive inside a dependency; a hook can be
// introduced by a bundler plugin. Reading the bytes that will be served is the
// only check that covers all three.

import { readdirSync, readFileSync, existsSync, statSync } from "node:fs";
import {
  partitionAssets,
  unknownExtensionMessage,
} from "./lib/scanned-assets.mjs";
import { join } from "node:path";

const DIST = process.argv[2] ?? "web/dist";

/**
 * The Worker host bridges the wasm module resolves by exact namespace
 * (`web/wasm/src/{opfs,sync_transport,attachment_url}.rs` — `js_namespace =
 * ["globalThis", "__myne…"]`). Each is a required IO seam, not a hook — but each
 * is also exactly the shape a hook would take, so a FOURTH one has to be argued
 * for here rather than pass silently. That cost is deliberate.
 *
 * Name-exact on purpose: `__myneOpfsDebug` is not `__myneOpfs`.
 */
const ALLOWED_GLOBALS = new Set(["__myneOpfs", "__myneSyncHttp", "__myneAttachmentUrl"]);

/**
 * Patterns that would each be a backdoor, with what each one is.
 *
 * Deliberately NOT a generic "any `window.__*`" scan: minifiers emit
 * double-underscore names of their own, and a guard that cries wolf on those
 * gets an allowlist and then gets ignored. Each entry here names a shape this
 * project would plausibly reach for.
 *
 * The `__myne*` entry is NOT that generic scan (#387). It names this project's
 * own namespace, which no minifier emits, and its legitimate members are
 * enumerated in `ALLOWED_GLOBALS` rather than implied by a shape. It used to
 * read `window.__myne` — a spelling that appears nowhere in this tree except
 * that line, while three `globalThis.__myne*` bridges ship — so the repo's only
 * artefact-level control on the TB11 delivery channel would have waved through a
 * diagnostic hook written in the codebase's own idiom. In a page context
 * `globalThis === window`, so the host object was never the discriminator.
 *
 * No `window|globalThis|self` prefix is required, for the same reason the
 * namespace is safe to match bare: a minifier that aliases `globalThis` to a
 * short identifier would blind a prefixed pattern, and the bare one finds
 * exactly the same names today.
 */
const FORBIDDEN = [
  [/window\.__test\b/, "`window.__test` — the classic hook the desktop lane's rule names"],
  [/__TEST_HOOKS__/, "a `__TEST_HOOKS__` bag"],
  [
    /(__myne[A-Za-z0-9_$]*)/g,
    "a `__myne*` escape hatch reaching the bundle",
    ALLOWED_GLOBALS,
  ],
  [
    /["'`]\?test-stage=/,
    "a `?test-stage=` query-parameter backdoor — `src/AGENTS.md` records that this " +
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

/** Every served file, fail-closed on an unclassified extension (#273).
 *
 *  This read `.js` and `.html`, so a hook shipped inside the `.mjs` worker
 *  chunk — a hook any script on the page can call, which is the whole reason
 *  this guard exists — went unseen. */
function files(dir) {
  const { scan, unknown } = partitionAssets(dir);
  if (unknown.length > 0) {
    console.error(unknownExtensionMessage(unknown));
    process.exit(1);
  }
  return scan;
}

const hits = [];
for (const file of files(DIST)) {
  const text = readFileSync(file, "utf8");
  for (const [re, why, allowed] of FORBIDDEN) {
    if (!allowed) {
      if (re.test(text)) hits.push({ file, why });
      continue;
    }
    // Allowlisted patterns are decided by the IDENTIFIER, not by the shape —
    // the pattern matches every member of the namespace so a new one cannot
    // hide, and only the named bridges are dropped. Naming the offender is what
    // makes the failure actionable: "a `__myne*` escape hatch" alone does not
    // tell the developer which name to argue for.
    // One hit per distinct IDENTIFIER per file, rather than the one-per-pattern
    // the boolean arm above gives: the question an allowlist failure asks is
    // which NAMES to argue for, and stopping at the first hides the rest.
    const named = new Set();
    for (const m of text.matchAll(re)) {
      if (allowed.has(m[1]) || named.has(m[1])) continue;
      named.add(m[1]);
      hits.push({ file, why: `${why} — \`${m[1]}\`` });
    }
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
directory (e2e-web/AGENTS.md, non-negotiable 2).`);
  process.exit(1);
}

console.log(`web test-hook check: ok (${files(DIST).length} emitted file(s), ${FORBIDDEN.length} pattern(s))`);
