#!/usr/bin/env node
// The recovery phrase as a DEVICE-ENROLMENT CREDENTIAL must be ABSENT from the
// web bundle, not hidden (phase3-web-client task 32; narrowed 2026-08-15).
//
// # The bar moved, and this file is the record of what it moved to
//
// This guard used to assert that the phrase was absent from the served bundle
// ENTIRELY: creation's display grid, recovery's entry grid, enrolment's
// credential grid, and the BIP-39 wordlist behind all three. `decisions.md`
// 2026-07-26 made that normative and this file enforced it on the artefact.
//
// `decisions.md` 2026-08-15 reverses two thirds of it. Account creation and
// phrase recovery SHIP on the web client, so the first two markers and the
// wordlist would now fire on a correct build, and a guard that fires on a
// correct build is a guard that gets deleted. What survives is the third path,
// and it survives on its own merits rather than as a leftover.
//
// # Why the enrolment credential is the one that stays
//
// Not portability: `plugin:sync|sync_enroll` is dispatched on web and the
// credential would work. Enrolment is a ROUTINE action that already accepts
// account number plus master password, and every routine use of the phrase in a
// page is what teaches a user that typing 24 words into a browser is normal.
// That training is the entire mechanism behind `threat-model.md` A18
// (credential phishing), which the 2026-08-15 reversal accepts as its cost and
// bounds by exactly one rule: this client asks for the phrase in ONE situation,
// a recovery the user started themselves. Never to add a device, never to sign
// in. This grep is what keeps that sentence true on the artefact rather than in
// the source.
//
// # One marker is the whole assertion now, and that is deliberate
//
// A single needle looks thin next to the four it replaces. It is not thinner
// than the property being asserted: three of the four described paths that are
// now supposed to ship. Adding a marker back to make the list look substantial
// would assert something false.
//
// # Why a grep over the built output, and not a test
//
// Every other check in this repo asks a question about source. This one asks a
// question about the **artefact**: "is this code in the file we serve?" A unit
// test cannot answer it — the module can be imported, tree-shaken or not,
// reachable or not, and the test would pass either way. What is shipped is a
// property of `web/dist`, so `web/dist` is what gets read.
//
// # Why the bar is absence rather than unreachability
//
// `decisions.md` 2026-08-15 keeps the enrolment credential off this client as a
// DECIDED ABSENCE, not as a port that is owed. `protocol.md` §7 is why the bar
// is absence rather than a runtime gate: the phrase survives every password
// change and there is no rotation command, so a single exposure is permanent
// and has no in-app remedy. Against that, "the route is hidden" is not a
// mitigation — the code would still be in the bundle, one devtools breakpoint
// or one edited route away.
//
// # What it looks for
//
// A marker that exists only on the enrolment phrase path, and it is a string the
// bundler cannot rename — a `data-testid` — because minification renames
// identifiers but not string literals.
//
// The wordlist marker that used to live here (`"zoo"`, BIP-39's last entry) is
// GONE on purpose: creation and recovery both ship, both need the wordlist, and
// a marker that fires on a correct build is worse than no marker at all.

import { readdirSync, readFileSync, statSync } from "node:fs";
import {
  partitionAssets,
  unknownExtensionMessage,
} from "./lib/scanned-assets.mjs";
import { join } from "node:path";

const DIST = join("web", "dist");

/**
 * Each marker names what its presence would mean. The message is the finding,
 * not "grep matched" — a future reader needs to know which path leaked.
 */
const MARKERS = [
  {
    needle: "member-roster.phrase-input",
    meaning:
      "the B2B member-identity phrase prompt (myne-md/myne#698). Unlocking a " +
      "member identity to send an invite is neither a recovery nor creation, so " +
      "it is the fifth phrase path and the one that must never reach served " +
      "code. It is substituted out of the bundle at build time " +
      "(`web/vite.config.ts`), the same mechanism as the enrolment and import " +
      "grids; this needle is what makes that absence a checked property",
  },
  {
    needle: "sync.enroll.phrase-cell",
    meaning:
      "the device-enrolment phrase credential — the third phrase path, and the " +
      "one that is easy to miss because that screen is about adding a device",
  },
  {
    needle: "import-myne.phrase-cell",
    meaning:
      "the vault-import SOURCE credential (myne-md/myne#464), the fourth phrase " +
      "path and the one this file's own rationale was cited to justify. The " +
      "import setup step takes the other vault's password OR its 24 words, and " +
      "an import is a ROUTINE action, which is exactly the training " +
      "`decisions.md` 2026-08-15 bounds this client against on `threat-model.md` " +
      "A18: web asks for the phrase in ONE situation, a recovery the user " +
      "started themselves",
  },
];

// Why the list GREW rather than the three surfaces sharing one needle. Each of
// the three implements the same 24-cell grid separately and carries its own
// `data-testid` precisely so this file can tell them apart in the artefact: a
// shared testid would make one entry cover three modules, and the finding would
// then name a path that may not be the one that leaked.
//
// That reasoning is written into `MyneVaultSetup.tsx`, into `web/vite.config.ts`
// and into `recovery-flow.md` §3.2, all three of which cite THIS guard as the
// reason they duplicate a component. Landing the surface and not the needle made
// all three citations false at once, and the guard went on printing ok over a
// bundle it was not looking for the new grid in. Found in review on
// myne-md/myne#636; it is the same shape `AGENTS.md` records three times over,
// a check passing on an input it could not see.

// #273: every served byte, fail-closed on an unclassified extension. This read
// `.js` only, so the bundle's 1.2 MB `pdf.worker.min-*.mjs` and 3.9 MB
// `myne_web_wasm_bg-*.wasm` were never checked — by a guard whose entire premise
// is that the phrase is ABSENT from what is served, not merely hidden.
function jsFiles(dir) {
  const { scan, unknown } = partitionAssets(dir);
  if (unknown.length > 0) {
    console.error(unknownExtensionMessage(unknown));
    process.exit(1);
  }
  return scan;
}

let files;
try {
  files = jsFiles(DIST);
} catch {
  console.error(
    `web phrase-absence: ${DIST} does not exist. Run \`pnpm web:build\` first — ` +
      `this check reads the artefact, not the source.`,
  );
  process.exit(1);
}

if (files.length === 0) {
  console.error(`web phrase-absence: no .js under ${DIST} — the scan is broken, not the bundle.`);
  process.exit(1);
}

const findings = [];
for (const file of files) {
  const text = readFileSync(file, "utf8");
  for (const { needle, meaning } of MARKERS) {
    if (text.includes(needle)) findings.push({ file, needle, meaning });
  }
}

if (findings.length > 0) {
  console.error("web phrase-absence: the recovery phrase reached the served bundle.\n");
  for (const { file, needle, meaning } of findings) {
    console.error(`  ${needle}\n      ${meaning}\n      found in: ${file}`);
  }
  console.error(
    `\n  This is a normative violation, not a size regression: decisions.md\n` +
      `  2026-08-15 ships phrase DISPLAY and phrase ENTRY on this client and keeps\n` +
      `  the ENROLMENT credential out, so Myne asks for the phrase in a browser in\n` +
      `  exactly one situation: a recovery the user started themselves. A routine\n` +
      `  phrase prompt is what makes threat-model.md A18 phishing work, and\n` +
      `  protocol.md §7 gives a leaked phrase no remedy — it survives every\n` +
      `  password change and there is no rotation command.\n\n` +
      `  Fix by making the path ABSENT (substitute the module in\n` +
      `  web/vite.config.ts's ABSENT_SCREENS, or gate it on the capability\n` +
      `  descriptor), never by hiding the affordance.`,
  );
  process.exit(1);
}

console.log(
  `web phrase-absence: ok (${files.length} bundled file(s) scanned for ` +
    `${MARKERS.length} phrase markers)`,
);
