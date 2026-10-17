#!/usr/bin/env node
// The adversary-coverage projection + its guard (myne#553).
//
// # The failure this prevents
//
// `docs/threat-model.md` names 19 adversary classes (A1..A19) and 14 trust
// boundaries (TB1..TB14). The myne-range epic exercises them with live
// attack scenarios, and until this guard existed NOTHING related the two: a
// threat-model row could land with no scenario ever written against it, and a
// scenario could be retired with no row the wiser. The binding lives in THIS
// repo rather than the range so it cannot go blind when the companion is
// absent — the silent-skip failure `check-embed-layout-drift.mjs` records
// about the published vectors.
//
// # What the projection is
//
// `docs/dev/adversary-coverage.md` is GENERATED (`--emit`) and holds one row
// per threat-model row, each with a verdict: the `myne-range` scenario that
// exercises it, or a written out-of-scope reason. The verdicts themselves are
// hand-authored here in VERDICTS below — the guard derives the DENOMINATOR from
// the threat model, so a new row with no verdict fails and a verdict whose row
// is gone fails. The companion repo is never read: a scenario NAME is a string
// in this repo, which is the whole point of the projection living here.
//
// # Both directions, because one-directional is the trap
//
//   - a threat-model row with no verdict entry: an adversary nobody has a
//     scenario or a stated reason for. Fails naming the row.
//   - a verdict entry whose row is gone (a renamed/merged/deleted threat-model
//     row): a stale claim about a row that no longer exists. Fails naming the
//     entry, the same arm `check-twin-inventory.mjs` has for its roster.
//
// Zero dependencies, hand-runnable: node scripts/check-adversary-coverage.mjs [--emit|--check]

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const THREAT_MODEL = "docs/threat-model.md";
const PROJECTION = "docs/dev/adversary-coverage.md";

/**
 * The hand-authored verdicts, one per threat-model row. Each value is either
 * `scenario: <myne-range scenario name>` or a written out-of-scope reason.
 * A missing entry for a row is a failure; an entry for a row that does not
 * exist is a failure. Add a row to the threat model and this map owes it a
 * verdict in the same change — that is the binding.
 */
const VERDICTS = {
  A1: "scenario: ui.dishonest-bundle — the served-bundle adversary that replaces the app the user sees; passive-server arms are exercised by disk.relay-at-rest",
  A2: "out of scope: compelled lawful access is a legal process against an operator, not a technical attack a range can exercise; what the range CAN reach is that the server holds nothing to disclose, covered by disk.relay-at-rest",
  A3: "out of scope: a passive network attacker observes TLS traffic the range cannot intercept without being A4 first; disk.relay-at-rest exercises the at-rest half this row rests on",
  A4: "out of scope, and the split matters: the REACHABLE arm (an untrusted issuer, or the right name on the wrong certificate, presented to native sync) is refused by the transport and is exercised over real sockets by myne-core's rustls_transport fixtures, direct and through SOCKS5. The RESIDUAL this row now records after myne#786 (a compromised public CA issuing a certificate the client accepts) is not a shape any range seat can stand up, because a seat cannot control a real CA. The range's server.mitm-pin scenario asserted the retired pin mechanism and is not counted here rather than being credited to either half.",
  A5: "scenario: disk.locked-extraction — the locked-device at-rest attack surface",
  A6: "scenario: ram.autolock-window — the unlocked-device window and its teardown",
  A7: "out of scope: live malware with user privileges defeats client-side encryption by definition; the range exercises the boundaries it can reach (disk, relay, ram) rather than a row that names defeat",
  A8: "out of scope: a compromised transitive dependency ships as part of the honest build; no scenario in the range can distinguish it from the app itself",
  A9: "scenario: disk.artifact-tamper — the downloaded-artifact substitution window",
  A10: "out of scope: a state-level actor with zero-days is not an adversary a local range can stand up; the compensating-controls honesty (§6) is the mitigation this row names and no scenario exercises it",
  A11: "out of scope: an insider's extra access is the served-bundle shape on web (A15's scenario) and none at all on native; ui.dishonest-bundle covers the reachable half",
  A12: "out of scope: rubber-hose cryptanalysis has no technical surface; the row is honest that the user's password IS the data",
  A13: "out of scope: the awareness timing/size leak is verified at the transport level in-repo (e2e/collab-leak-budget.e2e.ts) instead of by a real myne-range scenario (SYNC-48). The mechanism that blocks a range seat: the `myne-range` companion is off-repo and unbuilt in a fresh clone and in CI, so no seat can stand up the awareness timing/size leak. **The verdict this replaced named `relay.traffic-analysis`, and that scenario does not exist in the range** (its scenarios are `disk.locked-extraction`, `ram.autolock-window`, `disk.artifact-tamper`, `disk.relay-at-rest`, `server.rollback`, `server.sync`, `boot.smoke`, `surface.hostile-note`), so the move is a correction rather than a coverage loss: the guard cannot check a companion scenario NAME exists, and a stale name inflates the scenario-backed count. What the in-repo stand-in DOES prove: the emitted frame rate honours the SYNC-5 coalescing floor (at most ~10 frames/s under sustained cursor movement) and the envelope carries no note id. What it does NOT prove: anything about the wire as the server observes it (frame sizes and inter-arrival at the relay), and it cannot substitute for a passive-observer seat. A future change may add the real range scenario.",
  A14: "out of scope: a compromised clipper BUILD is a supply-chain event outside this checkout; the relay arms of the clipper surface are exercised by ui.clip-injection",
  A15: "scenario: ui.dishonest-bundle — the targeted web-bundle substitution; first-delivery only, as the row says",
  A16: "out of scope: an unprivileged same-machine peer reaching a user-installed runtime is a property of a daemon Myne does not ship; the disclosure this row names is the mitigation and no range scenario exercises a third-party daemon",
  A17: "out of scope: the provider operator legitimately receives the plaintext; A17 is the row that SAYS this is outside anything Myne can constrain, so a scenario claiming to exercise it would contradict the row",
  A18: "scenario: ui.phish-origin — the lookalike-origin phrase capture",
  A19: "out of scope: a third-party extension with host permissions reads the DOM from outside the page; no in-page scenario can see its reader, which is what the row itself says",
  TB1: "out of scope: the user's memory is not a system boundary a range can attack; the coercion arms of it are A12's territory",
  TB2: "scenario: ram.process-scrape — the process boundary the ram seat attacks",
  TB3: "scenario: disk.locked-extraction — the local on-disk storage boundary",
  TB4: "out of scope: the boundary is verified TLS and no seat can subvert a public CA, which is the only remaining native transport attack (A4). What a seat CAN present (a self-signed or foreign-CA certificate for the configured hostname) native sync refuses, and myne-core's TLS fixtures drive exactly that over a real socket, including inside the Tor tunnel. The retired server.mitm-pin scenario tested the retired mechanism and is not counted here.",
  TB5: "scenario: relay.curious-server — the sync-server boundary over live blobs",
  TB6: "scenario: server.fs — the server's persistent storage read directly",
  TB7: "scenario: disk.artifact-tamper — the distribution channel whose artifacts persist",
  TB8: "out of scope: the build pipeline and signing keys are outside every range seat; the row's honesty about them is the mitigation",
  TB9: "out of scope: third-party dependency compromise ships inside the honest build (A8's territory); no seat can distinguish it",
  TB10: "scenario: ui.clip-injection — the keyless clipper bridge with hostile input",
  TB11: "scenario: ui.dishonest-bundle — the served-bundle boundary on every page load",
  TB12: "scenario: ram.runtime-loopback — the local model runtime over loopback",
  TB13: "scenario: relay.provider-egress — the remote AI provider boundary and its consent gate",
  TB14: "out of scope for a myne-range seat: TB14 is the client's inbound fetch from Myne's own artefact origin, so impersonating that origin needs either control of Myne infrastructure or a public CA the row already assumes away (A9/A4). The one arm a seat could stand up, an origin or MITM serving bytes that do not match the compiled-in digest, is refused before anything is registered and is driven end to end by the in-repo desktop E2E scenario `ai-model-download` mdo3 (the fixture origin serves corrupted bytes and the refusal is named); no myne-range scenario exercises this boundary yet.",
};

/** The row IDs the threat model actually declares, in document order. */
export function parseThreatModelRows(text) {
  const rows = [];
  const seen = new Set();
  for (const m of text.matchAll(/^\| ((?:A|TB)\d+) \|/gm)) {
    if (seen.has(m[1])) continue; // a repeated id is a threat-model defect, not a denominator
    seen.add(m[1]);
    rows.push(m[1]);
  }
  return rows;
}

/** The verdict keys, sorted for the both-directions compare. */
function verdictKeys() {
  return Object.keys(VERDICTS).sort();
}

function failures(rows) {
  const out = [];
  const declared = new Set(rows);
  for (const row of rows) {
    if (!(row in VERDICTS)) {
      out.push(
        `${row} is declared in ${THREAT_MODEL} with no verdict in this guard's ` +
          `VERDICTS map. A new adversary or trust-boundary row lands with a ` +
          `scenario that exercises it or a written out-of-scope reason — the ` +
          `binding is the point (myne#553).`,
      );
    }
  }
  for (const key of verdictKeys()) {
    if (!declared.has(key)) {
      out.push(
        `${key} carries a verdict but ${THREAT_MODEL} declares no such row. ` +
          `A stale verdict is a claim about a row that no longer exists; ` +
          `delete or re-point it.`,
      );
    }
  }
  for (const [row, verdict] of Object.entries(VERDICTS)) {
    if (!verdict.trim()) {
      out.push(`${row} carries an EMPTY verdict. Say the scenario or the reason.`);
    }
  }
  return out;
}

const mode = process.argv[2] ?? "--check";

function renderProjection(rows) {
  const lines = [
    "<!-- GENERATED by scripts/check-adversary-coverage.mjs --emit. Do not edit by hand;",
    "     the verdicts live in that script's VERDICTS map, the denominator in",
    "     docs/threat-model.md, and this file is the projection of the two. -->",
    "",
    "# Adversary coverage projection",
    "",
    `One row per threat-model row (myne#553). Each row carries the \`myne-range\``,
    `scenario that exercises it, or the written reason it is out of scope. The`,
    `binding is the \`check-adversary-coverage\` guard: a threat-model row with no`,
    `verdict fails the commit, and so does a verdict whose row is gone.`,
    "",
    "| Row | Verdict |",
    "|---|---|",
  ];
  for (const row of rows) {
    const verdict = VERDICTS[row] ?? "**MISSING — the guard is red**";
    lines.push(`| \`${row}\` | ${verdict} |`);
  }
  lines.push("");
  return lines.join("\n");
}

function emit() {
  const tm = readFileSync(join(repoRoot, THREAT_MODEL), "utf8");
  const rows = parseThreatModelRows(tm);
  writeFileSync(join(repoRoot, PROJECTION), renderProjection(rows));
  console.log(`adversary-coverage: ${PROJECTION} regenerated (${rows.length} row(s))`);
}

function check() {
  if (!existsSync(join(repoRoot, THREAT_MODEL))) {
    console.error(`adversary-coverage: ${THREAT_MODEL} not found. Wrong tree.`);
    process.exit(1);
  }
  const tm = readFileSync(join(repoRoot, THREAT_MODEL), "utf8");
  const rows = parseThreatModelRows(tm);
  if (rows.length === 0) {
    console.error(
      `adversary-coverage: parsed ZERO threat-model rows from ${THREAT_MODEL}. ` +
        `The parser is broken, not the policy — a denominator of nothing gates nothing.`,
    );
    process.exit(1);
  }
  const found = failures(rows);
  if (found.length > 0) {
    console.error("adversary-coverage: FAILED");
    for (const message of found) console.error(`  - ${message}`);
    process.exit(1);
  }
  // The projection must describe EXACTLY this state — byte-equal to a fresh
  // emit — or a hand edit has drifted from the VERDICTS map the way any
  // generated doc drifts from its source. `includes` would let an appendage
  // through (the twin-inventory projection's own lesson), so this is equality.
  if (!existsSync(join(repoRoot, PROJECTION))) {
    console.error(
      `adversary-coverage: ${PROJECTION} does not exist. Run ` +
        `\`node scripts/check-adversary-coverage.mjs --emit\` and commit it.`,
    );
    process.exit(1);
  }
  const projection = readFileSync(join(repoRoot, PROJECTION), "utf8");
  const fresh = renderProjection(rows);
  if (projection !== fresh) {
    console.error(
      `adversary-coverage: ${PROJECTION} is stale (or hand-edited). Run ` +
        `\`node scripts/check-adversary-coverage.mjs --emit\` and commit the result.`,
    );
    process.exit(1);
  }
  console.log(
    `adversary-coverage: ok (${rows.length} row(s), ` +
      `${rows.filter((r) => VERDICTS[r].startsWith("scenario:")).length} scenario-backed, ` +
      `${rows.filter((r) => VERDICTS[r].startsWith("out of scope:")).length} reasoned out of scope)`,
  );
}

if (mode === "--emit") emit();
else check();
