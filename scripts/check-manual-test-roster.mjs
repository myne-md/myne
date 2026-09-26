#!/usr/bin/env node
// Every feature surface carries a pre-release manual-test verdict, and no verdict
// outlives the files it describes.
//
// THE FAILURE THIS PREVENTS. A release has two halves. CI runs one of them and
// says so out loud; the other one exists only if a human runs it, and nothing in
// this repository has ever been able to answer "what did a human look at before
// we tagged, and what did nobody look at at all?".
//
// That question is not academic here. The desktop E2E suite is 133 files, and the
// 301 scenarios `scripts/e2e-scenario-floor.json` requires to EXECUTE all run in a Linux container against WebKitGTK
// through tauri-driver. So macOS desktop, Windows desktop, Safari, iOS and
// Android have ZERO automated UI coverage, and until this roster existed nothing
// in the tree stated that. Seven manual procedure documents did exist
// (`docs/dev/accessibility-checklist.md`, `docs/dev/tor-verification.md`,
// `docs/dev/clipboard-sensitivity-verification.md`, `docs/dev/clipper-testing.md`,
// `mobile/docs/dev/device-matrix.md`, `mobile/docs/dev/reminders-device-checklist.md`,
// `mobile/docs/dev/sync-test-confidence.md`) and only THREE were reachable from
// the release flow at all. Measured rather than assumed, against every reference
// in `operations/runbooks/release-checklist.md`: it names the accessibility, Tor and
// clipboard-sensitivity documents, and none of the other four, so
// `clipper-testing.md`, `device-matrix.md`, `reminders-device-checklist.md` and
// `sync-test-confidence.md` were orphans nobody opens.
//
// The precedent for what happens next is in this repository too. The CI `e2e`
// step carries `failure: ignore`, so it is not a gate, and v0.4 shipped without
// the E2E suite ever running with nothing recording that fact. A check that is
// not a gate becomes a check that is not run.
//
// WHY A ROSTER AND NOT A CHECKLIST DOCUMENT. A hand-written "every feature" list
// is a second copy of the feature roster. It is right on the day it is written
// and wrong two releases later, and nothing reports the drift, which is exactly
// what `operations/runbooks/release-checklist.md` refuses in its own opening
// ("It links rather than restates"). This file reads the directories instead and
// requires every file in them to be accounted for, the same argument
// `scripts/check-web-screens.mjs` and `scripts/check-twin-inventory.mjs` make.
//
// WHAT EARNS A MANUAL ITEM. Only an observation a machine cannot honestly make.
// Every item here is meant to be a ship gate, and passing a failed one takes a
// written override recorded against the entry. That makes every item a recurring
// cost on a single maintainer's release day, so an item a tauri-driver scenario
// could have asserted is not merely redundant, it is a permanent false gate.
// Rule 3 below is that discipline made checkable: a `whyNotAutomated` reason has
// to NAME THE MECHANISM that blocks a driver, and a vague one fails rather than
// passing quietly.
//
// WHY THE DENOMINATOR IS A NAMED ROSTER AND ALSO IMPORTS `presentSharedRoots()`.
// `scripts/lib/shared-roots.mjs` is the one roster of shared trees, and its rule
// is that a guard claiming shared-tree scope imports it while a guard scoping
// narrower says so in its own header. This one does both, and that is not a
// contradiction: `DENOMINATORS` names the directories that are SURFACES a tester
// walks, and `presentSharedRoots()` is then used to assert that no shared tree
// grew one of those directories without joining the roster. A sweep of every
// shared tree would add thousands of leaf modules no tester walks individually,
// and a denominator nobody can hold is a denominator that gets exempted
// wholesale. But a denominator blind to a whole client is worse, and that was
// this file on its first day: it named `src/` only, so `web/src/screens/` and
// `mobile/src/screens/` sat outside it while the success line read `ok`, which is
// the failure `scripts/check-prefs-nonce.mjs` records for its own roster.
//
// USAGE
//   node scripts/check-manual-test-roster.mjs            (the gate)
//   node scripts/check-manual-test-roster.mjs --emit      (regenerate the projection)
//   node scripts/check-manual-test-roster.mjs --check     (gate the projection too)
//   node scripts/check-manual-test-roster.mjs --record    (lock in a ratchet improvement)
//
// `analyse(io)` takes its whole world as an argument so `tests/scripts/manualTestRoster.test.ts`
// can inject each defect class as a synthetic input rather than mutating the real
// tree. Verifying a guard means breaking it, and that file is the proof this one
// still catches what it caught before.

import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { presentSharedRoots } from "./lib/shared-roots.mjs";
import { TS_FILES, walkFiles } from "./lib/surface-files.mjs";

// `fileURLToPath` rather than `new URL(...).pathname`, and the difference is not
// cosmetic. `.pathname` keeps percent-encoding, so a checkout under a path with a
// space or a non-ASCII character resolves to a directory that does not exist, and
// the same encoding mismatch made the entry-point guard below compare an encoded
// URL against a raw argv path: the script would parse, export, and exit 0 having
// run nothing. For a `pre-commit` gate that is the silent-green class this file's
// own header calls the worst failure mode. `check-ipc-binding-callers.mjs`,
// `check-frontend-lock-teardown.mjs` and `check-mobile-export-backup.mjs` all use
// this form for the same reason.
const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

/** Every client surface an entry or a manual item may name. */
export const CLIENTS = Object.freeze([
  "desktop-macos",
  "desktop-linux",
  "desktop-windows",
  "web",
  "ios",
  "android",
  "cli",
  "clipper",
]);

/** The two tiers. `core` is data loss, a security or privacy boundary, or the upgrade over a real vault. */
export const TIERS = Object.freeze(["core", "standard"]);

/**
 * A reason shorter than this is not a reason.
 *
 * Deliberately higher than the neighbours (`check-ipc-binding-callers.mjs` uses
 * 12, `check-frontend-lock-teardown.mjs` 20) and the difference is the subject:
 * those fields say why one module is exempt from one rule, this one has to name a
 * mechanism specifically enough that a reader can disagree with it.
 */
export const MIN_REASON_CHARS = 40;

/**
 * Phrases that describe the difficulty rather than the mechanism.
 *
 * This is the one rule here that judges CONTENT, and it is worth the false
 * positives it may cost. "Hard to automate" is the sentence an author writes when
 * they have not asked whether a driver could do it, and it is indistinguishable
 * in review from a real finding.
 *
 * A DENYLIST RATHER THAN AN ALLOWLIST OF MECHANISM NOUNS, and that was MEASURED
 * rather than assumed. Review proposed the positive half: require every reason to
 * name something from a vocabulary (`WKWebView`, `safaridriver`, `Keychain`,
 * `physical device`, and so on), on the argument that the reasons already read
 * that way so it would land green. Run in the myne-md/myne#548 review against the
 * 374 reasons the roster held that day, with a 120-term vocabulary, **41 failed**, and reading those 41 they are among the
 * best reasons in the file: `visualViewport`, the W3C Actions API never producing
 * `compositionstart`, the engine's own bidi algorithm, `xvfb` with no window
 * manager, `SCHEDULE_EXACT_ALARM` granted on a system settings screen. A
 * vocabulary long enough to admit those admits anything, and a shorter one
 * teaches authors to keyword-stuff a sentence that already said the right thing.
 * So the rule stays one-directional on purpose. That is the exception to this
 * file's own compare-both-ways discipline, stated here rather than left to be
 * discovered.
 *
 * Matched case-insensitively against the whole reason.
 */
export const VAGUE_REASONS = Object.freeze([
  "hard to automate",
  "difficult to automate",
  "cannot be automated",
  "not automatable",
  "needs a human",
  "requires a human",
  "human judgement",
  "human judgment",
  "manual only",
  "too flaky",
  "flaky in ci",
  "ui is visual",
  "visual check",
  "just look",
  "n/a",
  "tbd",
]);

/** The denominator: the directories whose every file needs a verdict. */
export const DENOMINATORS = Object.freeze([
  { dir: join("src", "screens"), extensions: TS_FILES },
  { dir: join("src", "components", "settings"), extensions: TS_FILES },
  { dir: join("web", "src", "screens"), extensions: TS_FILES },
  { dir: join("web", "src", "components", "settings"), extensions: TS_FILES },
  // Mobile's real surfaces. NOT `mobile/src/screens/`, which is the design
  // gallery (see NOT_A_SURFACE_ROSTER). Added after review found that a new
  // mobile flow file entered the tree with nothing failing: Rule 1 catches a
  // DELETED one, and until this line nothing caught a new one, while
  // `AGENTS.md` named this directory as mobile's surfaces in the same sentence
  // that claimed a surface entering the tree fails by name.
  { dir: join("mobile", "src", "app", "flows"), extensions: TS_FILES },
  { dir: "e2e", extensions: /\.e2e\.ts$/ },
]);

/** The surface subdirectories a shared root may grow. Each one found must be on `DENOMINATORS`. */
export const SURFACE_SUBDIRS = Object.freeze(["screens", join("components", "settings")]);

/**
 * Directories that look like a surface roster and are not one.
 *
 * `mobile/src/screens/` is the DESIGN GALLERY, not the app: every module there
 * exports `ScreenDef[]` for `mobile/src/gallery/registry.tsx` to render inside a
 * device frame, and `mobile/src/gallery/types.ts` calls an entry "a single
 * design-board entry". The mobile client's real surfaces are
 * `mobile/src/app/flows/`, which the roster claims by path. Walking the gallery
 * would put 16 design boards into a release gate and say nothing about the app.
 *
 * Named with a reason rather than silently skipped, because the coverage
 * assertion below exists precisely to make an unwalked tree argue for itself.
 */
export const NOT_A_SURFACE_ROSTER = Object.freeze({
  "mobile/src/screens":
    "The mobile design gallery, not the app. Its modules export ScreenDef[] for mobile/src/gallery/registry.tsx to render inside a device frame; the client's real surfaces are mobile/src/app/flows/, which is a denominator in its own right.",
});

/**
 * Files in the denominator directories that are not themselves a surface.
 *
 * WHY THIS LIVES IN THE GUARD AND NOT AS A MARKER IN THE FILE. Membership is an
 * EXEMPTION, so deriving it from a declaration in the subject file would let any
 * new file license itself out of the denominator by naming a pragma. That is
 * `scripts/check-prefs-nonce.mjs`'s recorded argument for keeping `PREFS_MODULES`
 * a named list, and it is the dominant shape here: seven of the nine comparable
 * guards hold their exemptions inline, and no guard in this repository reads an
 * exemption marker out of the file it is judging.
 *
 * Each entry states why, the reason is length- and vagueness-checked like every
 * other reason in this file, and an entry whose file is gone fails as stale.
 */
export const NOT_A_SURFACE = Object.freeze({
  "src/screens/editorLayout.tsx": "Layout primitive for the editor screen; covered by the editor entries.",
  "src/screens/layoutClamp.ts": "Pure geometry helper, no rendered surface, covered by unit tests.",
  "src/screens/responsiveCollapse.ts": "Pure breakpoint helper, no rendered surface, covered by unit tests.",
  "src/screens/titlebar.ts": "Window-chrome helper; the chrome itself is an entry, this module is not a surface.",
  "web/src/screens/titlebar.ts": "The web twin of the desktop window-chrome helper, and not a surface for the same reason.",
  "src/components/settings/panel-styles.ts": "Style constants shared by the panels; renders nothing.",
  "src/components/settings/browser-icons.tsx":
    "Icon set used by the connected-extensions panel; renders no surface of its own.",
  "src/components/settings/ControlBlock.tsx": "Layout primitive every panel composes; it has no settings of its own.",
});

const isVague = (reason) => {
  const hay = reason.toLowerCase();
  return VAGUE_REASONS.filter((phrase) => hay.includes(phrase));
};

/** Minutes to a one-decimal hour figure. One implementation, because six renderings disagreed. */
export const hours = (m) => Math.round(m / 6) / 10;

/**
 * Does this observation, on this client, stop the tag today?
 *
 * THE ONE IMPLEMENTATION, exported because `scripts/manual-test-plan.mjs` needs
 * the identical answer in two more places: the `STOPS THE TAG` marks in the
 * generated plan, and `--record`'s exit code. Three copies of this predicate is
 * three places it can disagree, the disagreement is invisible because each one
 * prints a plausible answer, and the third copy is what decides whether a release
 * ships.
 *
 * `ratchet` is required rather than defaulted. The two callers wanted opposite
 * fallbacks (the guard skipped the ratchet rules, the plan treated every row as
 * gating), and a default would have picked one of them for both without anyone
 * choosing.
 */
export function gates(item, client, ratchet) {
  return ratchet.gatedTiers.includes(item.tier) && ratchet.gatedClients.includes(client);
}

/** Minutes of manual work in total, counted per (item, client). */
export function totalMinutes(roster) {
  return roster.reduce(
    (n, e) => n + (e.manual || []).reduce((m, i) => m + (i.estimateMin || 0) * (i.clients || []).length, 0),
    0,
  );
}

/** Minutes that actually stop a release today, per the recorded ratchet. */
export function gatedMinutes(roster, ratchet) {
  if (!ratchet) return 0;
  return roster.reduce(
    (n, e) =>
      n +
      (e.manual || []).reduce(
        (m, item) => m + (item.estimateMin || 0) * (item.clients || []).filter((c) => gates(item, c, ratchet)).length,
        0,
      ),
    0,
  );
}

/** Every figure this file prints, computed once. */
export function counts(roster, ratchet) {
  return {
    entries: roster.length,
    manualItems: roster.reduce((n, e) => n + (e.manual || []).length, 0),
    coreItems: roster.reduce((n, e) => n + (e.manual || []).filter((m) => m.tier === "core").length, 0),
    exempt: roster.filter((e) => (e.manual || []).length === 0).length,
    totalMinutes: totalMinutes(roster),
    gatedMinutes: gatedMinutes(roster, ratchet),
  };
}

/**
 * The gate policy this branch may never fall below.
 *
 * Kept HERE rather than in the JSON on purpose. The JSON says what the gate
 * covers today; this says what it may never stop covering, and a narrowing edit
 * therefore has to touch two files with two different rationales, one of which
 * is code under review. A ratchet whose floor lives in the same file as the
 * value it bounds is a ratchet you can lower in one line.
 *
 * Widening is a note plus an edit here. Narrowing is a decision entry.
 */
export const RATCHET_BASELINE = Object.freeze({
  gatedTiers: ["core"],
  gatedClients: ["desktop-macos", "desktop-linux", "ios", "android", "web", "cli", "clipper"],
});

/**
 * The recorded gate from `scripts/manual-test-ratchet.json`.
 *
 * @typedef {object} Ratchet
 * @property {string[]} gatedTiers           which tiers block a release today; may only grow
 * @property {string[]} gatedClients         which client surfaces those tiers block on; may only grow
 * @property {number}   totalMinutesCeiling  minutes of manual work in total; `--record`
 *                                           lowers it, a raise is an argued hand edit
 * @property {number}   gatedMinutes         minutes that block a release; may not fall by MORE than
 *                                           the ceiling does, which is what stops a core item being
 *                                           retiered out of the gate while the work stays in the roster
 */

/**
 * Shared trees that grew a surface directory without joining `DENOMINATORS`.
 *
 * The check `scripts/check-platform-seam.mjs` calls "deriving a coverage claim":
 * a tree outside every denominator fails BY NAME instead of being silently
 * skipped while the success line still reads `ok`.
 */
/** @param {Record<string, string>} [exempt] */
export function coverageGaps(roots, dirExists, exempt = NOT_A_SURFACE_ROSTER) {
  const named = new Set(DENOMINATORS.map((d) => d.dir));
  const unwalked = [];
  for (const root of roots) {
    for (const sub of SURFACE_SUBDIRS) {
      const dir = join(root, sub);
      if (dirExists(dir) && !named.has(dir) && !exempt[dir]) unwalked.push(dir);
    }
  }
  // Both directions, like every other roster here: an exemption whose directory
  // is gone, or which now names a walked denominator, has stopped describing
  // anything and would quietly outlive its subject.
  const stale = Object.keys(exempt).filter((dir) => !dirExists(dir) || named.has(dir));
  // And its reasons are held to the same bar as every other reason in this file.
  // Review noted that "stated reason" was a convention here rather than a check,
  // which is precisely the shape `MIN_REASON_CHARS` exists to refuse elsewhere.
  const unreasoned = Object.entries(exempt)
    .filter(([, reason]) => (reason || "").trim().length < MIN_REASON_CHARS || isVague(reason || "").length)
    .map(([dir]) => dir);
  return { unwalked, stale, unreasoned };
}

/**
 * The whole check, over an injected world.
 *
 * @param {object} io
 * @param {Array}  io.roster        the entries, as `scripts/manual-test-roster.mjs` exports them
 * @param {string[]} io.files       repo-relative paths of every denominator file except the scenarios
 * @param {string[]} io.e2eFiles    repo-relative paths of the `e2e` scenario files
 * @param {(p: string) => boolean} io.pathExists  does this repo-relative path exist
 * @param {object} io.verified      `{ [entryId]: { version, date, verdict, reason? } }`
 * @param {Ratchet|null} io.ratchet the recorded pair, or an explicit `null` to skip the ratchet rules.
 *                                  REQUIRED as a key: a default here would be the arm that never
 *                                  fires, excusing a future caller from Rule 5 without anyone
 *                                  choosing it (`AGENTS.md`, myne-md/myne#533).
 * @param {object} [io.notASurface] the exemption map; defaults to the module's own
 * @param {Array}  [io.denominators] the denominator roster; defaults to {@link DENOMINATORS}
 * @param {{gatedTiers: string[], gatedClients: string[]}} [io.baseline] the gate floor; defaults to {@link RATCHET_BASELINE}
 * @param {string[]} [io.missingRoots] shared roots absent from the checkout
 * @param {{unwalked: string[], stale: string[], unreasoned?: string[]}} [io.coverage]  from {@link coverageGaps}
 * @returns {{ failures: string[], notes: string[], warnings: string[], stats: object }}
 */
export function analyse(io) {
  if (!("ratchet" in io)) {
    throw new Error("analyse: `ratchet` is required. Pass the recorded pair, or `null` to opt out explicitly.");
  }
  const failures = [];
  const notes = [];
  const warnings = [];
  const roster = io.roster || [];
  const notASurface = io.notASurface || NOT_A_SURFACE;

  // --- Rule 0: the entries are well formed at all. -------------------------
  const seenIds = new Set();
  for (const entry of roster) {
    const id = entry.id;
    if (typeof id !== "string" || !/^[a-z0-9]+(?:[.-][a-z0-9]+)*$/.test(id)) {
      failures.push(`entry id is not a dotted lowercase slug: ${JSON.stringify(id)}`);
      continue;
    }
    if (seenIds.has(id)) failures.push(`duplicate entry id: ${id}`);
    seenIds.add(id);

    if (!entry.title) failures.push(`${id}: no title`);
    if (!Array.isArray(entry.paths) || entry.paths.length === 0) {
      failures.push(`${id}: no paths, so nothing ties this entry to the tree`);
    }
    for (const client of entry.clients || []) {
      if (!CLIENTS.includes(client)) failures.push(`${id}: unknown client ${JSON.stringify(client)}`);
    }
    if (!Array.isArray(entry.clients) || entry.clients.length === 0) {
      failures.push(`${id}: no clients, so no plan can ever schedule it`);
    }
  }

  // --- Rule 1: no verdict outlives its files. ------------------------------
  for (const entry of roster) {
    for (const p of entry.paths || []) {
      if (!io.pathExists(p)) {
        failures.push(
          `${entry.id}: path no longer exists: ${p}. A verdict about a deleted surface is a verdict about nothing.`,
        );
      }
    }
    for (const scenario of entry.automatedBy || []) {
      if (!io.pathExists(scenario)) {
        failures.push(
          `${entry.id}: automatedBy names a scenario file that does not exist: ${scenario}. ` +
            `An automation claim nobody can check is how a surface stops being tested by either half.`,
        );
      }
    }
  }

  // The exemption map is held to the same rule, and INSIDE `analyse` rather than
  // beside it. An earlier version checked it in `main()` on the grounds that it
  // is "a property of the real tree, not of the injected world". But Rule 1 one
  // screen up checks exactly that property through `io.pathExists`, so the reason
  // did not survive contact with the code, and it made this the one rule no test
  // could inject. An exemption that has stopped describing anything silently
  // un-gates a path, which is where a hole is worst.
  const denominatorFiles = new Set(io.files || []);
  for (const [file, reason] of Object.entries(notASurface)) {
    if (!io.pathExists(file)) {
      failures.push(`NOT_A_SURFACE names ${file}, which no longer exists. Remove the exemption.`);
      continue;
    }
    // The other direction, and the one the sibling roster already had. An
    // exemption only means something for a file the denominator walk RETURNS;
    // for anything else it is an inert paragraph that reads, to the next person,
    // as a decision still in force.
    if (!denominatorFiles.has(file)) {
      failures.push(
        `NOT_A_SURFACE names ${file}, which is in no denominator, so the exemption does nothing. ` +
          `Either it moved out of a denominator (delete the entry) or it was never in one (delete it too): ` +
          `only a file the walk returns can be exempted from the walk.`,
      );
      continue;
    }
    const trimmed = (reason || "").trim();
    if (trimmed.length < MIN_REASON_CHARS) {
      failures.push(
        `NOT_A_SURFACE[${file}]: reason is shorter than ${MIN_REASON_CHARS} characters. ` +
          `Removing a file from the denominator outright is the strongest claim in this file and it has to be argued.`,
      );
    } else {
      const vague = isVague(trimmed);
      if (vague.length) failures.push(`NOT_A_SURFACE[${file}]: reason is vague (${vague.join(", ")})`);
    }
  }

  // --- Rule 2: coverage, forward. Every file in the denominators is claimed. --
  const claimedPaths = new Set();
  for (const entry of roster) for (const p of entry.paths || []) claimedPaths.add(p);
  const claimedScenarios = new Set();
  for (const entry of roster) for (const s of entry.automatedBy || []) claimedScenarios.add(s);
  const claimedPrefixes = [...claimedPaths].filter((p) => p.endsWith("/"));

  const claims = (file) => claimedPaths.has(file) || claimedPrefixes.some((p) => file.startsWith(p));

  // A trailing-slash claim is a PREFIX claim, and inside a denominator it defeats
  // the whole forward rule: every future file dropped into that directory is
  // pre-claimed by an entry that has never seen it. Measured during review by
  // injecting `src/screens/vault-creation/ZZ.tsx`, which the guard reported `ok`
  // on at exit 0 while the denominator count silently rose. The roster carries 158 prefix
  // claims (91 distinct) and only three sat inside a denominator, so this costs almost
  // nothing and it is what makes the headline claim, "a surface ENTERING the tree
  // fails by name", true rather than aspirational.
  //
  // Prefix claims OUTSIDE a denominator stay legitimate and are the common case:
  // `src-tauri/src/plugins/notes/` is how an entry says it tests that plugin's
  // behaviour, and no file under it is a surface a tester walks individually.
  // BOTH DIRECTIONS. A claim inside a denominator (`src/screens/vault-creation/`)
  // was the case that produced this rule, and a claim that CONTAINS one (`src/`)
  // is worse: it pre-claims every file in every denominator beneath it, and the
  // first version of this loop reported zero failures on exactly that input. Half
  // a derived coverage claim reads the same as a whole one in the success line,
  // which is what the header calls the silent-green class.
  const denominatorDirs = (io.denominators || DENOMINATORS).map((d) => d.dir);
  for (const entry of roster) {
    for (const p of entry.paths || []) {
      if (!p.endsWith("/")) continue;
      const inside = denominatorDirs.find((d) => p.startsWith(`${d}/`));
      const contains = denominatorDirs.find((d) => `${d}/`.startsWith(p));
      if (inside || contains) {
        failures.push(
          `${entry.id}: ${p} is a directory claim ${inside ? "inside" : "covering"} the ${inside || contains} ` +
            `denominator. A prefix claim pre-claims every file anyone drops in later, so the surface would ` +
            `never ask for a verdict. Name the files instead.`,
        );
      }
    }
  }

  for (const file of io.files || []) {
    if (notASurface[file]) continue;
    if (!claims(file)) {
      failures.push(
        `no roster entry claims ${file}. Add it to an entry's paths, or record it in NOT_A_SURFACE with the reason it is not a surface.`,
      );
    }
  }

  for (const file of io.e2eFiles || []) {
    if (!claimedScenarios.has(file)) {
      failures.push(
        `no roster entry names ${file} in automatedBy. Every scenario automates some surface; ` +
          `naming it is what keeps the manual half from re-testing what CI already covers.`,
      );
    }
  }

  for (const dir of (io.coverage && io.coverage.unwalked) || []) {
    failures.push(
      `${dir} exists and is on no denominator. A client that grew a surface directory is outside this ` +
        `guard until it joins DENOMINATORS, and the success line would still read ok.`,
    );
  }
  for (const dir of (io.coverage && io.coverage.stale) || []) {
    failures.push(
      `NOT_A_SURFACE_ROSTER exempts ${dir}, which is either gone or now a walked denominator. ` +
        `An exemption that outlives its subject is a claim about nothing.`,
    );
  }
  for (const dir of (io.coverage && io.coverage.unreasoned) || []) {
    failures.push(
      `NOT_A_SURFACE_ROSTER[${dir}]: reason is missing, too short or vague. ` +
        `Keeping a whole client tree out of the denominator is the widest claim in this file.`,
    );
  }
  for (const field of (io.missingRoots || []).map((r) => r)) {
    failures.push(
      `shared root ${field} is on scripts/lib/shared-roots.mjs and absent from this checkout. ` +
        `That is a broken checkout, not a smaller walk: the coverage assertion would scan fewer trees and still say ok.`,
    );
  }

  // --- Rule 3: reasons name mechanisms. ------------------------------------
  for (const entry of roster) {
    const manual = entry.manual || [];
    if (manual.length === 0) {
      const reason = (entry.exemptionReason || "").trim();
      if (reason.length < MIN_REASON_CHARS) {
        failures.push(
          `${entry.id}: no manual items and no exemptionReason of at least ${MIN_REASON_CHARS} characters. ` +
            `"Nothing here needs a human" is a legitimate answer and it has to be argued.`,
        );
      } else {
        const vague = isVague(reason);
        if (vague.length) failures.push(`${entry.id}: exemptionReason is vague (${vague.join(", ")})`);
      }
      continue;
    }

    manual.forEach((item, i) => {
      const where = `${entry.id}[${i}]`;
      const see = (item.see || "").trim();
      if (see.length < MIN_REASON_CHARS) {
        failures.push(
          `${where}: see is shorter than ${MIN_REASON_CHARS} characters. ` +
            `A tester with no context must be able to run it and decide pass or fail without asking the author.`,
        );
      }
      const why = (item.whyNotAutomated || "").trim();
      if (why.length < MIN_REASON_CHARS) {
        failures.push(`${where}: whyNotAutomated is shorter than ${MIN_REASON_CHARS} characters`);
      } else {
        const vague = isVague(why);
        if (vague.length) {
          failures.push(
            `${where}: whyNotAutomated describes the difficulty rather than the mechanism (${vague.join(", ")}). ` +
              `Name what blocks a driver: the runner OS, the WebView engine, the device, the OS event source, the perceptual judgement.`,
          );
        }
      }
      if (!TIERS.includes(item.tier)) failures.push(`${where}: tier must be one of ${TIERS.join(", ")}`);
      if (!(typeof item.estimateMin === "number" && item.estimateMin > 0)) {
        failures.push(`${where}: estimateMin must be a positive number of minutes`);
      }
      const itemClients = item.clients || [];
      if (itemClients.length === 0) failures.push(`${where}: no clients`);
      for (const client of itemClients) {
        if (!CLIENTS.includes(client)) failures.push(`${where}: unknown client ${JSON.stringify(client)}`);
        else if (!(entry.clients || []).includes(client)) {
          failures.push(
            `${where}: names client ${client}, which the entry itself does not list. ` +
              `A plan built from the entry would never schedule it.`,
          );
        }
      }
    });
  }

  // --- Rule 4: verification stamps describe entries that exist. ------------
  const verified = io.verified || {};
  for (const [id, stamp] of Object.entries(verified)) {
    if (!seenIds.has(id)) {
      failures.push(`verification stamp for unknown entry ${id}. A stamp on a deleted entry is a claim about nothing.`);
      continue;
    }
    if (!stamp || !stamp.version || !stamp.date || !stamp.verdict) {
      failures.push(`${id}: verification stamp needs version, date and verdict`);
      continue;
    }
    if (!["pass", "fail", "override"].includes(stamp.verdict)) {
      failures.push(`${id}: verdict must be pass, fail or override (got ${JSON.stringify(stamp.verdict)})`);
    }
    if (stamp.verdict === "override" && (stamp.reason || "").trim().length < MIN_REASON_CHARS) {
      failures.push(
        `${id}: an override is how a failed ship gate is passed anyway, so it carries a written reason of at least ${MIN_REASON_CHARS} characters`,
      );
    }
  }

  // --- Rule 5: the ratchet. The gate widens, the roster shrinks. -----------
  //
  // THE GATE IS A POLICY, NOT A MINUTE COUNT, and getting that wrong is the
  // defect this shape replaced. The first version held a floor on gating MINUTES
  // and it punished the one behaviour the whole system exists to encourage: an
  // author who writes a scenario covering a `core` item and deletes the item
  // drops `gatedMinutes` below the floor, and the guard called that "the gate
  // NARROWED" and told them the fix was the one edit that is never legitimate.
  // A ratio floor fails the same way, because automating a core item removes it
  // from the numerator and the denominator together.
  //
  // What is genuinely monotone is the POLICY: which tiers block, on which
  // clients. Those are sets, set inclusion is exactly the invariant "the gate
  // widens" means, and it says nothing about how many minutes happen to sit
  // inside them. So `gatedTiers` and `gatedClients` may only GROW, and the
  // paired ceiling on total manual minutes TRACKS the roster: `--record` lowers
  // it, and raising it is an argued hand edit rather than a forbidden one,
  // because a ceiling that could only fall would mean a genuinely new surface
  // needing a human could never be gated. Together they still say what the pair
  // always meant, and neither now argues against automation.
  //
  // The recorded sets live in the ratchet file so a narrowing edit is a diff a
  // reviewer sees, and `RATCHET_BASELINE` below is the committed floor they are
  // compared against.
  const stats = counts(roster, io.ratchet);
  if (io.ratchet) {
    const { totalMinutesCeiling: ceiling } = io.ratchet;
    for (const tier of io.ratchet.gatedTiers || []) {
      if (!TIERS.includes(tier)) failures.push(`ratchet gatedTiers names unknown tier ${JSON.stringify(tier)}`);
    }
    for (const client of io.ratchet.gatedClients || []) {
      if (!CLIENTS.includes(client)) {
        failures.push(`ratchet gatedClients names unknown client ${JSON.stringify(client)}`);
      }
    }
    const baseline = io.baseline || RATCHET_BASELINE;
    for (const [field, floor] of Object.entries(baseline)) {
      const now = new Set(io.ratchet[field] || []);
      const dropped = floor.filter((v) => !now.has(v));
      if (dropped.length) {
        failures.push(
          `the gate NARROWED: ${field} no longer covers ${dropped.join(", ")}. ` +
            `Removing a tier or a client from the gate is the one edit that is never legitimate, and ` +
            `RATCHET_BASELINE in this file is what says so. If the gate really should cover less, that is a ` +
            `decision entry, not a JSON edit.`,
        );
      }
      const added = [...now].filter((v) => !floor.includes(v));
      if (added.length) {
        notes.push(
          `the gate widened: ${field} now covers ${added.join(", ")} as well. ` +
            `Add them to RATCHET_BASELINE so the next narrowing is caught.`,
        );
      }
    }
    if (stats.totalMinutes > ceiling) {
      failures.push(
        `manual work GREW: ${stats.totalMinutes} minutes against a ceiling of ${ceiling}. ` +
          `Something was added as a manual item that a scenario could have asserted, or a new surface really ` +
          `does need a human. If it is the second, raise the ceiling in the same change and say what added it.`,
      );
    } else if (stats.totalMinutes < ceiling) {
      notes.push(
        `manual work shrank: ${stats.totalMinutes} minutes against a recorded ceiling of ${ceiling}. ` +
          `Run --record to lock it in, and name the automation that took the work.`,
      );
    }

    // The two above bound the RATCHET FILE. They do not bound the roster's
    // COMPOSITION, and for a while four documents said they did: this repo's
    // guard table, the ratchet's own $comment ("EITHER HALF ALONE IS GAMEABLE"),
    // an append-only decision entry and the generated projection all claimed the
    // blocking share goes up while the roster goes down. Retiering a `core` item
    // to `standard` satisfies both halves and moves neither: gating minutes fall,
    // total minutes do not, and the guard reports a gate that narrowed as a gate
    // that did nothing. Dropping a gated client from an item's own `clients` is
    // worse, because total minutes fall too, the note above then invites
    // `--record`, and the smaller ceiling is locked in as though it were progress.
    //
    // What separates those from the move this system exists to encourage is the
    // RELATIVE change, never either number alone:
    //
    //   automating an item     gating falls, total falls by AT LEAST as much   ok
    //   core -> standard       gating falls, total unchanged                   refused
    //   dropping a client      both fall together                              ok
    //
    // So `gatedMinutes` is recorded beside the ceiling and the bound is on the
    // two DROPS rather than on the level. It cannot punish automation, which
    // moves both together by construction, and it fires on exactly the edit that
    // takes work out of the gate while leaving it in the roster.
    const { gatedMinutes: recordedGated } = io.ratchet;
    if (Number.isFinite(recordedGated) && stats.gatedMinutes < recordedGated) {
      const gatingFell = recordedGated - stats.gatedMinutes;
      const totalFell = ceiling - stats.totalMinutes;
      if (gatingFell > totalFell) {
        failures.push(
          `the gate narrowed WITHOUT the roster shrinking: gating minutes fell by ${gatingFell} while total ` +
            `manual minutes fell by ${totalFell}. Automating an item drops both together, so this is something ` +
            `else: an item retiered from core to standard, or a gated client dropped from an item's own ` +
            `clients. Either leaves the work in the roster and takes it out of the gate, which is the half of ` +
            `"either alone is gameable" that gatedTiers and gatedClients cannot see. If the change is right, ` +
            `say why in the ratchet $comment and re-record with --record in the same commit.`,
        );
      }
    }
  }

  // --- Warnings: what has gone unlooked-at. --------------------------------
  const unverified = roster.filter((e) => (e.manual || []).length > 0 && !verified[e.id]);
  if (unverified.length) {
    warnings.push(
      `${unverified.length} entries with manual items have never been verified: ${unverified
        .slice(0, 8)
        .map((e) => e.id)
        .join(", ")}${unverified.length > 8 ? ", ..." : ""}`,
    );
  }

  return { failures, notes, warnings, stats: { ...stats, automatedScenarios: claimedScenarios.size } };
}

// ---------------------------------------------------------------------------
// The projection.
//
// `docs/dev/manual-test-roster.md` is generated from the roster and gated by
// `--check`, the same arrangement `scripts/check-twin-inventory.mjs` uses. The
// reason it is generated rather than written is that a hand-kept second copy of
// a roster is the exact drift this whole file exists to stop.
//
// It carries the roster and NOT the verification stamps. A stamp moves every
// release without the roster changing, so publishing it here would fail
// `--check` after every release run under a message telling the author the
// document had been hand-edited. `scripts/manual-test-plan.mjs --status` prints
// the stamps instead. That is the twin-inventory lesson applied rather than
// rediscovered: ask what edit moves the number, not where the number came from.
// ---------------------------------------------------------------------------

/**
 * The safety rules that bind every walk, emitted VERBATIM into both documents a
 * walker reads: the byte-gated projection here, and the per-release plan
 * `scripts/manual-test-plan.mjs` generates. One constant rather than two copies,
 * because the copy that drifts is always the one somebody is holding.
 *
 * The third rule is the one review added, and it is the widest: the first two
 * trigger on egress and on typing a credential, so between them they reached six
 * items, and every destructive instruction in the file, an uninstall, a factory
 * reset, a Keystore wipe, a migration over a real container, a disk filled to
 * ENOSPC, a hard power cut, fell outside both. Those are the items that can
 * take a vault with them, and in a local-first product with no server-side copy
 * there is nothing to restore from. A rule stated only where the destructive
 * item is not is not a rule.
 */
export const WALK_PREAMBLE = `## Before you walk any of it

**An item that causes network egress, or that has you type a real credential, runs against a
disposable vault seeded with synthetic notes.** Never a working one. Release testing that sends real
note text to a model provider is production personal data used as test data, which is a purpose
limitation and data minimisation problem the product itself does not have, and it is created by the
absence of this sentence rather than by any feature. The same holds for a real recovery phrase: typed
into a device with autocorrect on, or filed in a password manager, it is one string that reconstructs
the whole vault.

**An item that destroys something runs on a machine you can afford to lose, and a vault you can
afford to lose.** That covers every uninstall, factory reset, credential-store wipe, migration over
a real container, disk filled to ENOSPC, and hard power cut in this roster, and several of them say
so in their own text as well. Read it as binding even where an item forgets: this product keeps no
server-side copy, so a vault destroyed on the release-testing machine is destroyed, and the roster
is the one document with the standing to send somebody to do that quickly on a 163.7 h day. Where an
item needs a machine rather than just a vault, it says so; where it does not, a VM, a spare device
or a fresh user account is the default reading.

**No cloud device farms.** BrowserStack, Firebase Test Lab, Sauce Labs or any third-party service
that touches a debug build is banned outright, and the ban is
\`mobile/docs/dev/device-matrix.md\` §0's rather than this document's: a debug build carries the
plaintext trust boundary, so it never leaves a device you control. It is restated here because the
roster asks for hardware across every client (a second phone, a wide-gamut display beside an sRGB
one, a Windows 2-in-1, a stylus) and a walker short of one of those is exactly the person who
reaches for a farm, while the ban itself lives in a mobile-specific file a desktop or web walker has
no reason to open. An item you cannot run for want of hardware is recorded as unrun, which is a real
and acceptable answer.
`;

export const PROJECTION = join("docs", "dev", "manual-test-roster.md");

export function projectionBody(roster, ratchet) {
  const c = counts(roster, ratchet);

  const head = `<!-- GENERATED by scripts/check-manual-test-roster.mjs --emit. Do not edit by hand:
     the roster in scripts/manual-test-roster.mjs is the source of truth, and the
     guard beside it is also the gate. -->

# Pre-release manual test roster

What a human verifies before a Myne release, and why a machine cannot verify it instead.

Every item below is meant to be a **ship gate**. If it fails, the tag is not cut. Passing a failed
item anyway takes a written \`override\` recorded against the entry, which is the same shape \`/done\`
uses for a \`/pr-review\` NEEDS-CHANGES verdict: the default is to stop, and going on is a named act
that lands in the record.

An item earns a place here **only if a machine cannot honestly judge it**. Anything a tauri-driver
scenario could assert is automation debt and belongs in \`e2e/\`, not here. That rule is enforced
rather than stated: \`whyNotAutomated\` has to name the mechanism that blocks a driver, and a reason
that describes the difficulty instead fails the guard.

**${c.entries} entries, ${c.manualItems} manual items (${c.coreItems} core tier), about ${hours(c.totalMinutes)} hours.**
${c.exempt} entries carry no manual item at all and argue why.

The hours are counted **once per client**, because an item naming macOS, Linux and Windows is three
sittings rather than one. Counting once per item is how a roster this size reads as affordable when
it is not.

These four numbers come from the roster, so they move only when the roster does, which is exactly
when this document should be regenerated. What has actually been verified, and at which version, is
a per-release measurement rather than a property of the record: run
\`node scripts/manual-test-plan.mjs --status\` for that, and it is deliberately kept out of this
byte-gated file.

${WALK_PREAMBLE}

## How much of this blocks today

Not all of it does yet, and the difference is recorded rather than implied:
\`scripts/manual-test-ratchet.json\` says the gate covers the **${ratchet.gatedTiers.join(", ")}** tier on
**${ratchet.gatedClients.join(", ")}**, which is ${hours(c.gatedMinutes)} of the ${hours(c.totalMinutes)} hours below.

The reason it starts smaller than the roster is arithmetic, not appetite. Making all of it blocking on
day one produces a gate one maintainer cannot walk, and a gate nobody can walk gets bulk-overridden,
which teaches the override to mean nothing. So the ratchet holds two numbers that only move one way:
as automation debt is paid: the gate POLICY may only grow, and the ceiling on total manual minutes is
lowered by \`--record\` and raised only by a hand edit that carries its argument, since a ceiling that
could only fall would mean a genuinely new surface needing a human could never be gated. A third
recorded number keeps those two honest about the ROSTER rather than about the
ratchet file. Gating minutes may not fall by more than the ceiling does, so retiering a blocking item
down to non-blocking, or dropping a gated client from an item, is refused: both take work out of the
gate and leave it in the roster. Automating an item moves the two together by construction, so the
rule cannot argue against the one move this whole record exists to encourage. The gate widens, the
roster shrinks, and the end state is the whole file blocking.

## Tiers

**core** is three things and nothing else: an item where failing means **data loss**, an item where
failing means a **security or privacy boundary broke** (plaintext leaving the device, a locked vault
still readable, a phrase or key on screen or in a log, an egress with no user consent), or an item
verifying the **upgrade over a real vault** from the previous release. Everything else is standard.

The tier decides ordering, and together with the client it decides whether an item blocks today.

## Why this exists

The desktop E2E suite is 133 files, and the 301 scenarios \`scripts/e2e-scenario-floor.json\`
requires to execute all run in a Linux container against WebKitGTK through tauri-driver. macOS
desktop, Windows desktop, Safari, iOS and Android have no automated UI coverage at all. Seven manual procedure documents already existed and four of them
were reachable from no release step. The CI \`e2e\` step carries \`failure: ignore\`, and v0.4 shipped
without the suite ever running with nothing recording that fact.

## The roster
`;

  const sections = roster
    .slice()
    .sort((a, b) => a.id.localeCompare(b.id))
    .map((entry) => {
      const lines = [`### \`${entry.id}\`: ${entry.title}`, ""];
      lines.push(`- **Clients:** ${(entry.clients || []).join(", ")}`);
      lines.push(`- **Paths:** ${(entry.paths || []).map((p) => `\`${p}\``).join(", ")}`);
      lines.push(
        (entry.automatedBy || []).length
          ? `- **Already automated by:** ${entry.automatedBy.map((s) => `\`${s}\``).join(", ")}`
          : `- **Already automated by:** nothing.`,
      );
      lines.push("");
      if (!(entry.manual || []).length) {
        lines.push(`No manual item. ${entry.exemptionReason}`, "");
        return lines.join("\n");
      }
      for (const item of entry.manual) {
        const blocking = item.clients.filter((client) => gates(item, client, ratchet));
        const mark = blocking.length === item.clients.length ? "" : blocking.length ? ", blocks on some" : ", does not block yet";
        lines.push(`- **[${item.tier}, ${item.estimateMin} min, ${item.clients.join(", ")}${mark}]** ${item.see}`);
        lines.push(`  <br>*Why no machine can judge it:* ${item.whyNotAutomated}`);
      }
      lines.push("");
      return lines.join("\n");
    });

  return `${head}\n${sections.join("\n")}`;
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

const RATCHET_PATH = join(ROOT, "scripts", "manual-test-ratchet.json");
const VERIFIED_PATH = join(ROOT, "scripts", "manual-test-verified.json");

/**
 * Write through a temporary file and rename over the target.
 *
 * The two records this system keeps are read asymmetrically: an ABSENT file falls
 * back to an empty record, and a TRUNCATED one throws, so every later `--record`
 * and `--status` dies until a human diagnoses it. An in-place `writeFileSync`
 * turns a crash or a full disk into exactly that second state, which is the
 * record left worse than absent.
 */
export function writeAtomically(path, contents) {
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, contents);
  renameSync(tmp, path);
}

async function main() {
  const argv = process.argv.slice(2);
  const wantEmit = argv.includes("--emit");
  const wantCheckProjection = argv.includes("--check");
  const wantRecord = argv.includes("--record");

  const { ROSTER } = await import("./manual-test-roster.mjs");

  // A missing ratchet file is a failure, not a smaller check. Falling back to
  // "no ratchet configured" would let deleting one file turn the gate off while
  // every other rule still printed ok, which is the shape `check-e2e-floor.mjs`
  // refuses when its report is absent.
  if (!existsSync(RATCHET_PATH)) {
    console.error("check-manual-test-roster: scripts/manual-test-ratchet.json is missing. The gate has no floor.");
    process.exit(1);
  }
  const ratchet = JSON.parse(readFileSync(RATCHET_PATH, "utf8"));

  // A missing FILE was already a hard refusal; a missing KEY inside the present
  // file was silence, and that asymmetry was the defect. With the ceiling deleted,
  // both `N > undefined` and `N < undefined` are false, so the comparison skipped
  // both arms and the guard printed `ok` at exit 0, and `--record` then made it
  // permanent, because `Math.min(undefined, N)` is `NaN` and `JSON.stringify`
  // writes that as `null`. A record with a null bound is worse than an absent
  // one: absent exits 1 loudly, null reports success with the check off.
  for (const field of ["totalMinutesCeiling", "gatedMinutes"]) {
    if (!Number.isFinite(ratchet[field])) {
      console.error(
        `check-manual-test-roster: scripts/manual-test-ratchet.json has no finite ${field} ` +
          `(got ${JSON.stringify(ratchet[field])}). Half the ratchet would be off and the run would still say ok.`,
      );
      process.exit(1);
    }
  }
  for (const field of ["gatedTiers", "gatedClients"]) {
    if (!Array.isArray(ratchet[field]) || ratchet[field].length === 0) {
      console.error(`check-manual-test-roster: scripts/manual-test-ratchet.json needs a non-empty ${field} array.`);
      process.exit(1);
    }
  }

  const verified = existsSync(VERIFIED_PATH) ? JSON.parse(readFileSync(VERIFIED_PATH, "utf8")).verified || {} : {};

  // A denominator directory that is absent is a broken checkout, not a smaller
  // walk. Reporting `ok` over a tree this guard could not read is the failure
  // `scripts/check-prefs-nonce.mjs` records for its own roster.
  const walked = {};
  for (const { dir, extensions } of DENOMINATORS) {
    const files = walkFiles([join(ROOT, dir)], { relativeTo: ROOT, extensions, missingIsNull: true });
    if (files === null) {
      console.error(`check-manual-test-roster: denominator directory is missing: ${dir}`);
      process.exit(1);
    }
    walked[dir] = files;
  }

  // `existsSync` memoised. Rule 1 asks about 1104 distinct strings (952 `paths`
  // plus the `automatedBy` scenarios), 381 of them more than once and
  // `e2e/prefs.e2e.ts` fourteen times, for 1849 calls unmemoised.
  const statCache = new Map();
  const pathExists = (p) => {
    if (!statCache.has(p)) statCache.set(p, existsSync(join(ROOT, p)));
    return statCache.get(p);
  };

  const roots = presentSharedRoots(ROOT);
  const { failures, notes, warnings, stats } = analyse({
    roster: ROSTER,
    files: DENOMINATORS.filter((d) => d.dir !== "e2e").flatMap((d) => walked[d.dir]),
    e2eFiles: walked.e2e,
    pathExists,
    verified,
    ratchet,
    coverage: coverageGaps(roots.present, (d) => existsSync(join(ROOT, d))),
    missingRoots: roots.missing,
  });

  if (wantRecord) {
    // A number derived from a roster the guard has just REJECTED must never enter
    // the record. The branch used to return before the failure gate, so `--record`
    // on a broken tree exited 0 and printed none of the failures.
    if (failures.length) {
      console.error(
        `check-manual-test-roster: --record refused, ${failures.length} failure(s) first. ` +
          `A number derived from a roster the guard rejects should not enter the record.\n`,
      );
      for (const f of failures) console.error(`  - ${f}`);
      process.exit(1);
    }
    // Two numbers, and only downward, because the composition rule above compares
    // their two DROPS rather than either level. `gatedMinutes` moves in lockstep
    // with the ceiling here for the same reason `--record` exists at all: after a
    // legitimate shrink the record has to describe the roster again, or the next
    // run measures the next change against a baseline two changes old. The gate
    // POLICY is still not recorded here: widening it is an edit to
    // `RATCHET_BASELINE` in this file, made by a person who read what they widened.
    const next = {
      ...ratchet,
      totalMinutesCeiling: Math.min(ratchet.totalMinutesCeiling, stats.totalMinutes),
      gatedMinutes: Math.min(ratchet.gatedMinutes, stats.gatedMinutes),
    };
    const ceilingMoved = next.totalMinutesCeiling !== ratchet.totalMinutesCeiling;
    const gatingMoved = next.gatedMinutes !== ratchet.gatedMinutes;
    if (!ceilingMoved && !gatingMoved) {
      console.log("check-manual-test-roster: --record: nothing to lock in, the record already describes the roster.");
      return;
    }
    writeAtomically(RATCHET_PATH, `${JSON.stringify(next, null, 2)}\n`);
    console.log(
      `check-manual-test-roster: --record: ceiling ${ratchet.totalMinutesCeiling} -> ${next.totalMinutesCeiling}, ` +
        `gating ${ratchet.gatedMinutes} -> ${next.gatedMinutes}. ` +
        `Name the automation that took the work in the $comment.`,
    );
    return;
  }

  if (wantEmit) {
    if (failures.length) {
      console.error(
        `check-manual-test-roster: ${failures.length} failure(s), so ${PROJECTION} was NOT written.\n`,
      );
      for (const f of failures) console.error(`  - ${f}`);
      console.error(
        `\n  Fix the roster and re-run --emit. A projection generated from a rejected roster is a ` +
          `checked-in CC-BY document describing a state nobody accepted, which is the same refusal ` +
          `--record makes about the ratchet one branch up.`,
      );
      process.exit(1);
    }
    writeAtomically(join(ROOT, PROJECTION), projectionBody(ROSTER, ratchet));
    console.log(`check-manual-test-roster: wrote ${PROJECTION}`);
  } else if (wantCheckProjection) {
    const current = existsSync(join(ROOT, PROJECTION)) ? readFileSync(join(ROOT, PROJECTION), "utf8") : "";
    if (current !== projectionBody(ROSTER, ratchet)) {
      failures.push(
        `${PROJECTION} is stale. Run \`node scripts/check-manual-test-roster.mjs --emit\`. ` +
          `It is generated from the roster; do not edit it by hand.`,
      );
    }
  }

  for (const n of notes) console.log(`check-manual-test-roster: note: ${n}`);
  for (const w of warnings) console.warn(`check-manual-test-roster: warning: ${w}`);

  if (failures.length) {
    console.error(`check-manual-test-roster: ${failures.length} failure(s)\n`);
    for (const f of failures) console.error(`  - ${f}`);
    process.exit(1);
  }

  console.log(
    `check-manual-test-roster: ok. ${stats.entries} entries, ${stats.manualItems} manual items ` +
      `(${stats.coreItems} core), ${stats.automatedScenarios} scenarios claimed, ` +
      `${hours(stats.totalMinutes)} h of manual work, of which ${hours(stats.gatedMinutes)} h gates the ship ` +
      `(${Math.round((stats.gatedMinutes / stats.totalMinutes) * 1000) / 10}%). Denominators: ` +
      `${DENOMINATORS.map((d) => `${d.dir} (${walked[d.dir].length})`).join(", ")}.`,
  );
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  main().catch((err) => {
    console.error(`check-manual-test-roster: ${err && err.stack ? err.stack : err}`);
    process.exit(1);
  });
}
