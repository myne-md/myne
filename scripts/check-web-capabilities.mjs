#!/usr/bin/env node
// Capability-descriptor drift guard (phase3-web-client task 27).
//
// # The two lists, and why they must agree
//
// There are two independent statements of "what the web client cannot do":
//
//   `web/src/platform/capabilities.ts`  — what the UI OMITS (task 27)
//   `web/wasm/src/capability.rs`        — what the dispatcher REFUSES (task 11)
//
// They answer different questions and both are necessary: the UI must decide
// before rendering, and the backend must still refuse a command that arrives by
// a path gating did not cover (a stale deep link, a replayed workspace command).
//
// But they must not DISAGREE, and the disagreement is invisible from either
// side alone:
//
//   UI offers, backend refuses  -> the user clicks something that errors. This
//                                  is the greyed-control failure task 27 exists
//                                  to prevent, arriving by a different route.
//   UI omits, backend allows    -> a working feature is unreachable, and nothing
//                                  reports it.
//
// # What is checked
//
// Every capability the descriptor marks ABSENT must have at least one
// `Class::Unsupported` command behind it, and every plugin the Rust table marks
// `Unsupported` must map to an absent capability. The mapping between the two
// vocabularies is explicit below — it is the thing a reviewer should read.
//
// Zero dependencies, node built-ins only (root CLAUDE.md: adding a dependency is
// a security decision), matching the other guards in this directory.

import { readFileSync } from "node:fs";

const DESCRIPTOR = "web/src/platform/capabilities.ts";
const TABLE = "web/wasm/src/capability.rs";

/**
 * Capability → the plugins (or specific commands) whose absence it represents.
 *
 * Explicit rather than inferred: the two vocabularies are deliberately
 * different — a capability is a *product feature*, a table entry is a *command
 * surface* — and guessing a correspondence would be the guard inventing the
 * agreement it is supposed to check.
 *
 * A capability with an empty list is one the backend has nothing to say about
 * (it is a pure UI/OS concern), and that is stated rather than omitted.
 */
const CAPABILITY_BACKING = {
  clipper: ["clipper-pairing"],
  localAi: ["local-inference"],
  // No ported command surface: the watch queue is drained by native code, and
  // `captures` is gated out of the wasm build at the module level.
  watchCapture: [],
  shareImport: [],
  biometricQuickUnlock: [
    "plugin:quick-unlock|quick_unlock_setup_biometric",
    "plugin:quick-unlock|quick_unlock_with_biometric",
  ],
  // OS-level idle detection; the pref itself is a normal synced field, so there
  // is deliberately no refused command behind this one.
  osIdleAutoLock: [],
  screenCaptureProtection: ["plugin:prefs|set_screen_capture_protection"],
  // The whole plugin (owner decision, 2026-07-27 / task 72): repair scans a
  // vault DIRECTORY for orphan artefacts, which exists because a desktop
  // directory is writable by other software. An OPFS container has one writer.
  vaultRepair: ["vault-repair"],
  // Deliberately empty, and the emptiest entry in this map has the most to say.
  // `localOnlyVault` is absent on web, but `vault_delete` is DISPATCHED there —
  // the command runs and removes the same bytes. What the absence changes is the
  // COPY around it (a sign-out, not a destruction), so there is no refused
  // command to point at, and a non-empty list here would be wrong in the
  // direction that breaks the build for a real feature.
  localOnlyVault: [],
  // The `importer` plugin's two commands ARE the host-confined read, so this
  // backing is non-empty even though the feature they served still ships on web
  // through a different mechanism (the directory picker, task 71).
  hostDirectoryRead: ["importer"],
  // The two READ commands are the whole backend surface of this capability;
  // extraction itself has no command (it runs inside `attachment_import`, and
  // web already injects the no-op extractor `attachment_import_with_dir` has
  // always used, so nothing unreachable is attempted).
  attachmentTextSearch: [
    "plugin:attachments|attachment_read_text",
    "plugin:attachments|attachment_read_structured",
  ],
  // Never had commands — the legacy layout does not exist in OPFS.
  vaultMigration: [],
  backup: ["backup"],
  // A seam refusal (`dialog.save`), not an IPC command.
  nativeSaveAs: [],
  vaultCreation: ["vault-creation"],
  phraseRecovery: [
    "plugin:vault-recover|recover_with_phrase",
    "plugin:vault-recover|complete_recovery",
  ],
  vaultExport: ["export"],
  // Task 47: the whole `spell` plugin is refused. `MYD1` itself is deliberately
  // NOT here — it is vault content, not a command surface, and it keeps syncing.
  spellCheck: ["spell"],
  // Task 48: the whole `pdf-export` plugin is refused. The markdown and
  // attachment downloads are deliberately NOT behind this — they ship.
  pdfExport: ["pdf-export"],
  // MYND-490 (cli-thin-client task 12): the whole `cli-bridge` plugin. Its one
  // command reports the CLI door's session state, and both facts it answers
  // presuppose a machine — a local socket the desktop binds, and a sidecar
  // binary on a filesystem. The three `prefs|set_cli_*` setters are deliberately
  // NOT here: they write ordinary `vault.prefs` fields that sync to every
  // client, and a desktop that later reads them must see what the user chose.
  cliAccess: ["cli-bridge"],
};

const descriptor = readFileSync(DESCRIPTOR, "utf8");
const table = readFileSync(TABLE, "utf8");

/** The `ABSENT` set's members, read from the TypeScript. */
function absentCapabilities() {
  const start = descriptor.indexOf("const ABSENT");
  if (start === -1) return [];
  const open = descriptor.indexOf("[", start);
  const close = descriptor.indexOf("]);", open);
  if (open === -1 || close === -1) return [];
  return descriptor
    .slice(open, close)
    .split("\n")
    .map((l) => (l.includes("//") ? l.slice(0, l.indexOf("//")) : l))
    .flatMap((l) => [...l.matchAll(/"([A-Za-z]+)"/g)].map((m) => m[1]));
}

/**
 * Entries the Rust table classifies `Unsupported`, comments stripped.
 *
 * Comments are stripped LINE BY LINE and the result is then flattened before
 * matching, because rustfmt wraps a long `PER_COMMAND` entry across four lines:
 *
 *     (
 *         "plugin:quick-unlock|quick_unlock_setup_biometric",
 *         Class::Unsupported,
 *     ),
 *
 * A line-at-a-time regex misses every one of those — which it did on the first
 * run, reporting four false disagreements. Worth the note: a guard that
 * mis-parses in the *other* direction would have passed silently, and this one
 * only failed loudly because its assertions are stated as "must be present".
 */
function unsupportedEntries() {
  const flattened = table
    .split("\n")
    .map((l) => (l.includes("//") ? l.slice(0, l.indexOf("//")) : l))
    .join(" ")
    .replace(/\s+/g, " ");
  const out = new Set();
  for (const m of flattened.matchAll(/\(\s*"([^"]+)"\s*,\s*Class::Unsupported\s*,?\s*\)/g)) {
    out.add(m[1]);
  }
  return out;
}

const absent = absentCapabilities();
const unsupported = unsupportedEntries();
const problems = [];

// A parse that found nothing would make every check below vacuously pass.
if (absent.length === 0) {
  problems.push(`could not read the ABSENT set out of ${DESCRIPTOR}`);
}
if (unsupported.size === 0) {
  problems.push(`could not read any Class::Unsupported entry out of ${TABLE}`);
}

// 1. Every absent capability's backing is genuinely refused by the dispatcher.
for (const cap of absent) {
  const backing = CAPABILITY_BACKING[cap];
  if (backing === undefined) {
    problems.push(
      `capability "${cap}" is marked absent in ${DESCRIPTOR} but has no entry in ` +
        `this guard's CAPABILITY_BACKING map. Add one — an empty list is a valid ` +
        `answer (a pure UI/OS concern with no command surface) and must be stated.`,
    );
    continue;
  }
  for (const entry of backing) {
    if (!unsupported.has(entry)) {
      problems.push(
        `capability "${cap}" is ABSENT in the UI, but "${entry}" is not ` +
          `Class::Unsupported in ${TABLE}.\n` +
          `    The UI would omit the affordance while the dispatcher still answers ` +
          `the command — a working feature made unreachable, reported by nothing.`,
      );
    }
  }
}

// 2. Every dispatcher refusal is covered by an absent capability.
const covered = new Set(absent.flatMap((c) => CAPABILITY_BACKING[c] ?? []));
for (const entry of unsupported) {
  if (!covered.has(entry)) {
    problems.push(
      `"${entry}" is Class::Unsupported in ${TABLE}, but no ABSENT capability in ` +
        `${DESCRIPTOR} covers it.\n` +
        `    The UI would offer an affordance the dispatcher refuses — the same ` +
        `broken-control failure task 27 exists to prevent, arriving from the other side.`,
    );
  }
}

if (problems.length) {
  console.error("web capability descriptor vs dispatcher:\n");
  for (const p of problems) console.error(`  ${p}\n`);
  process.exit(1);
}

console.log(
  `web capabilities: ok (${absent.length} absent, cross-checked against ` +
    `${unsupported.size} Class::Unsupported entries)`,
);
