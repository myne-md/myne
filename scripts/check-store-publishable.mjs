#!/usr/bin/env node
// A publishable store root may only hold frames whose surface a mobile user can
// actually reach.
//
//   node scripts/check-store-publishable.mjs            # check
//   node scripts/check-store-publishable.mjs --verbose   # list what it examined
//
// WHY THIS EXISTS
// The rule it enforces is Apple's 2.3.1 and Play's equivalent: a store image may
// not promise a flow a user cannot get to. The failure is silent in the direction
// nobody watches, because a frame is a PNG: nothing about the FILE says which
// screen it came from, and nothing about the SCREEN says whether the app can
// reach it. The design board makes that worse rather than better, deliberately:
// `mobile/AGENTS.md` calls it "the desktop feature-parity design target, not
// backed", so it renders surfaces mobile does not have yet.
//
// That is how this guard came to be written. Three of the collaboration screens
// this feature added to the board depict flows MOBILE CANNOT REACH, because the
// bindings behind them have no mobile caller: `personCreateInvite`,
// `personSetMemberName` and `personRemoveMember` are desktop-only today (mobile
// calls `personListInvites` and `personAcceptInvite`, which is why the roster and
// the claim step ARE reachable). A frame pointed at one of those three would
// promise an invite wizard, a rename or a removal that a phone cannot perform.
//
// TWO RULES, AND THEY COMPARE DIFFERENT THINGS.
//
//  1. REACHABILITY, from the story: every screen a story frame names must be
//     either recorded as reachable or recorded in `NOT_REACHABLE_ON_MOBILE`. A
//     screen in neither list fails by name, so adding a frame to the story means
//     deciding, on the record, whether the app can reach it. A screen in the
//     not-reachable list being named by a frame also fails, which is the arm that
//     makes the list load-bearing rather than decorative.
//  2. WHAT IS ON DISK, against the plan: every PNG sitting in a publishable root
//     must be one the plan would write, and every PNG the plan would write must
//     be there. Both directions, because a stale frame left behind and a frame
//     that never landed are different mistakes with the same evidence.
//
// It fails BY NAME when a root it was told to scan does not exist. A scan that
// covers less than it claims reads exactly like a scan that passed.

import { existsSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { SLOTS, ALL_SET_IDS, FEATURE_GRAPHIC } from "./lib/store-shots/slots.mjs";
import { STORY, storyFor, deviceClassFor } from "./lib/store-shots/story.mjs";
import { buildPlan } from "./lib/store-shots/plan.mjs";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/**
 * Screens the design board renders that a MOBILE user cannot reach yet, each with
 * the evidence rather than the conclusion.
 *
 * The evidence is a binding with no mobile caller, which is the shape this
 * repository already mechanises elsewhere (`check-ipc-binding-callers.mjs` asks
 * the same question of every binding). Kept as a named list with reasons on
 * purpose: membership here is an EXEMPTION from publishing, so deriving it would
 * let any screen license itself.
 */
const NOT_REACHABLE_ON_MOBILE = {
  "MB-02": "no mobile caller for personCreateInvite; only desktop's InviteWizard creates an invite",
  "MB-04": "no mobile caller for personSetMemberName; a phone cannot rename itself in a vault today",
  "MB-06": "no mobile caller for personRemoveMember; member removal is desktop-only today",
};

/** Screens the board renders AND mobile reaches, with the surface behind them. */
const REACHABLE_ON_MOBILE = {
  "05": "the notes list, rendered by EditorFlow",
  "08": "the editor, rendered by EditorFlow",
  "09": "search, rendered by EditorFlow",
  "10": "the graph tab",
  "11": "settings, rendered by SettingsSheet",
  "ST-01": "the Account panel in SettingsSheet",
  "SY-01": "the sync hub, rendered by SyncHubPanel",
  "AG-01": "the intelligence switch in SettingsSheet",
  "AG-02": "the provider step, `AiScopeSheet`",
  "AG-03": "the chat, `AiChatFlow` with `AiReviewFlow` behind the proposed edit",
  "MB-01": "the person identity, `IdentityFlow`",
  "MB-03": "the member roster, `SyncMembersPanel` with `useMembers`",
  "MB-05": "a note in a shared vault, the same editor",
  "PT-01": "the mobile export writes this folder (the `export` plugin's whole-vault markdown tree, through `plugin:export-dir|export_path`)",
  "PT-02": "the same exported markdown, opened by an editor that is not Myne",
  "WS-01": "the iPad workspace shell",
  "ED-03": "the iPad wikilink picker",
  "SC-02": "the iPad search results",
};

function rel(p, root = REPO_ROOT) {
  return p.replace(root + "/", "");
}

function listPngs(dir) {
  return readdirSync(dir)
    .filter((f) => f.endsWith(".png"))
    .sort();
}

export function ownsFile(slot, filename) {
  return ownsFileImpl(slot, filename);
}

/**
 * Whether a set OWNS a file in its output directory.
 *
 * Explicit rather than "everything in the directory", and the first run is why:
 * the Android images root legitimately holds `icon.png`, which F-Droid requires
 * and `check-fdroid-metadata.mjs` gates, so a rule that read every PNG there as a
 * frame reported the app icon as a stale store frame. Teaching the guard the app
 * icon as an exception would have been the wrong fix, because the next unrelated
 * asset would trip it again; asking "is this file named the way THIS set names
 * its frames" is the property that actually holds.
 */
function ownsFileImpl(slot, filename) {
  if (slot.filename) return filename === slot.filename;
  if (slot.root === "fastlane") return /^\d+\.png$/.test(filename);
  return /^\d{2}-[a-z0-9]+\.png$/.test(filename);
}

/**
 * The check, with every input injectable.
 *
 * Exported and parameterised because the repository's rule is that a guard is
 * verified by BREAKING it: a test has to be able to hand this a story that points
 * at a screen mobile cannot reach, and a directory that holds a frame no set
 * writes, without editing the real tree. The defaults are the real ones.
 */
/**
 * @param {{ [key: string]: any }} [options]  See the note on the same signature in
 *   `check-store-frame-identifiers.mjs`: a destructured default of `null` makes TS
 *   infer every caller's object as `null`, which is a type error about inference
 *   rather than a finding about the call.
 */
export function check({
  story = STORY,
  reachable = REACHABLE_ON_MOBILE,
  notReachable = NOT_REACHABLE_ON_MOBILE,
  repoRoot = REPO_ROOT,
  plan = null,
} = {}) {
  const errors = [];

  // ---- rule 1: reachability, from the story
  const framed = new Set();
  for (const frame of story) {
    for (const screenId of [frame.screens.phone, frame.screens.tablet]) {
      if (screenId) framed.add(screenId);
    }
  }
  // The graphic reuses a phone frame, so it adds no screen of its own.
  void FEATURE_GRAPHIC;

  for (const screenId of framed) {
    if (notReachable[screenId]) {
      errors.push(
        `the story names screen "${screenId}", which a mobile user cannot reach: ${notReachable[screenId]}`,
      );
    } else if (!reachable[screenId]) {
      errors.push(
        `the story names screen "${screenId}", which is in neither roster. Decide on the record whether mobile reaches it, in REACHABLE_ON_MOBILE or in NOT_REACHABLE_ON_MOBILE.`,
      );
    }
  }

  // A screen listed as unreachable must not creep into the story later, and a
  // reachable entry that no frame uses is not stale on its own (other frames may
  // use it), so only the not-reachable arm is checked from both sides here.
  for (const [screenId, reason] of Object.entries(notReachable)) {
    const onBoard = story.some((f) => f.screens.phone === screenId || f.screens.tablet === screenId);
    if (onBoard) {
      errors.push(`screen "${screenId}" is in NOT_REACHABLE_ON_MOBILE and still named by a frame: ${reason}`);
    }
  }

  // ---- rule 2: what is on disk, against the plan
  const publishable = ALL_SET_IDS.filter((id) => {
    const slot = id === FEATURE_GRAPHIC.id ? FEATURE_GRAPHIC : SLOTS[id];
    return slot.root === "fastlane";
  });

  const resolvedPlan =
    plan ??
    buildPlan({
      sets: publishable,
      frames: [],
      outDirFor: (slot) => {
        const images = join(repoRoot, "fastlane/metadata/android/en-US/images");
        if (slot.filename) return images;
        return join(images, slot.frame === "android" ? "phoneScreenshots" : "tenInchScreenshots");
      },
    });

  let examined = 0;
  for (const entry of resolvedPlan.slots) {
    const dirs = new Set(entry.frames.map((f) => f.out));
    if (dirs.size !== 1) {
      errors.push(`set "${entry.slot.id}" writes into ${dirs.size} directories, so the check cannot be two-way`);
      continue;
    }
    const [dir] = [...dirs];
    if (!existsSync(dir)) {
      errors.push(`publishable root ${rel(dir, repoRoot)} does not exist, so nothing was compared`);
      continue;
    }
    const expected = entry.frames.map((f) => f.filename).sort();
    const actual = listPngs(dir).filter((f) => ownsFile(entry.slot, f));
    examined += actual.length;

    for (const file of actual) {
      if (!expected.includes(file)) {
        errors.push(
          `${rel(join(dir, file), repoRoot)} is in a publishable root and no frame of "${entry.slot.id}" writes it. A stale frame is a promise nobody is maintaining.`,
        );
      }
    }
    for (const file of expected) {
      if (!actual.includes(file)) {
        errors.push(`${rel(join(dir, file), repoRoot)} is missing from its publishable root`);
      }
    }
  }

  // The denominator arm is about the PLAN, not about the directories. A per-root
  // "nothing was compared" arm cannot fire and so was not kept: the file
  // comparison is two-way, so a root the plan expects files in and does not find
  // them already fails by name. What CAN happen is that no set writes into a
  // publishable root at all, which would make this guard vacuous while printing
  // ok, and that is the condition checked here.
  /**
   * Roots that NO producible set writes, checked for leftovers.
   *
   * `tenInchScreenshots/` held five frames with iPhone chrome in an Android
   * directory, and nothing looked at it: the plan has no set that writes there,
   * because `android-10` is blocked, and a root the plan never visits is a root no
   * check ever reads. So the rule for these is the inverse of the one above: the
   * expected set is EMPTY, and any PNG present is a stale promise.
   */
  const imagessRoot = join(repoRoot, "fastlane/metadata/android/en-US/images");
  for (const dir of ["tenInchScreenshots"]) {
    const full = join(imagessRoot, dir);
    if (!existsSync(full)) continue;
    for (const file of listPngs(full)) {
      errors.push(
        `${rel(join(full, file), repoRoot)} is in ${dir}/ and no producible set writes that directory, so it is a stale frame. Either the set that owns it is blocked (android-10) or the file predates the set.`,
      );
    }
  }

  if (resolvedPlan.slots.length === 0) {
    errors.push("no set writes into a publishable root, so this check compared nothing");
  }

  return { errors, examined };
}

function framedCount() {
  const ids = new Set();
  for (const key of ["phone", "tablet"]) for (const f of storyFor(key)) ids.add(f.screenId);
  return ids.size;
}

/**
 * The CLI arm, behind the argv guard its two siblings already had.
 *
 * Without it, IMPORTING this module from `tests/scripts/storePublishable.test.ts`
 * ran the whole real-tree check at import: a wrong tree would have called
 * `process.exit(1)` from module scope and killed the vitest worker instead of
 * failing the named test, which is exactly when the per-rule diagnostics the test
 * exists for are unavailable.
 */
function main() {
  const { errors, examined } = check();
  const verbose = process.argv.includes("--verbose");

  if (errors.length > 0) {
    console.error("store-publishable: a publishable root holds something it should not\n");
    for (const e of errors) console.error(`  - ${e}`);
    console.error(
      `\n${framedCount()} story screen(s) checked for reachability, ${examined} PNG(s) compared against the plan.`,
    );
    process.exit(1);
  }

  if (verbose) {
    console.log(`  reachable screens: ${Object.keys(REACHABLE_ON_MOBILE).length}`);
    console.log(`  screens mobile cannot reach: ${Object.keys(NOT_REACHABLE_ON_MOBILE).length}`);
    console.log(`  PNGs compared: ${examined}`);
  }
  console.log(
    `store-publishable: ok (${framedCount()} story screen(s) reachable on mobile, ${examined} PNG(s) match the plan)`,
  );
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  main();
}
