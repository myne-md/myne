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
// Zero dependencies, node built-ins only (root AGENTS.md: adding a dependency is
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
  localAi: ["local-inference", "agent", "memory"],
  // myne-md/myne#788. The whole plugin, absent on web by the feature's own
  // verdict (no OS file ingress in a browser).
  plainFile: ["plain-file"],
  // Desktop self-update: the whole `update` plugin, absent on web by platform
  // fact (`tauri-plugin-updater` has no browser target).
  selfUpdate: ["update"],
  // myne-md/myne#860. The whole `diagnostics` plugin: the web build installs
  // no `tracing` subscriber at all (`design-notes/ops/0366`), so every one
  // of its commands presupposes a log that cannot exist there.
  diagnosticLog: ["diagnostics"],
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
  // The `vault.prefs` setter AND the whole `screen-capture` plugin
  // (myne-md/myne#482 + #483). The plugin is named wholesale rather than
  // per command because all three of its commands presuppose a capture
  // affinity a page does not have: two read and write the device-local
  // override of it, and the third re-asserts it after a re-show.
  screenCaptureProtection: [
    "plugin:prefs|set_screen_capture_protection",
    "screen-capture",
  ],
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
  // The SAME plugin entry as the line above, and that is correct rather than a
  // copy-paste (myne-md/myne#464). The `importer` namespace holds two unrelated
  // command groups: the host-confined directory read, and the six
  // `import_source_*` commands that open a SECOND local vault read-only. Both
  // capabilities are absent on web, and the dispatcher refuses the whole plugin,
  // so both name the plugin.
  //
  // Naming the six commands individually was tried and is wrong here: this map
  // is compared against the literal `(name, Class::Unsupported)` entries in the
  // Rust table, and the table classifies by PLUGIN. A per-command backing
  // therefore fails direction 1 for a plugin that genuinely refuses every one of
  // them, which is the guard reporting on the shape of its own input rather than
  // on the system.
  vaultImport: ["importer"],
  // The two READ commands are the whole backend surface of this capability;
  // extraction itself has no command (it runs inside `attachment_import`, and
  // web already injects the no-op extractor `attachment_import_with_dir` has
  // always used, so nothing unreachable is attempted).
  attachmentTextSearch: [
    "plugin:attachments|attachment_read_text",
    "plugin:attachments|attachment_read_structured",
    "plugin:attachments|attachment_read_extracted_text",
  ],
  // The whole-vault v0.1→v0.2 re-key (#420) is a desktop-only, on-disk
  // migration — a web/OPFS container is provisioned current and never carries a
  // v0.1 layout to migrate, so the dispatcher refuses `vault-migrate` and the
  // `MigrateVaultForm` is gated behind this (absent-on-web) capability.
  vaultMigration: ["vault-migrate"],
  // Deliberately empty, and for the reason `phraseEnrolment` states one screen
  // down: there is no refused command behind it. Empty, and it stays empty now
  // that the web person plane SHIPS (myne-md/myne#911 task 13): both
  // `vault_is_person_wrapped` and `unlock_with_person_phrase` are dispatched, so
  // the unlock screen's identity-phrase arm is an offer the command answers.
  // (The paragraph this replaced argued the opposite from the plugin's `Pending`
  // default and was kept beside its own correction for a round; the review found
  // the pair contradicting each other.)
  personVaultCredential: [],
  // Empty for the same shape of reason: the identity plane's commands are
  // dispatched, so nothing is refused BECAUSE of this capability. What it names
  // is the PLANE, which the SyncPanel's identity row gates on now that the two
  // are split (task 13); the member surface's commands stay covered by
  // `memberSharing` below.
  personIdentity: [],
  // Empty, and it is the entry task 13 added rather than a refusal: a browser
  // keeps NO person credential at rest (the sealed keypair and the device token
  // live in the Worker's memory), which is a COPY fact and not a command
  // refusal. The phrase step says the words are asked for again on reload.
  personCredentialPersisted: [],
  backup: ["backup"],
  // A seam refusal (`dialog.save`), not an IPC command.
  nativeSaveAs: [],
  // `decisions.md` 2026-08-15 ships creation on web, so `vaultCreation` is no
  // longer absent and no longer appears in the descriptor's ABSENT set. The
  // entry stays here, empty, because this map is also read as documentation of
  // what a capability's backend surface IS, and deleting the key would make a
  // future reader think the mapping was never considered.
  vaultCreation: [],
  // The clipboard auto-clear moved out of `vaultCreation` and onto its own
  // capability in the same change. It had to move: the command is still
  // `Unsupported` (Firefox grants page content no clipboard read, so the clear
  // would silently never fire), and check 2 below requires every refusal to be
  // covered by an ABSENT capability. Leaving it under a capability that is now
  // present would have failed the guard, which is the guard doing its job.
  //
  // The old reason lived above `vaultCreation` and stayed there when the
  // command moved, so it went on asserting two claims this change falsified:
  // that the auto-clear's callers were substituted out of the bundle (creation
  // ships now), and that "a web client has no recovery phrase to put on the
  // clipboard in the first place" (it does, and Copy is offered — see
  // `recovery-flow.md` §2.2's web arm). What survives of it is the ONE reason
  // that was ever durable, and it is stated above: no clipboard read, so no
  // read-back, so no safe clear. `save_secret_text` is deliberately NOT here:
  // it also serves the theme export, which ships on web through the download
  // seam.
  clipboardAutoClear: ["plugin:secret-export|clipboard_clear_if_matches"],
  phraseRecovery: [
    "plugin:vault-recover|recover_with_phrase",
    "plugin:vault-recover|complete_recovery",
  ],
  // Deliberately empty, and for the same reason `localOnlyVault` is: there is
  // no refused command behind it. `plugin:sync|sync_enroll` IS dispatched on
  // web and would accept a phrase-derived credential perfectly well. What is
  // absent is the OFFER — the credential picker's recovery arm. The 24-cell grid
  // ships since `decisions.md` 2026-10-18 (entry 0704), which retired the
  // build-time substitution and the artefact grep
  // (`scripts/check-web-no-phrase.mjs`) that used to keep it out, so what this
  // flag now hides is a rendered arm and not a module.
  //
  // Pointing this at the `vault-recover` commands would be wrong twice over: it
  // would claim a refusal that does not exist, and `decisions.md` 2026-08-15
  // ships those two commands on web, so the entry would break the moment
  // recovery lands while saying nothing true about enrolment.
  phraseEnrolment: [],
  vaultExport: ["export"],
  // Task 47: the whole `spell` plugin is refused. `MYD1` itself is deliberately
  // NOT here — it is vault content, not a command surface, and it keeps syncing.
  spellCheck: ["spell"],
  // Task 48: the whole `pdf-export` plugin is refused. The markdown and
  // attachment downloads are deliberately NOT behind this — they ship.
  pdfExport: ["pdf-export"],
  // Deliberately empty, for the same reason `localOnlyVault` is.
  // `plugin:attachments|attachment_import` IS dispatched on web — images import
  // there, they are just stored as given, because the transform inside that one
  // command is gated off (`compress::is_supported_on_this_target`). And the
  // preference behind it is ordinary shared vault content that this client reads,
  // writes and syncs. So there is no refused command to point at: what the
  // absence governs is the COPY on the settings row.
  imageCompression: [],
  // MYND-490 (cli-thin-client task 12): the whole `cli-bridge` plugin. Its one
  // command reports the CLI door's session state, and both facts it answers
  // presuppose a machine — a local socket the desktop binds, and a sidecar
  // binary on a filesystem. The three `prefs|set_cli_*` setters are deliberately
  // NOT here: they write ordinary `vault.prefs` fields that sync to every
  // client, and a desktop that later reads them must see what the user chose.
  cliAccess: ["cli-bridge"],
  // myne-md/myne#411: the whole `vault-label` plugin, meaning the flag, the
  // setter that performs the erase, and the keychain probe. All three serve the locked
  // picker, which `check-web-screens.mjs` records as `excluded` on web, and all
  // three sit on top of an OS keychain a page does not have. `MYL1` itself is
  // deliberately NOT what this names: the format is unchanged and the desktop
  // row is ungated.
  lockedVaultNames: ["vault-label"],
  // MYND-650 task 6: the two toggle commands, NOT the whole `sync` plugin —
  // sync itself ships on web and most of its surface is dispatched. The pair is
  // singled out because what they do is spawn and stop an OS process and point
  // a raw socket at it, which is the half a page does not have.
  torRouting: [
    "plugin:sync|sync_get_tor_routing",
    "plugin:sync|sync_set_tor_routing",
    // Task 8: the live posture read behind the connection-state UI.
    "plugin:sync|sync_get_tor_state",
  ],
  // myne-md/myne#684: the account/vault split. The whole `account` plugin is
  // absent on web (one vault per origin, no keychain), so the grouping UI is
  // omitted rather than rendered against commands that reject.
  accountGrouping: ["account"],
  // myne#678 (epic #173): the pop-out spawn plugin. Desktop-only; a browser page
  // cannot open a second OS window.
  detachedWindows: ["detached-window"],
  // Live-collab `SYNC-31`. Deliberately empty, for the same reason
  // `localOnlyVault` and `imageCompression` are: this is a pure UI/identity
  // concern with no refused command of its own. The awareness transport exposes
  // wasm exports, not an IPC command, and the person/membership commands it would
  // rely on are already refused under `memberSharing`. Pointing this at those
  // would double-count an absence that capability already covers.
  liveCollabMultiUser: [],
  // Live-collab `collab-presence-ui`. The awareness CURSOR consumer is a native
  // SSE supervisor and the web Worker-side consumer is not built, so the local
  // presence report is refused there. Named per command (the whole `live` plugin
  // ships and dispatches its session commands), so a future cursor port on web
  // must move this entry rather than inherit a blanket absence.
  liveCollabAwarenessCursors: ["plugin:live|live_session_set_presence"],
  // myne-md/myne#698: the B2B member-sharing surface (the roster, the invite and
  // the removal rekey). Named per command, NOT as the whole `sync` plugin, which
  // ships on web and dispatches most of its surface. **myne-md/myne#911 task 13
  // moved the IDENTITY plane out of this list and into the dispatcher**: create,
  // register, status, the person device join and the vault listing ship on web
  // now, because the identity is the user's own keypair and token while
  // everything still named here needs a group key and a signed roster.
  // They are refused because the person identity's carrier is a device-local
  // sealed file outside the browser's storage and the panel asks for the
  // recovery phrase to unlock it, which `docs/vision.md` keeps out of served
  // code by build-time substitution. The identity setup/status/invite commands
  // (myne-md/myne#711) join them for the same reason; the invite/decode pair
  // needs the held identity to wrap the group key.
  memberSharing: [
    "plugin:sync|sync_person_unlock",
    "plugin:sync|sync_person_lock",
    // myne-md/myne#911 splits setup into a network-free create and an explicit
    // register. Both take the phrase across a prompt or return it once, which is
    // the half served code may not hold; a browser still reaches its own
    // identity story through the web first-run step instead.
    "plugin:sync|sync_publish_vault",
    "plugin:sync|sync_published_state",
    "plugin:sync|sync_person_list_invites",
    "plugin:sync|sync_list_vault_invites",
    "plugin:sync|sync_person_accept_invite",
    // The SECOND device's join (myne-md/myne#852 task 7). Same refusal, same
    // reason, one command over from the accept above: it is the accept path with
    // the out-of-band code replaced by the owner identity PINNED in the person's
    // own sealed profile, so it needs the held person identity for exactly the
    // same reason and the form asks for the phrase for exactly the same reason.
    "plugin:sync|sync_member_join_vault",
    "plugin:sync|sync_person_unlock_member_vault",
    "plugin:sync|sync_member_vault_status",
    "plugin:sync|sync_person_set_member_password",
    "plugin:sync|sync_person_unlock_member_vault_with_password",
    "plugin:sync|sync_person_set_member_pin",
    "plugin:sync|sync_person_set_member_biometric",
    "plugin:sync|sync_person_unlock_member_vault_with_pin",
    "plugin:sync|sync_person_unlock_member_vault_with_biometric",
    "plugin:sync|sync_member_unlock_status",
    "plugin:sync|sync_person_clear_member_unlock",
    "plugin:sync|sync_person_create_invite",
    "plugin:sync|sync_start_b2b_migration",
    "plugin:sync|sync_list_roster",
    "plugin:sync|sync_remove_member",
    // The member display-name writers (myne-md/myne#851): a separate command
    // namespace and the same capability refusal, since a name row is signed by a
    // person identity a served page cannot hold.
    "plugin:member-names|member_names_set_mine",
    "plugin:member-names|member_names_clear_mine",
    // The device-to-person binding store (myne-md/myne#852): the device list and
    // the claim, one namespace over from the names above and refused for the
    // same reason. The store is `NTV6`-only and group-tier sealed, the claim
    // signs with the session's person identity, and a served page holds neither
    // the group key nor that identity. The panel is substituted out of the web
    // bundle entirely (`web/vite.config.ts`), so this entry is what keeps the
    // two lists agreeing rather than the only thing hiding the affordance.
    "plugin:device-binding|device_bindings_list",
    "plugin:device-binding|device_bindings_claim",
  ],
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
