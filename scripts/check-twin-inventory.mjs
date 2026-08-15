#!/usr/bin/env node
// Every desktop/mobile twin module has a verdict, and no verdict outlives its
// files (myne-md/myne#472, epic myne-md/myne#242).
//
// # The failure this prevents
//
// Desktop and mobile compile from trees meant to share their decisions and
// sharing almost none of them: 90 same-relative-path twins, 19 byte-identical,
// 71 drifted. `scripts/check-twin-drift.mjs` (#261) warns when a change touches
// one side and leaves the other alone, which covers a NEW one-sided change and
// says nothing about the drift that already exists. So "fix the drift" is an
// unbounded ask that never starts, and the seven sibling sub-features have no
// agreed list to drain.
//
// Worse, a twin that ENTERS the set is invisible to everything. `decisions.md`
// 0488 names that case as its own failure signal, in as many words: "A `mobile/`
// directory that started to grow its own copy of a shared screen would be the
// signal that this decision had failed." This script is that sentence,
// mechanised.
//
// # The four verdicts
//
//   decision:   both clients answer the same question, so a divergence is a bug
//                by definition. Belongs in a shared package; carries a
//                destination.
//   screen:     the file exists TO BE per-client. Two clauses, and the second
//                was added under review rather than discovered later: the
//                surface a client renders (layout, navigation shape) and the
//                host it renders into (entry points, build-time ambient
//                globals). Three of the four entries carrying it are the second
//                clause, and the one-clause definition described none of them.
//                Still deliberately narrow: what it excludes is a file that
//                merely HAPPENS to differ per client, which is every `decision`
//                in the roster.
//   absent:     one client does not ship the surface. Names the decision or
//                issue that made it so, because a gap and a decision look
//                identical in a diff stat.
//   delegated:  the shared answer already lives in `myne-core` or a `@myne/*`
//                package, and this file is per-client wiring over it. Its
//                divergence is correct and permanent.
//
// # Two directions, and the second is the one that rots quietly
//
// A discovered pair with no roster entry fails as `missing`. A roster entry
// whose files are gone fails as `stale`. Only the first is obvious; the second
// is what stops this roster describing a tree that has moved.
// `scripts/check-web-screens.mjs` makes the same argument for the same reason.
//
// # Why this does not import `scripts/lib/shared-roots.mjs`
//
// That library is the one roster of trees compiled into more than one client,
// and importing it is normally the right move. It does not fit here: it is a
// FLAT list, this needs ordered tree-root PAIRS, and `src-tauri/src` is not on
// it at all. Its own contract allows a narrower or differently shaped scope
// provided the guard says so in its header rather than keeping a silent copy.
// This is that sentence.
//
// # Why basename discovery is excluded, and what replaces it
//
// A basename sweep over the same trees finds roughly 44 more candidates and
// most are false: `index.ts` matches `index.ts` six times, `state.rs` matches an
// unrelated `state.rs` four times. Recording those as twins would turn
// bookkeeping into permanent noise.
//
// The genuine cross-path pairs go in `CURATED_TWINS` instead. **A pair enters
// that list when the two files answer the same product question and the path
// sweep cannot find them**, and every entry carries a named reason, reviewed
// exactly like a verdict. That is the whole criterion; it is short on purpose,
// because the alternative is a list nobody can argue with.
//
// There is no mechanical candidate finder, and that is a decision rather than an
// omission. Five known pairs do not justify one. A name-based finder is the
// basename sweep by another route, with the same false-positive rate. And a
// symbol-overlap finder would miss the two entries that matter most, because
// `src/App.tsx` against `mobile/src/app/AppShell.tsx` and
// `src/notes/sidebarState.tsx` against `mobile/src/app/flows/EditorFlow.tsx` are
// behavioural counterparts rather than name matches: nothing textual relates
// them. The list is maintained by review, and the `curated-stale` check below is
// what stops it describing files that have moved.
//
// # Two difference fields, and only one of them may gate
//
// Every pair gets a BYTE flag and a SEMANTIC one, and they answer different
// questions.
//
// The byte flag is mechanical: are the two files equal. No judgement, nothing to
// argue with, and it stays in the record because a real divergence should be
// visible even when it does not matter.
//
// The semantic comparison is the one myne-md/myne#473 may gate on, because
// 16 of the 76 drifted pairs are byte-different and behave identically. Four pairs (`vault-status.ts`, `vault-slot-kind.ts`,
// `vault-recover.ts`, `vault-change-password.ts`) differ in exactly one line,
// the seam import, and `src/platform/core.ts` is a bare re-export of the module
// mobile imports directly. `src/types/vault-summary.ts` differs only in a JSDoc
// bullet. Two `src/dialect/` shims differ only by a header comment, and which
// side carries it flips between them. Gating on bytes would make those permanent
// red entries that no sibling can close.
//
// **The rule: two files are semantically identical iff they compare equal after
// stripping comments and canonicalizing the seam import specifier.**
//
// An exported-surface comparison was considered and rejected: it would miss
// myne-md/myne#485, where mobile's `resample_linear` carries desktop's signature
// and not its ceiling. Signatures matching is not behaviour matching.
//
// The seam map is DERIVED from `src/platform/` at runtime, never hardcoded here.
// A hardcoded copy is a second roster that can drift from the seam it describes,
// which is the failure `scripts/lib/shared-roots.mjs` exists to end. A seam
// module counts only when it re-exports exactly one `@tauri-apps/*` specifier;
// anything more complicated is not a bare alias and is left alone.
//
// The normalizer is deliberately conservative, and the direction of its error is
// chosen. Stripping too little reports drift that is not there, and a human
// looks. Stripping too much hides drift that is, and nobody looks. So it strips
// comments and the seam specifier, and nothing else.
//
// # Output discipline
//
// Paths and counts, never file content. A guard that prints a diff hunk into a
// public Woodpecker log has published source and any fixture-shaped constant in
// it, which is why `lefthook.yml`'s secret-scan masks its own matches.
//
// Zero dependencies, node built-ins only. Run by hand:
//   node scripts/check-twin-inventory.mjs
//   node scripts/check-twin-inventory.mjs --emit    (regenerate docs/dev/twin-inventory.md)
//   node scripts/check-twin-inventory.mjs --roots <desktopDir> <mobileDir>
//
// # The prose projection
//
// `--emit` regenerates `docs/dev/twin-inventory.md` from this roster. The
// document is a PROJECTION, never a second source: hand-editing it is undone by
// the next `--emit`, and CI never passes the flag, so the check half runs
// whether or not anyone regenerates the prose.
//
// It lives in `docs/` rather than in the private agents companion because the
// deliverable includes a rubric two people have to reach the same answer with,
// and an outside contributor to this AGPL repository cannot read that companion.
// The content is paths and verdicts about public code, so there is nothing to
// withhold.

import {
  readdirSync,
  statSync,
  existsSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { join, relative, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Repo-relative paths are resolved against THIS FILE's location, never against
 * `process.cwd()`.
 *
 * Run from a subdirectory, a cwd-relative guard reports six curated pairs as
 * naming files that no longer exist, all six of which exist: a false diagnosis
 * rather than an orientation error, and the reader has no way to tell which one
 * they are looking at. `check-unwired.mjs` anchors on `import.meta.url` for
 * exactly this reason.
 *
 * Every path the guard PRINTS or stores stays repo-relative, because those are
 * the strings the roster and the published projection are written in. `at` is
 * applied only at the moment of touching the filesystem. It uses `resolve`
 * rather than `join` so an absolute path passes through untouched, which is what
 * `--roots` hands it.
 */
const REPO = join(dirname(fileURLToPath(import.meta.url)), "..");
const at = (p) => resolve(REPO, p);

/**
 * Ordered tree-root pairs. First element is the desktop side, second is the
 * mobile side, and a twin is a file present at the same relative path under
 * both.
 */
const TREE_PAIRS = [
  ["src", join("mobile", "src")],
  [join("src-tauri", "src"), join("mobile", "src-tauri", "src")],
];

/** The unit is the pair, so every set and every sort keys on both paths. */
const pairKey = (t) => `${t.a}::${t.b}`;

const SKIP_DIRS = new Set(["node_modules", "target", "dist", ".git", "gen"]);

/**
 * Twins the path sweep cannot see, because their two sides sit at different
 * paths. Seeded from `scripts/check-twin-drift.mjs`'s `NAMED_TWINS` and then
 * verified pair by pair against the tree, which is how the `App.tsx` correction
 * below was found.
 *
 * `NAMED_TWINS`'s third entry, `src-tauri/src/hooks.rs`, is deliberately absent
 * here: it is a SAME-path twin, so the sweep already discovers it and a curated
 * entry would record it twice.
 */
/** The one reason 15 delegating shims share, hoisted so it cannot drift into 15 variants. */
// The shared reason for the plugin shims, and it deliberately stops short of the
// capability grant.
//
// An earlier draft asserted the grant was "correct by construction" for all of
// them. That was never measured: only `themes` was compared, and
// `threat-model.md` makes a capability grant a load-bearing control in its own
// words. Under a verdict whose definition is "the divergence is correct and
// permanent", a blanket claim about the one divergence class that IS
// security-load-bearing would tell every future reader that a mobile plugin
// with a wider grant than its desktop twin is fine by definition. It says
// instead what was actually measured, and names the gap.
//
// It also no longer claims a specific re-export path. Sixteen of its seventeen
// users carry `pub use myne_core::plugins::<flow>`; `vault_label/mod.rs` carries
// `pub use myne_core::vault_label::` (a crate-root module) and has its own
// reason, as does `plugins/mod.rs`, which is a `pub mod` roster with no builder
// at all.
const SHIM_REASON =
  "Host-registration shim. Both sides carry `pub use myne_core::plugins::<flow>` and keep only the Tauri plugin builder and its capability grant, so the shared answer is already in `myne-core` and the divergence is the wiring. Measured, not inferred: the `pub use` is on both sides. NOT measured, and deliberately not claimed: that the two capability grants match. That comparison is myne-md/myne#473's, and until it runs this verdict says nothing about the ACL.";

const CURATED_TWINS = [
  {
    a: "src/App.tsx",
    b: "mobile/src/app/AppShell.tsx",
    why:
      "The boot probe, `reprobe`, the Stage switch and the dispatch, on both clients. " +
      "CORRECTION to `check-twin-drift.mjs`'s `NAMED_TWINS`, which pairs `src/App.tsx` with " +
      "`mobile/src/lib/stage.ts`. That is the Stage table, not the shell: the behavioural " +
      "counterpart is `AppShell.tsx`, and `mobile/src/lib/stage.ts` already has its own same-path " +
      "twin in `src/lib/stage.ts`. Aiming the pair one file to the left is why two live routing " +
      "divergences went unseen. `check-twin-drift.mjs` is left unmodified; correcting it is " +
      "myne-md/myne#473's call.",
  },
  {
    a: "src/notes/sidebarState.tsx",
    b: "mobile/src/app/flows/EditorFlow.tsx",
    why:
      "Mobile re-implements the note-flag predicates rather than importing them from " +
      "`@myne/editor/host/notes/selectors`. This epic's own motivating case, and it is outside the " +
      "90 the path sweep finds, so a record fixed at 90 would omit the defect the epic exists to " +
      "fix. Line counts (1345 against 3384) are meaningless for this pair: it is a behavioural " +
      "counterpart, not a copy, so only the semantic comparison of the shared predicates says " +
      "anything.",
  },
  {
    a: "src/notes/prefsNonce.ts",
    b: "mobile/src/lib/prefsNonce.ts",
    why:
      "Byte-identical at 60 lines, and neither side is a shim: this is real code with two homes. " +
      "It is the mechanism `check-prefs-nonce.mjs` exists to protect, duplicated across the trees " +
      "the guard is meant to hold, which makes it the sharpest argument for why the curated half " +
      "of the denominator is not optional.",
  },
  {
    a: "src/notes/localDateTime.ts",
    b: "mobile/src/lib/localDateTime.ts",
    why:
      "Shim against hand copy. Desktop is a one-line `export * from " +
      '"@myne/editor/host/notes/localDateTime"`; mobile carries 33 lines of its own. Desktop ' +
      "already delegates and mobile has not been pointed at the same source.",
  },
  {
    a: "src/notes/attachmentRef.ts",
    b: "mobile/src/lib/attachmentRef.ts",
    why:
      "Shim against hand copy, same shape as localDateTime. Desktop re-exports " +
      '`@myne/editor/host/notes/attachmentRef`; mobile carries 69 lines.',
  },
  {
    a: "src/dialect/welcomeNote.ts",
    b: "mobile/src/lib/welcomeNote.ts",
    why:
      "Shim against hand copy, and the one case where mobile carries BOTH. " +
      "`mobile/src/dialect/welcomeNote.ts` is the one-line shim into `@myne/dialect` (already a " +
      "same-path twin, classified `delegated`), while `mobile/src/lib/welcomeNote.ts` is a " +
      "separate 62-line copy at a different path. The shared source is `dialect/src/welcomeNote.ts` " +
      "at 37 lines, so the copy is not even a stale duplicate of it. This is the English-only " +
      "welcomeNote named in `check-twin-drift.mjs`'s own header.",
  },
];


/**
 * The verdict for every classified twin.
 *
 * An ARRAY rather than a map keyed on the desktop path, because a desktop file
 * may have two mobile counterparts and both may be real twins: `src/App.tsx` has
 * a same-path twin in `mobile/src/App.tsx` and a behavioural counterpart in
 * `mobile/src/app/AppShell.tsx`. The unit is the pair, so the record is a list
 * of pairs.
 *
 * Line counts and the byte/semantic flags are deliberately NOT recorded here.
 * They are derived, `compare()` computes them on every run, and the header
 * argues above that a recorded flag goes stale the moment either file is edited.
 * An earlier draft carried a `lines` tuple anyway; it was dead (nothing read
 * it), and it had already rotted, being `split("\n").length` rather than `wc -l`
 * on all 96 entries. The projection renders live counts instead.
 */
const ROSTER = [
  // ── src/dialect/: nine re-export shims into the shared @myne/dialect package
  //
  // Every one is a one-line `export * from "@myne/dialect/<module>"`. The source
  // of truth moved out of both trees in the Phase A editor/dialect extraction
  // (decisions.md 0281), so neither side holds logic and neither side can drift
  // in a way that matters. `delegated`, all nine.
  //
  // Two of them differ, and only by a header comment. Which side carries the
  // comment FLIPS between the two files: mobile's `conflictCopy.ts` explains the
  // seam, desktop's `folderPath.ts` explains the migration. That is the cleanest
  // available evidence for why a byte comparison is not a drift measurement, and
  // it is why this tree was chosen to prove the mechanism.
  {
    a: "src/dialect/conflictCopy.ts",
    b: "mobile/src/dialect/conflictCopy.ts",
    verdict: "delegated",
    destination: "@myne/dialect",
    reason:
      "Re-export shim. Mobile's copy carries a five-line header naming the ConflictCopyHost seam and SYNC-11; desktop's is bare. Comment-only difference.",
  },
  {
    a: "src/dialect/folderPath.ts",
    b: "mobile/src/dialect/folderPath.ts",
    verdict: "delegated",
    destination: "@myne/dialect",
    reason:
      "Re-export shim. Desktop's copy carries a four-line header about the Phase A extraction; mobile's is bare. Comment-only difference, and the commented side is the opposite one from conflictCopy.ts.",
  },
  {
    a: "src/dialect/lezer/frontmatter.ts",
    b: "mobile/src/dialect/lezer/frontmatter.ts",
    verdict: "delegated",
    destination: "@myne/dialect",
    reason: "Re-export shim, byte-identical.",
  },
  {
    a: "src/dialect/parse.ts",
    b: "mobile/src/dialect/parse.ts",
    verdict: "delegated",
    destination: "@myne/dialect",
    reason: "Re-export shim, byte-identical.",
  },
  {
    a: "src/dialect/surgery.ts",
    b: "mobile/src/dialect/surgery.ts",
    verdict: "delegated",
    destination: "@myne/dialect",
    reason: "Re-export shim, byte-identical.",
  },
  {
    a: "src/dialect/templateEngine.ts",
    b: "mobile/src/dialect/templateEngine.ts",
    verdict: "delegated",
    destination: "@myne/dialect",
    reason: "Re-export shim, byte-identical.",
  },
  {
    a: "src/dialect/types.ts",
    b: "mobile/src/dialect/types.ts",
    verdict: "delegated",
    destination: "@myne/dialect",
    reason: "Re-export shim, byte-identical.",
  },
  {
    a: "src/dialect/visitors/lineTasks.ts",
    b: "mobile/src/dialect/visitors/lineTasks.ts",
    verdict: "delegated",
    destination: "@myne/dialect",
    reason: "Re-export shim, byte-identical.",
  },
  {
    a: "src/dialect/welcomeNote.ts",
    b: "mobile/src/dialect/welcomeNote.ts",
    verdict: "delegated",
    destination: "@myne/dialect",
    reason:
      "Re-export shim, byte-identical. Not to be confused with mobile/src/lib/welcomeNote.ts, an English-only hand copy at a different path, which is the separate pair below.",
  },

  // ── the one curated pair that lands inside a classified root
  //
  // Classified here rather than deferred to task 4 because its location forces
  // it: `src/dialect/` is a classified root, so the guard demands a verdict the
  // moment the curated pair joins the set. Leaving the guard red to preserve a
  // task boundary would be bureaucracy, and the verdict is not in doubt.
  {
    a: "src/dialect/welcomeNote.ts",
    b: "mobile/src/lib/welcomeNote.ts",
    verdict: "decision",
    destination: "@myne/dialect",
    reason:
      "What a new vault's welcome note says is one question with one answer, and it is answered twice. Desktop is a one-line shim onto `dialect/src/welcomeNote.ts` (37 lines); mobile carries an unrelated 62-line hand copy at a different path while ALSO carrying the one-line shim at mobile/src/dialect/welcomeNote.ts. This is the English-only welcomeNote named in check-twin-drift.mjs's own header, and mobile holding both the shim and the copy is the clearest evidence in the tree that a path sweep alone cannot describe this problem.",
  },


  // ── the frontend twins: src/lib, src/types, src/ root, src/styles, plus the
  // four curated pairs that live under src/notes.
  //
  // Every "mirrors core/... measured" claim below was checked against the tree
  // rather than inferred from a filename: discriminator 5 turns on where the
  // Rust source actually lives, and one of these (vault-repair-error) turns out
  // NOT to be in core/ at all.
  {
    a: "src/App.tsx",
    b: "mobile/src/App.tsx",
    verdict: "screen",
    destination: "undecided",
    reason:
      "Same path, different responsibilities. Desktop's is the boot probe plus the Stage switch; mobile's is the gallery and viewport wrapper. The behavioural counterpart of desktop's App.tsx is mobile/src/app/AppShell.tsx, recorded as its own pair below.",
  },
  {
    a: "src/App.tsx",
    b: "mobile/src/app/AppShell.tsx",
    verdict: "decision",
    destination: "undecided",
    reason:
      "Boot probe, reprobe, the Stage switch and the dispatch. Both clients already agree the universal out-of-band exit is reprobe, which is the shareable core; the navigation shape around it is not. Destination waits on myne-md/myne#477.",
  },
  {
    a: "src/editor-host.ts",
    b: "mobile/src/editor-host.ts",
    verdict: "delegated",
    destination: "@myne/editor",
    reason:
      "The per-client INSTALLER of a seam whose contract is already shared in editor/src/host.ts. One per client is the design, not the drift: this is where a platform's absent members are omitted so the engine hides an affordance rather than showing one that throws.",
  },
  {
    a: "src/main.tsx",
    b: "mobile/src/main.tsx",
    verdict: "screen",
    destination: "undecided",
    reason:
      "Entry point. Each client composes a different boot side-effect set, in a different order, for its own host.",
  },
  {
    a: "src/vite-env.d.ts",
    b: "mobile/src/vite-env.d.ts",
    verdict: "screen",
    destination: "undecided",
    reason:
      "Build-time ambient globals. Per-client by construction.",
  },
  {
    a: "src/lib/account-number-format.ts",
    b: "mobile/src/lib/account-number-format.ts",
    verdict: "decision",
    destination: "undecided",
    reason:
      "Presentation-only input mask mirroring the display form in docs/spec/account-number.md 2. The code is identical today and only the comment prose differs; mobile's own header says it 'Ports the desktop src/lib/account-number-format.ts verbatim', which is this epic's subject stated by the copy itself.",
  },
  {
    a: "src/lib/app-window.ts",
    b: "mobile/src/lib/app-window.ts",
    verdict: "decision",
    destination: "undecided",
    reason:
      "LIVE unported fix. Desktop deleted closeApp() and moved it to the platform seam (src/platform/app-exit.ts) because its web arm was a console.warn, so on the screen where a user is most stuck the only button did nothing. Desktop now holds only the HAS_TAURI probe at 21 lines; mobile still carries the 66-line pre-fix version including that fallback. Destination waits on the seam decision, SYNC-2.",
  },
  {
    a: "src/lib/attachments.ts",
    b: "mobile/src/lib/attachments.ts",
    verdict: "decision",
    destination: "undecided",
    reason:
      "IPC wrapper and DTO mirror over the shared attachments core. The two sides register genuinely different command subsets, which is an absence question per command rather than per file; the wrapper shape itself is one answer. Its error taxonomy overlaps myne-md/myne#475.",
  },
  {
    a: "src/lib/bip39-normalize.ts",
    b: "mobile/src/lib/bip39-normalize.ts",
    verdict: "decision",
    destination: "undecided",
    reason:
      "Byte-identical. Recovery-phrase normalization has exactly one right answer and it is on the credential path, so a divergence here is a correctness bug rather than a style difference.",
  },
  {
    a: "src/lib/device-name.ts",
    b: "mobile/src/lib/device-name.ts",
    verdict: "decision",
    destination: "undecided",
    reason:
      "How a device names itself to the account. One answer, and it is what another device's user reads when approving an enrolment.",
  },
  {
    a: "src/lib/io-banner.ts",
    b: "mobile/src/lib/io-banner.ts",
    verdict: "decision",
    destination: "@myne/copy",
    reason:
      "RECLASSIFIED from `screen` to `decision`. Discriminator 1 (a `t()` key means screen) was applied mechanically and gives the wrong answer here: comment-stripped, the two files differ in exactly ONE line, the i18n import specifier, and mobile\'s own header states it reuses the desktop `vault.ioBanner.*` keys so both clients render byte-identical English. `screen` means the divergence IS the feature; here there is no divergence to be the feature. The `IoFailureKind` it switches on is shared through the type, and so, in fact, is every sentence it maps to. Discriminator 1 is a heuristic, and this is the case that shows it needs the second question: is the per-client rendering actually different?",
  },
  {
    a: "src/lib/load-bearing-copy.ts",
    b: "mobile/src/lib/load-bearing-copy.ts",
    verdict: "decision",
    destination: "@myne/copy",
    reason:
      "SYNC-42 strings whose exact wording is a privacy property. The destination is not undecided: @myne/copy exists, desktop already re-exports from it, and mobile's 256-line file is a hand copy. myne-md/myne#474 does the wiring.",
  },
  {
    a: "src/lib/password-generator.ts",
    b: "mobile/src/lib/password-generator.ts",
    verdict: "decision",
    destination: "undecided",
    reason:
      "Byte-identical. Generation parameters are a security property, not a preference: a weaker generator on one client is a weaker generator, full stop.",
  },
  {
    a: "src/lib/prefs.ts",
    b: "mobile/src/lib/prefs.ts",
    verdict: "decision",
    destination: "undecided",
    reason:
      "The vault.prefs write surface. protocol.md 9.5.2 enumerates the field roster normatively, so both clients are answering one specified question. Desktop routes every write through a writePref chokepoint that bumps the prefs nonce; mobile has 47 write literals and no chokepoint. myne-md/myne#477, and myne-md/myne#486 for the eight setters that never bump.",
  },
  {
    a: "src/lib/quick-unlock.ts",
    b: "mobile/src/lib/quick-unlock.ts",
    verdict: "decision",
    destination: "undecided",
    reason:
      "PIN and biometric quick-unlock wrapper over the shared myne-core core. Its error enum is in core/src/plugins/quick_unlock/error.rs, measured.",
  },
  {
    a: "src/lib/secret-export.ts",
    b: "mobile/src/lib/secret-export.ts",
    verdict: "decision",
    destination: "undecided",
    reason:
      "Recovery-kit export. What leaves the device in plaintext is one answer, and both clients must give it.",
  },
  {
    a: "src/lib/stage.ts",
    b: "mobile/src/lib/stage.ts",
    verdict: "decision",
    destination: "undecided",
    reason:
      "The Stage and Action unions plus the transition table. Set-differencing the two LEGAL tables yields exactly ONE substantive disagreement (unlock.join-success against editor.join-success), so this is the most shareable large module in the tree rather than the least. myne-md/myne#477.",
  },
  {
    a: "src/lib/themes.ts",
    b: "mobile/src/lib/themes.ts",
    verdict: "decision",
    destination: "undecided",
    reason:
      "Custom-theme listing and application over the MYT1 blob. The palette is synced vault content, so what a theme means cannot differ per client.",
  },
  {
    a: "src/lib/transcribe.ts",
    b: "mobile/src/lib/transcribe.ts",
    verdict: "decision",
    destination: "undecided",
    reason:
      "On-device transcription wrapper. Both clients run the same Whisper path, and myne-md/myne#485 is a live divergence one layer below this one.",
  },
  {
    a: "src/lib/vault-change-password.ts",
    b: "mobile/src/lib/vault-change-password.ts",
    verdict: "decision",
    destination: "undecided",
    reason:
      "Cosmetic-only today: the single differing line is the seam import. Its error enum is in core/src/plugins/vault_change_password/error.rs, measured, so discriminator 5 puts it squarely in the shared column.",
  },
  {
    a: "src/lib/vault-creation-logging.ts",
    b: "mobile/src/lib/vault-creation-logging.ts",
    verdict: "decision",
    destination: "undecided",
    reason:
      "Byte-identical. What is and is not logged during vault creation is a privacy decision, so a per-client answer would be a per-client privacy posture.",
  },
  {
    a: "src/lib/vault-delete.ts",
    b: "mobile/src/lib/vault-delete.ts",
    verdict: "decision",
    destination: "undecided",
    reason:
      "What a destructive action targets. Mobile still declares deleteVault(vaultId?: string), the optional shape myne-md/myne#250 removed because the fallback was the bug, with a docstring promising a backend fallback the shared Rust core has not accepted since. myne-md/myne#476.",
  },
  {
    a: "src/lib/vault-label.ts",
    b: "mobile/src/lib/vault-label.ts",
    verdict: "decision",
    destination: "undecided",
    reason:
      "Vault naming, and the one module where mobile is LARGER: it centralises vaultDisplayLabel(label, ordinal) while desktop inlines the same fallback at four call sites through three distinct catalog keys. Extraction direction here is mobile to shared. myne-md/myne#476.",
  },
  {
    a: "src/lib/vault-list.ts",
    b: "mobile/src/lib/vault-list.ts",
    verdict: "decision",
    destination: "undecided",
    reason:
      "Which vault is active. Mobile still exports resolveActiveVaultId(), deleted from desktop in myne-md/myne#250 for naming the wrong vault after a quick-unlock or a recovery. Zero production callers today, which makes it a landmine rather than a live bug. myne-md/myne#476.",
  },
  {
    a: "src/lib/vault-recover.ts",
    b: "mobile/src/lib/vault-recover.ts",
    verdict: "decision",
    destination: "undecided",
    reason:
      "Cosmetic-only today: the single differing line is the seam import. Error enum in core/src/plugins/vault_recover/error.rs, measured.",
  },
  {
    a: "src/lib/vault-repair.ts",
    b: "mobile/src/lib/vault-repair.ts",
    verdict: "decision",
    destination: "undecided",
    reason:
      "Repair-flow wrapper. Note the asymmetry to record rather than resolve here: its Rust source is NOT in core/, it is a twin of its own across the two src-tauri trees, so this TS mirror sits on top of an unresolved Rust twin. myne-md/myne#479.",
  },
  {
    a: "src/lib/vault-slot-kind.ts",
    b: "mobile/src/lib/vault-slot-kind.ts",
    verdict: "decision",
    destination: "undecided",
    reason:
      "Cosmetic-only today: the single differing line is the seam import. What the runtime slot map reports is one answer.",
  },
  {
    a: "src/lib/vault-status.ts",
    b: "mobile/src/lib/vault-status.ts",
    verdict: "decision",
    destination: "undecided",
    reason:
      "Cosmetic-only today: the single differing line is the seam import.",
  },
  {
    a: "src/lib/vault-switch.ts",
    b: "mobile/src/lib/vault-switch.ts",
    verdict: "decision",
    destination: "undecided",
    reason:
      "Switching vaults evicts keys and flushes state. Which of those two happens, and in which order, is not a per-client choice. myne-md/myne#476.",
  },
  {
    a: "src/lib/vault-unlock.ts",
    b: "mobile/src/lib/vault-unlock.ts",
    verdict: "decision",
    destination: "undecided",
    reason:
      "The unlock wrapper. Error enum in core/src/plugins/vault_unlock/error.rs, measured. myne-md/myne#476.",
  },
  {
    a: "src/lib/workspace-persist.ts",
    b: "mobile/src/lib/workspace-persist.ts",
    verdict: "decision",
    destination: "undecided",
    reason:
      "The MYW1 container schema, its codec and the read-modify-write splice rule, all of which both clients must agree on or a desktop pane tree does not survive a mobile write. The WRITE CADENCE is the part protocol.md 9.7.4 licenses per client by name, and it lives at the call site rather than in this file, so discriminator 2 does not move the verdict here. myne-md/myne#477.",
  },
  {
    a: "src/notes/attachmentRef.ts",
    b: "mobile/src/lib/attachmentRef.ts",
    verdict: "decision",
    destination: "@myne/editor",
    reason:
      "Shim against hand copy. Desktop is one line into @myne/editor/host/notes/attachmentRef; mobile carries 69 lines of its own. The destination is not in doubt because desktop already points at it.",
  },
  {
    a: "src/notes/localDateTime.ts",
    b: "mobile/src/lib/localDateTime.ts",
    verdict: "decision",
    destination: "@myne/editor",
    reason:
      "Shim against hand copy, same shape. Desktop is one line into @myne/editor/host/notes/localDateTime; mobile carries 34.",
  },
  {
    a: "src/notes/prefsNonce.ts",
    b: "mobile/src/lib/prefsNonce.ts",
    verdict: "decision",
    destination: "undecided",
    reason:
      "Byte-identical at 60 lines and neither side a shim: real code with two homes. It is the mechanism check-prefs-nonce.mjs exists to protect, duplicated across the two trees that guard is meant to hold, which is the sharpest argument in the record for why the curated half of the denominator is not optional.",
  },
  {
    a: "src/notes/sidebarState.tsx",
    b: "mobile/src/app/flows/EditorFlow.tsx",
    verdict: "decision",
    destination: "undecided",
    reason:
      "Mobile re-implements the note-flag predicates rather than importing them from @myne/editor/host/notes/selectors. Line counts are meaningless for this pair (1345 against 3384): it is a behavioural counterpart, not a copy, so only the shared predicates are the twin.",
  },
  {
    a: "src/styles/tokens.css",
    b: "mobile/src/styles/tokens.css",
    verdict: "decision",
    destination: "undecided",
    reason:
      "The design token table. Twenty token names exist on desktop and on no mobile surface, and two shared names carry DIFFERENT values, so a name-only comparison would pass over the second class entirely. A token a theme can set is vault content. myne-md/myne#478.",
  },
  {
    a: "src/types/note-create-error.ts",
    b: "mobile/src/types/note-create-error.ts",
    verdict: "decision",
    destination: "undecided",
    reason:
      "Byte-identical. Mirrors core/src/plugins/notes/error.rs, measured, so discriminator 5 puts it in the shared column.",
  },
  {
    a: "src/types/note-delete-error.ts",
    b: "mobile/src/types/note-delete-error.ts",
    verdict: "decision",
    destination: "undecided",
    reason:
      "Byte-identical. Mirrors core/src/plugins/notes/error.rs.",
  },
  {
    a: "src/types/note-list-error.ts",
    b: "mobile/src/types/note-list-error.ts",
    verdict: "decision",
    destination: "undecided",
    reason:
      "Byte-identical. Mirrors core/src/plugins/notes/error.rs.",
  },
  {
    a: "src/types/note-read-error.ts",
    b: "mobile/src/types/note-read-error.ts",
    verdict: "decision",
    destination: "undecided",
    reason:
      "Byte-identical. Mirrors core/src/plugins/notes/error.rs.",
  },
  {
    a: "src/types/note-update-error.ts",
    b: "mobile/src/types/note-update-error.ts",
    verdict: "decision",
    destination: "undecided",
    reason:
      "Mirrors core/src/plugins/notes/error.rs. Already partly shared by accident: mobile/src/lib/tasks.ts imports @myne/task-write, aliased into src/notes/taskWriteCore.ts, which imports THIS desktop module. So the desktop variant list and mobile's drifted copy are already in one bundle together.",
  },
  {
    a: "src/types/protocol-error.ts",
    b: "mobile/src/types/protocol-error.ts",
    verdict: "decision",
    destination: "undecided",
    reason:
      "Mirrors protocol/src/error.rs, measured.",
  },
  {
    a: "src/types/quick-unlock-error.ts",
    b: "mobile/src/types/quick-unlock-error.ts",
    verdict: "decision",
    destination: "undecided",
    reason:
      "Mirrors core/src/plugins/quick_unlock/error.rs, measured. Mobile is missing QuickUnlockError::VaultBusyAuth, which its own backend can return.",
  },
  {
    a: "src/types/slot-kind.ts",
    b: "mobile/src/types/slot-kind.ts",
    verdict: "decision",
    destination: "undecided",
    reason:
      "Byte-identical. The runtime slot map's shape, reported by a shared core.",
  },
  {
    a: "src/types/vault-change-password-error.ts",
    b: "mobile/src/types/vault-change-password-error.ts",
    verdict: "decision",
    destination: "undecided",
    reason:
      "Mirrors core/src/plugins/vault_change_password/error.rs, measured.",
  },
  {
    a: "src/types/vault-delete-error.ts",
    b: "mobile/src/types/vault-delete-error.ts",
    verdict: "decision",
    destination: "undecided",
    reason:
      "Byte-identical. Mirrors core/src/plugins/vault_delete/error.rs, measured.",
  },
  {
    a: "src/types/vault-recovery-error.ts",
    b: "mobile/src/types/vault-recovery-error.ts",
    verdict: "decision",
    destination: "undecided",
    reason:
      "Byte-identical. Mirrors core/src/plugins/vault_recover/error.rs, measured.",
  },
  {
    a: "src/types/vault-repair-error.ts",
    b: "mobile/src/types/vault-repair-error.ts",
    verdict: "decision",
    destination: "undecided",
    reason:
      "The one src/types twin whose Rust source is NOT in core/: it mirrors src-tauri/src/plugins/vault_repair/error.rs, which is itself an unresolved twin of mobile's copy. So discriminator 5 cannot answer this one, and it is a decision on the merits instead: the variant sets are identical and only doc comments diverge, which means both clients already agree and nothing holds them there. myne-md/myne#479.",
  },
  {
    a: "src/types/vault-status.ts",
    b: "mobile/src/types/vault-status.ts",
    verdict: "decision",
    destination: "undecided",
    reason:
      "Byte-identical. What vault_status reports is one answer from a shared core.",
  },
  {
    a: "src/types/vault-summary.ts",
    b: "mobile/src/types/vault-summary.ts",
    verdict: "decision",
    destination: "undecided",
    reason:
      "Cosmetic-only, and mobile's copy is the better one: its icon paragraph carries the SYNC-1 and SYNC-3 reasoning desktop's lacks. A reminder that 'desktop wins' is not a rule this record follows.",
  },
  {
    a: "src/types/vault-unlock-error.ts",
    b: "mobile/src/types/vault-unlock-error.ts",
    verdict: "decision",
    destination: "undecided",
    reason:
      "Mirrors core/src/plugins/vault_unlock/error.rs, measured. Mobile is missing VaultUpgradedUnsupported, the protocol.md 10.5 anti-downgrade refusal that desktop handles at src/screens/Unlock.tsx:295.",
  },


  // ── the Rust twins under src-tauri/src.
  //
  // The delegation claim is MEASURED rather than trusted: 18 of these carry
  // `pub use myne_core::plugins::<flow>` on BOTH sides, and `workspace/mod.rs`
  // carries it on desktop only, which is what makes that one a fork rather than
  // a shim. An auto-grill brief asserted 21 delegating; the difference is that
  // it counted `hooks.rs` and `main.rs`, which hold real per-client code and no
  // `pub use`. The measurement wins.
  //
  // # Where the four-verdict vocabulary strains, and why it was kept anyway
  //
  // `local_inference/commands.rs` is the honest counterexample to the decision
  // that per-file verdicts dissolve the need for a fifth `narrowed` verdict.
  // Mobile registers exactly two of its commands, so most of the file is a
  // surface mobile does not ship, and the two it does ship are duplicated logic
  // over the MYE1 attachments-text seal. Neither `absent` nor `decision` is the
  // whole answer; `absent` is the dominant one and its entry says so.
  //
  // The strain is not academic: the entry's own reason records a live v0.1/v0.2
  // meta-parser divergence on the duplicated half, which the `absent` reading
  // would otherwise have kept off the queue entirely.
  //
  // That is one file out of ninety-six. A fifth verdict for one strained case
  // would cost every reader a vocabulary entry and every sibling an extra
  // invariant, so the strain is recorded instead of designed around. If a second
  // case appears, this comment is the argument for reopening it.
  {
    a: "src-tauri/src/lib.rs",
    b: "mobile/src-tauri/src/lib.rs",
    verdict: "delegated",
    destination: "myne-core",
    reason:
      "The Tauri app builder: which plugins are registered, which capabilities they get, which hooks are installed. Carries `pub use myne_core::` on both sides. Composition is per-client by definition, and the composed parts are shared.",
  },
  {
    a: "src-tauri/src/main.rs",
    b: "mobile/src-tauri/src/main.rs",
    verdict: "screen",
    destination: "undecided",
    reason:
      "The binary entry point, 15 lines against 6. Each client's `main` starts a different host.",
  },
  {
    a: "src-tauri/src/hooks.rs",
    b: "mobile/src-tauri/src/hooks.rs",
    verdict: "delegated",
    destination: "myne-core",
    reason:
      "The per-client implementation of `myne_core::hooks::VaultLifecycleHooks`. One per client IS the seam, not drift: this is where a client that has no equivalent of a desktop side-effect says so, by leaving the method a no-op. Note for myne-md/myne#479: `check-twin-drift.mjs`'s header still records `emit_snapshot_write_failed` as a bare empty body on mobile, and that has been fixed. The guard header is what is stale.",
  },
  {
    a: "src-tauri/src/plugins/mod.rs",
    b: "mobile/src-tauri/src/plugins/mod.rs",
    verdict: "delegated",
    destination: "myne-core",
    reason:
      "The plugin ROSTER, not a plugin: a list of `pub mod` declarations with no builder and no capability grant, so `SHIM_REASON` describes nothing in it. It is `delegated` because each module it names is itself a shim over `myne-core`, and the divergence is which of them each client compiles. Mobile omits the desktop-only four (clipper pairing, importer, pdf-export, spell) and adds `captures`; both headers say so.",
  },
  {
    a: "src-tauri/src/plugins/attachments/mod.rs",
    b: "mobile/src-tauri/src/plugins/attachments/mod.rs",
    verdict: "delegated",
    destination: "myne-core",
    reason:
      SHIM_REASON,
  },
  {
    a: "src-tauri/src/plugins/export/mod.rs",
    b: "mobile/src-tauri/src/plugins/export/mod.rs",
    verdict: "delegated",
    destination: "myne-core",
    reason:
      SHIM_REASON,
  },
  {
    a: "src-tauri/src/plugins/graph_layout/mod.rs",
    b: "mobile/src-tauri/src/plugins/graph_layout/mod.rs",
    verdict: "delegated",
    destination: "myne-core",
    reason:
      SHIM_REASON,
  },
  {
    a: "src-tauri/src/plugins/notes/mod.rs",
    b: "mobile/src-tauri/src/plugins/notes/mod.rs",
    verdict: "delegated",
    destination: "myne-core",
    reason:
      SHIM_REASON,
  },
  {
    a: "src-tauri/src/plugins/prefs/mod.rs",
    b: "mobile/src-tauri/src/plugins/prefs/mod.rs",
    verdict: "delegated",
    destination: "myne-core",
    reason:
      SHIM_REASON,
  },
  {
    a: "src-tauri/src/plugins/quick_unlock/mod.rs",
    b: "mobile/src-tauri/src/plugins/quick_unlock/mod.rs",
    verdict: "delegated",
    destination: "myne-core",
    reason:
      SHIM_REASON,
  },
  {
    a: "src-tauri/src/plugins/secret_export/mod.rs",
    b: "mobile/src-tauri/src/plugins/secret_export/mod.rs",
    verdict: "delegated",
    destination: "myne-core",
    reason:
      SHIM_REASON,
  },
  {
    a: "src-tauri/src/plugins/snapshots/mod.rs",
    b: "mobile/src-tauri/src/plugins/snapshots/mod.rs",
    verdict: "delegated",
    destination: "myne-core",
    reason:
      SHIM_REASON,
  },
  {
    a: "src-tauri/src/plugins/sync/mod.rs",
    b: "mobile/src-tauri/src/plugins/sync/mod.rs",
    verdict: "delegated",
    destination: "myne-core",
    reason:
      SHIM_REASON,
  },
  {
    a: "src-tauri/src/plugins/themes/mod.rs",
    b: "mobile/src-tauri/src/plugins/themes/mod.rs",
    verdict: "delegated",
    destination: "myne-core",
    reason:
      "Host-registration shim. Both sides carry `pub use myne_core::plugins::<flow>` and keep only the Tauri plugin builder plus its capability grant, so the divergence is the wiring and it is correct by construction. Measured, not inferred: the `pub use` is on both sides. Mobile registers one of desktop's five theme commands, under a grant carrying that single permission, so the narrower surface is enforced by the ACL and not only by the handler list.",
  },
  {
    a: "src-tauri/src/plugins/vault_change_password/mod.rs",
    b: "mobile/src-tauri/src/plugins/vault_change_password/mod.rs",
    verdict: "delegated",
    destination: "myne-core",
    reason:
      SHIM_REASON,
  },
  {
    a: "src-tauri/src/plugins/vault_delete/mod.rs",
    b: "mobile/src-tauri/src/plugins/vault_delete/mod.rs",
    verdict: "delegated",
    destination: "myne-core",
    reason:
      "Host-registration shim. Both sides carry `pub use myne_core::plugins::<flow>` and keep only the Tauri plugin builder plus its capability grant, so the divergence is the wiring and it is correct by construction. Measured, not inferred: the `pub use` is on both sides. This is the canonical example of the pattern working: 52 lines against 53, both delegating, and the recursive unlink goes through the shared `myne_core::vault_sweep`.",
  },
  {
    a: "src-tauri/src/plugins/vault_indices/mod.rs",
    b: "mobile/src-tauri/src/plugins/vault_indices/mod.rs",
    verdict: "delegated",
    destination: "myne-core",
    reason:
      SHIM_REASON,
  },
  {
    a: "src-tauri/src/plugins/vault_label/mod.rs",
    b: "mobile/src-tauri/src/plugins/vault_label/mod.rs",
    verdict: "delegated",
    destination: "myne-core",
    reason:
      "Host-registration shim, and the one that does NOT match `SHIM_REASON`'s stated evidence: the shared answer is re-exported as `pub use myne_core::vault_label::{...}`, a crate-root module rather than one under `myne_core::plugins::`. Same verdict, different citation. The MYL1 sealed label store is myne-md/myne#411; per its own header the desktop ACL deliberately withholds a permission for a screen desktop does not render, so the two grants are known to differ here BY DESIGN, which is exactly why the blanket ACL claim was removed from `SHIM_REASON`.",
  },
  {
    a: "src-tauri/src/plugins/vault_recover/mod.rs",
    b: "mobile/src-tauri/src/plugins/vault_recover/mod.rs",
    verdict: "delegated",
    destination: "myne-core",
    reason:
      SHIM_REASON,
  },
  {
    a: "src-tauri/src/plugins/vault_unlock/mod.rs",
    b: "mobile/src-tauri/src/plugins/vault_unlock/mod.rs",
    verdict: "delegated",
    destination: "myne-core",
    reason:
      SHIM_REASON,
  },
  {
    a: "src-tauri/src/plugins/attachments/scheme.rs",
    b: "mobile/src-tauri/src/plugins/attachments/scheme.rs",
    verdict: "decision",
    destination: "undecided",
    reason:
      "The `attachment://` URI-scheme handler. No `pub use` on either side, so both hold real logic, and what a scheme request is allowed to read out of a vault is one answer rather than two. 202 lines against 84.",
  },
  {
    a: "src-tauri/src/plugins/workspace/mod.rs",
    b: "mobile/src-tauri/src/plugins/workspace/mod.rs",
    verdict: "decision",
    destination: "myne-core",
    reason:
      "A fork whose own comment names its exit condition, and that condition is now met. Desktop delegates (`pub use myne_core::plugins::workspace`); mobile still ships local `commands.rs` and `error.rs` justified by 'hoisting would mean migrating desktop in the same change'. Desktop was migrated. Mobile's copy is also behind: core reads through `singleton::open_newest_and_sweep`, the myne-md/myne#301 torn-write recovery, and parses via `parse_vault_meta_any`, while mobile uses a plain read and the v0.1-only parser. myne-md/myne#479.",
  },
  {
    a: "src-tauri/src/plugins/vault_repair/commands.rs",
    b: "mobile/src-tauri/src/plugins/vault_repair/commands.rs",
    verdict: "decision",
    destination: "undecided",
    reason:
      "Near-verbatim copy in the PRODUCTION half, and measured in BOTH directions after a first pass measured only one. Comment-stripped, mobile has no line desktop lacks, and every line it rewrites is the same `crate::vault_sweep` against `myne_core::vault_sweep` substitution. Desktop has 17 lines mobile lacks, and they are one thing: the `#[cfg(unix)]` regression test `vault_repair_partial_fail_returns_partial_delete_and_keeps_dir` (commands.rs:615), which mobile has no counterpart for. So the production logic really is a duplicate and the TEST coverage is not, and the second half is invisible to a one-directional read. Extraction is blocked on a seam rather than a disagreement: `tokio::task::spawn_blocking` is banned in `myne-core` by `check-core-task-seam.mjs`, and two `std::fs` calls need `VaultIo`. myne-md/myne#479.",
  },
  {
    a: "src-tauri/src/plugins/vault_repair/error.rs",
    b: "mobile/src-tauri/src/plugins/vault_repair/error.rs",
    verdict: "decision",
    destination: "undecided",
    reason:
      "Cosmetic-only: same five variants, same order, same serde tags, and only doc prose differs. This is the Rust source that `src/types/vault-repair-error.ts` mirrors, which is why discriminator 5 could not answer that TS twin.",
  },
  {
    a: "src-tauri/src/plugins/vault_repair/mod.rs",
    b: "mobile/src-tauri/src/plugins/vault_repair/mod.rs",
    verdict: "decision",
    destination: "undecided",
    reason:
      "Cosmetic-only; this pair is 55 lines. Note the rulebook contradiction to fix in myne-md/myne#479 rather than here: `core/CLAUDE.md:17` and `src-tauri/CLAUDE.md:15,67` both list `vault_repair` as having no mobile counterpart, while mobile ships the plugin, including a 564-line `commands.rs`, and grants `vault-repair:default`. Classify against the tree, never against the rulebook.",
  },
  {
    a: "src-tauri/src/plugins/local_inference/whisper.rs",
    b: "mobile/src-tauri/src/plugins/local_inference/whisper.rs",
    verdict: "decision",
    destination: "undecided",
    reason:
      "BYTE-IDENTICAL at 525 lines, and the highest-value duplicate in the repository. It carries the mel filterbank reproduced from `librosa.filters.mel`, the 99-language table, greedy decode, and the normative never-translates invariant. Bit-exactness between the two copies is what keeps a desktop transcript comparable to a phone one, and nothing enforces it. myne-md/myne#479.",
  },
  {
    a: "src-tauri/src/plugins/local_inference/audio.rs",
    b: "mobile/src-tauri/src/plugins/local_inference/audio.rs",
    verdict: "decision",
    destination: "undecided",
    reason:
      "The WAV reader and resampler, and the file myne-md/myne#485 lives in: desktop clamps `sample_rate` to 4_000..=384_000 and caps `resample_linear` with MAX_PCM_SAMPLES, mobile has neither. Imports only `serde::Serialize`, so extracting it to `myne-core` adds no crate to any dependency closure.",
  },
  {
    a: "src-tauri/src/plugins/local_inference/model_store.rs",
    b: "mobile/src-tauri/src/plugins/local_inference/model_store.rs",
    verdict: "decision",
    destination: "undecided",
    reason:
      "Model resolution and integrity checking, 820 lines against 766. Needs only `sha2`, `serde` and `thiserror`, all already declared in `core/Cargo.toml`, so it extracts with no dependency movement.",
  },
  {
    a: "src-tauri/src/plugins/local_inference/engine.rs",
    b: "mobile/src-tauri/src/plugins/local_inference/engine.rs",
    verdict: "decision",
    destination: "undecided",
    reason:
      "The engine trait and its shared implementation. Mobile narrows it rather than omitting it: `transcribe` is real, `infer` and `embed` return `NotReady`, measured. The contract is one answer even where a client declines part of it.",
  },
  {
    a: "src-tauri/src/plugins/local_inference/engine_candle.rs",
    b: "mobile/src-tauri/src/plugins/local_inference/engine_candle.rs",
    verdict: "decision",
    destination: "undecided",
    reason:
      "The Candle engine. Mobile loads a quantized GGUF and calls `whisper::transcribe_pcm` for real, so this is a narrowed implementation of a shared contract rather than an absence. #456's 'no local inference on mobile' is true of chat, embedding and RAG and false of speech to text.",
  },
  {
    a: "src-tauri/src/plugins/local_inference/cancel.rs",
    b: "mobile/src-tauri/src/plugins/local_inference/cancel.rs",
    verdict: "decision",
    destination: "undecided",
    reason:
      "Cancellation plumbing for a long-running inference. Both clients run cancellable transcription, so how a cancel is observed is one answer.",
  },
  {
    a: "src-tauri/src/plugins/local_inference/error.rs",
    b: "mobile/src-tauri/src/plugins/local_inference/error.rs",
    verdict: "decision",
    destination: "undecided",
    reason:
      "The engine error enum. Mobile's is a subset of desktop's, which is the same drift class as the `src/types/*-error.ts` mirrors one layer up.",
  },
  {
    a: "src-tauri/src/plugins/local_inference/commands.rs",
    b: "mobile/src-tauri/src/plugins/local_inference/commands.rs",
    verdict: "absent",
    destination: "undecided",
    reason:
      "STRAINED VERDICT, recorded as such, and it carries a LIVE DEFECT. Mobile registers exactly two commands (`transcribe`, `read_transcript`, measured) against desktop's full set, so most of this file is a surface mobile does not ship, and `absent` is the dominant reading. The two it does ship are duplicated logic, and the duplication is not faithful at the crypto boundary: desktop reads the vault meta with `protocol::parse_vault_meta_any` (commands.rs:645), mobile with the v0.1-only `protocol::parse_vault_meta` (commands.rs:133), while every vault created today is v0.2 (`core/src/plugins/vault_creation/commands.rs` writes `VAULT_META_V0_2_MAGIC`). Both sides swallow the result with `.ok()?`, so on mobile the MYE1 attachments-text cache is silently never written and never read. Same shape as `workspace/mod.rs` below, which records it correctly. `check-version-routing.mjs` cannot see it: its ROOTS are `core/src` and `src-tauri/src`, so mobile's call site is outside every recorded budget. Fixing it belongs to the version-routing work, not here; recording it is this row's job.",
  },
  {
    a: "src-tauri/src/plugins/local_inference/mod.rs",
    b: "mobile/src-tauri/src/plugins/local_inference/mod.rs",
    verdict: "absent",
    destination: "undecided",
    reason:
      "Plugin registration for a surface mobile ships a two-command slice of. 1096 lines against 112, and mobile's is independently written rather than a trimmed copy.",
  },
  {
    a: "src-tauri/src/plugins/local_inference/state.rs",
    b: "mobile/src-tauri/src/plugins/local_inference/state.rs",
    verdict: "absent",
    destination: "undecided",
    reason:
      "The inference state machine, 1416 lines against 40. It exists for chat and embedding sessions, which mobile does not ship at all, so mobile's 40 lines are wiring for the transcription path rather than a reduced version of the same thing.",
  },
];

const VERDICTS = ["decision", "screen", "absent", "delegated"];

/** Every file under `dir`, as paths relative to `root`. */
function* walk(dir, root) {
  let entries;
  try {
    entries = readdirSync(dir);
  } catch {
    return;
  }
  for (const name of entries) {
    if (SKIP_DIRS.has(name)) continue;
    const full = join(dir, name);
    let st;
    try {
      st = statSync(full);
    } catch {
      continue;
    }
    if (st.isDirectory()) yield* walk(full, root);
    else yield relative(root, full);
  }
}

/**
 * Same-relative-path twins across the given tree-root pairs.
 *
 * Returns `{ a, b }` with repo-relative paths, sorted, so the output order is
 * stable across machines and a diff of two runs is readable.
 */
function discover(pairs = TREE_PAIRS, curated = CURATED_TWINS) {
  const twins = [];
  for (const [deskRoot, mobRoot] of pairs) {
    if (!existsSync(at(deskRoot))) continue;
    if (!existsSync(at(mobRoot))) {
      // Thrown rather than `process.exit`, because `discover` is exported and
      // the suite calls it directly: an exit here kills the Vitest worker and
      // reports as an infrastructure crash instead of a named failure. `main`
      // catches it and exits.
      throw new Error(
        `twin-inventory: ${mobRoot} is missing. Both sides are in-repo since decisions.md 0488, so this is a broken checkout rather than an un-cloned companion.`,
      );
    }
    for (const rel of walk(at(deskRoot), at(deskRoot))) {
      const b = join(mobRoot, rel);
      if (existsSync(at(b))) twins.push({ a: join(deskRoot, rel), b });
    }
  }
  // Curated pairs join the same set, deduped on the PAIR rather than on the
  // desktop path.
  //
  // Keying on the desktop path alone is wrong, and the two cases that prove it
  // are both in `CURATED_TWINS`. `src/App.tsx` has a same-path twin in
  // `mobile/src/App.tsx`, the 121-line viewport wrapper, AND a behavioural
  // counterpart in `mobile/src/app/AppShell.tsx`; both are real twins and they
  // are not the same twin. `src/dialect/welcomeNote.ts` is the same shape: its
  // same-path twin is mobile's one-line shim, its curated pair is mobile's
  // separate 62-line hand copy at another path. A desktop file may have two
  // mobile counterparts, so the unit is the pair.
  const seen = new Set(twins.map(pairKey));
  for (const c of curated) {
    const key = pairKey(c);
    if (seen.has(key)) continue;
    twins.push({ a: c.a, b: c.b });
    seen.add(key);
  }
  return twins.sort((x, y) => (pairKey(x) < pairKey(y) ? -1 : 1));
}


const PROJECTION = join("docs", "dev", "twin-inventory.md");

/**
 * Regenerate the prose projection from the roster.
 *
 * Deterministic by construction: no timestamp, no count that depends on when it
 * ran, roster order preserved. Two consecutive runs produce byte-identical
 * output, which is what makes "hand-edited, then restored" a check rather than a
 * hope.
 *
 * **No per-row line count.** An earlier draft printed one, read live off both
 * files. That made `--check` fail on ANY one-line edit to any of the 192 files
 * in the roster, in `pre-commit` and in CI, under a message telling the author
 * the document had been hand-edited. It had not. The only tree-derived numbers
 * left are the two difference counts in the header, and those move when a pair
 * starts or stops differing, which is precisely when the record should be
 * regenerated. The roster's reasons still cite sizes where the size is the
 * argument; those are measurements taken once and recorded, not a live read.
 */
function projectionBody(roster, counts) {
  const byVerdict = (v) => roster.filter((e) => e.verdict === v);
  const table = (entries) =>
    entries.length === 0
      ? "_None._\n"
      : "| Desktop | Mobile | Destination | Reason |\n|---|---|---|---|\n" +
        entries
          .map(
            (e) =>
              `| \`${e.a}\` | \`${e.b}\` | ${
                e.destination === "undecided"
                  ? "_undecided_"
                  : `\`${e.destination}\``
              } | ${e.reason.replace(/\|/g, "\\|")} |`,
          )
          .join("\n") +
        "\n";

  const { cosmeticOnly: cosmetic, semanticDiff: semantic, byteDiff: byte } = counts;

  const body = `<!-- GENERATED by scripts/check-twin-inventory.mjs --emit. Do not edit by hand:
     the roster in that script is the source of truth, and it is also the gate. -->

# Twin inventory: every desktop/mobile module that answers the same question twice

Desktop (\`src/\`, \`src-tauri/src/\`) and mobile (\`mobile/…\`) compile from trees meant to share
their decisions. This is the record of where they do, where they do not, and which of those is a
bug. It is generated from \`scripts/check-twin-inventory.mjs\`, which is also the gate, so the two
cannot disagree.

**${roster.length} twins:** ${byVerdict("decision").length} decision, ${byVerdict("screen").length} screen, ${byVerdict("absent").length} absent, ${byVerdict("delegated").length} delegated. ${semantic} differ semantically, and ${cosmetic} differ only in comments or the platform-seam import.

## How a twin is found

Same relative path across two tree-root pairs, \`(src, mobile/src)\` and
\`(src-tauri/src, mobile/src-tauri/src)\`, **plus a curated list** for pairs whose two sides sit at
different paths. The curated half is not optional: this epic's own motivating case,
\`src/notes/sidebarState.tsx\` against \`mobile/src/app/flows/EditorFlow.tsx\`, is invisible to a path
sweep.

**A pair enters the curated list when the two files answer the same product question and the path
sweep cannot find them**, and every entry carries a named reason. Basename-only discovery is
deliberately excluded: it adds roughly 44 candidates and most are false, because \`index.ts\` matches
\`index.ts\`.

A desktop file may have TWO mobile counterparts and both may be real, so the unit is the pair rather
than the path. \`src/App.tsx\` has a same-path twin in the viewport wrapper and a behavioural
counterpart in \`AppShell.tsx\`.

## The four verdicts

- **decision**: both clients answer the same question, so a divergence is a bug by definition.
  Belongs in a shared package, and carries a destination.
- **screen**: the file exists TO BE per-client, in one of two ways: the surface a client renders
  (layout, navigation shape), or the host it renders into (entry points, build-time ambient
  globals). Deliberately narrow: what it excludes is a file that merely HAPPENS to differ per
  client, which is every \`decision\` in this record.
- **absent**: one client does not ship the surface. Names the decision or issue that made it so,
  because a gap and a decision look identical in a diff stat.
- **delegated**: the shared answer already lives in \`myne-core\` or a \`@myne/*\` package, and this
  file is per-client wiring over it. Its divergence is correct and permanent.

## How to tell them apart

Five discriminators, each earned from a real case rather than invented:

1. A \`t()\` key means screen.
2. A spec section that names clients separately means screen, however shared the code looks.
   \`protocol.md\` §9.7.4 licenses three different \`vault.workspace\` write cadences by name.
3. Payload versus predicate is the real seam, not module versus module.
4. A navigation SHAPE is a screen; the exit DOOR is a decision.
5. For a Rust-mirroring TS module the rubric is inherited: shared iff the Rust source is in
   \`core/\` or \`protocol/\` (\`core/CLAUDE.md\`, "What does NOT live here").

**Classify against the tree, never against a module's own header comment.** Several of those comments
cite \`src-tauri/src/plugins/.../error.rs\` paths that no longer exist.

## Two difference fields, and only one may gate

Every pair carries a mechanical **byte** flag and a **semantic** one. ${cosmetic} of the ${byte} drifted
pairs are byte-different and behave identically: four \`src/lib/vault-*.ts\` pairs differ in exactly
one line, the platform-seam import, and eight Rust files differ only in doc prose. Gating on bytes
would make those permanent red entries nobody can close.

**Two files are semantically identical iff they compare equal after stripping comments and
canonicalizing the seam import specifier.** The seam map is derived from \`src/platform/\` at runtime
rather than hardcoded, so it cannot drift from the seam it describes.

## decision (${byVerdict("decision").length})

Both clients answer the same question. A divergence here is a bug.

${table(byVerdict("decision"))}
## delegated (${byVerdict("delegated").length})

The shared answer already lives elsewhere; these files are per-client wiring over it.

${table(byVerdict("delegated"))}
## screen (${byVerdict("screen").length})

Legitimately per-client. The divergence is the feature.

${table(byVerdict("screen"))}
## absent (${byVerdict("absent").length})

One client does not ship the surface.

${table(byVerdict("absent"))}`;
  return body;
}

function emitProjection(roster, counts, target = PROJECTION) {
  writeFileSync(at(target), projectionBody(roster, counts));
  console.log(
    `twin-inventory: projection written, ${roster.length} row(s) into ${target}`,
  );
}

/**
 * Fail when the checked-in projection is not what `--emit` would write.
 *
 * The document says "Do not edit by hand" and the header calls it a projection,
 * and until this existed nothing enforced either: a hand edit to it is a
 * docs-only commit, which `pnpm-build`'s `code-paths` filter skips, so CI never
 * looked. `scripts/decisions-index.mjs --check` guards its generated index the
 * same way and for the same reason.
 */
function checkProjection(roster, counts, target = PROJECTION) {
  const want = projectionBody(roster, counts);
  const have = existsSync(at(target)) ? readFileSync(at(target), "utf8") : "";
  if (have === want) return;
  // The message names both causes because the check cannot tell them apart, and
  // `CLAUDE.md` forbids a failure message claiming more than its inputs prove.
  // An earlier draft said only "must not be hand-edited", which was an
  // accusation the comparison had no way to support.
  console.error(
    `twin-inventory: ${target} is not what --emit would write.\n` +
      "  Either the roster changed, or a twin started or stopped differing, or the\n" +
      "  document was hand-edited. It is a projection either way, so the fix is the\n" +
      "  same one: node scripts/check-twin-inventory.mjs --emit",
  );
  process.exit(1);
}

/**
 * `<seam module name>` for each `src/platform/*.ts` that is a bare re-export of
 * exactly one `@tauri-apps/*` specifier, in both directions.
 *
 * Read from the tree rather than hardcoded, so adding a seam module extends the
 * canonicalization with no second edit. A module re-exporting more than one
 * specifier is not a bare alias and is skipped: canonicalizing it would claim an
 * equivalence nobody established.
 */
function seamAliases(dir = join("src", "platform")) {
  const map = new Map();
  let entries;
  try {
    entries = readdirSync(at(dir));
  } catch {
    return map;
  }
  for (const name of entries) {
    if (!name.endsWith(".ts")) continue;
    const specs = new Set(
      [...readFileSync(at(join(dir, name)), "utf8").matchAll(
        /from\s+"(@tauri-apps\/[^"]+)"/g,
      )].map((m) => m[1]),
    );
    if (specs.size !== 1) continue;
    map.set(name.replace(/\.ts$/, ""), [...specs][0]);
  }
  return map;
}

/**
 * Comments removed, string literals left intact.
 *
 * A naive regex would eat `"https://example"`, so this walks the text. The one
 * subtlety is Rust: `'` opens a char literal (`'x'`, `'\n'`) but ALSO begins a
 * lifetime (`'a`, `'static`), which never closes. Treating a lifetime as a
 * string opener makes the walk desync and swallow everything up to the next
 * tick, comments included, so doc comments between two lifetimes survive the
 * strip and a comment-only difference reads as semantic drift.
 *
 * That is not hypothetical and it is not small: measured on
 * `local_inference/commands.rs`, the desyncing version preserved 163 lines of
 * `///` doc comment. A strings-first regex was measured too and under-strips
 * for the same reason in a different way, preserving 224. Both err toward
 * reporting drift that is not there, which is the safe direction, but the guard
 * is supposed to be measuring something.
 *
 * So in Rust a `'` opens a literal only when a closing `'` follows within
 * `CHAR_LITERAL_WINDOW` characters and on the same line. Every real char literal
 * closes well inside that; no lifetime does.
 *
 * **The window is Rust-only, and that is the whole point.** In TypeScript `'` is
 * an ordinary string quote with no length bound, so applying the lifetime rule
 * there re-opens the original bug pointing the other way: a `'`-quoted string
 * longer than the window stops being treated as a string, its contents get
 * walked as code, and a `//` inside it (every single-quoted URL) strips the rest
 * of the line. Two files whose only difference is inside such a string then
 * compare EQUAL, which is a false-equal in the field this guard reports.
 * `isRust` therefore comes from the file's own extension, and the fallback for
 * an unknown extension is the unbounded reading, because over-reporting drift is
 * the safe direction and under-reporting it is not.
 *
 * **Rust raw strings are the third case, and they are live rather than latent.**
 * `r"..."`, `r#"..."#`, `r##"..."##` and the `br` byte forms process no escapes
 * and end only at a quote followed by the same hash count. Walked as an ordinary
 * `"` string, a raw string containing an odd number of inner quotes pairs them
 * off by one, so part of its body is read as CODE and a `//` in that part
 * deletes the rest of the line. That is the under-reporting direction the
 * paragraph above calls unsafe, and four rostered files carry raw strings today:
 * both sides of `vault_repair/commands.rs` and both of `local_inference/mod.rs`.
 */
const CHAR_LITERAL_WINDOW = 12;

/**
 * Length of the raw-string opener at `i`, or 0 when there is none.
 *
 * Matches `r`/`br`, then any run of `#`, then a quote. The preceding character
 * must not be an identifier character: `r` is a legal variable name, and
 * `let r = 1;` must not be read as an opener just because a quote appears later
 * on the line.
 */
function rawStringOpener(text, i) {
  const prev = i > 0 ? text[i - 1] : "";
  if (/[A-Za-z0-9_]/.test(prev)) return 0;
  let j = i;
  if (text[j] === "b") j++;
  if (text[j] !== "r") return 0;
  j++;
  const hashStart = j;
  while (text[j] === "#") j++;
  if (text[j] !== '"') return 0;
  return { length: j - i + 1, hashes: j - hashStart };
}

function stripComments(text, isRust = false) {
  let out = "";
  let i = 0;
  const n = text.length;
  while (i < n) {
    const c = text[i];
    if (isRust && (c === "r" || c === "b")) {
      const open = rawStringOpener(text, i);
      if (open) {
        const close = '"' + "#".repeat(open.hashes);
        const end = text.indexOf(close, i + open.length);
        // An unterminated raw string is a syntax error the compiler would
        // reject; copying the remainder verbatim is the over-reporting
        // direction, which is the safe one.
        const stop = end === -1 ? n : end + close.length;
        out += text.slice(i, stop);
        i = stop;
        continue;
      }
    }
    if (c === '"' || c === "'" || c === "`") {
      if (c === "'" && isRust) {
        const close = text.indexOf("'", i + 1);
        const nl = text.indexOf("\n", i + 1);
        const isLifetime =
          close === -1 ||
          close - i > CHAR_LITERAL_WINDOW ||
          (nl !== -1 && nl < close);
        if (isLifetime) {
          out += c;
          i++;
          continue;
        }
      }
      const quote = c;
      out += c;
      i++;
      while (i < n) {
        if (text[i] === "\\") {
          out += text[i] + (text[i + 1] ?? "");
          i += 2;
          continue;
        }
        out += text[i];
        if (text[i] === quote) {
          i++;
          break;
        }
        i++;
      }
      continue;
    }
    if (c === "/" && text[i + 1] === "/") {
      while (i < n && text[i] !== "\n") i++;
      continue;
    }
    if (c === "/" && text[i + 1] === "*") {
      i += 2;
      while (i < n && !(text[i] === "*" && text[i + 1] === "/")) i++;
      i += 2;
      continue;
    }
    out += c;
    i++;
  }
  return out;
}

/**
 * The normalized form the semantic comparison runs on.
 *
 * Comments go, seam specifiers collapse to one token, blank lines go (stripping
 * a five-line header would otherwise leave five blanks on one side and none on
 * the other), and each line is trimmed. Nothing else is touched.
 *
 * `isRust` selects the `'` reading in `stripComments` and nothing else.
 */
function normalize(text, aliases, isRust = false) {
  let s = stripComments(text, isRust);
  for (const [name, spec] of aliases) {
    const token = `<seam:${name}>`;
    s = s.replaceAll(`"${spec}"`, `"${token}"`);
    // `\.\.?/` rather than `\.\./`, so the depth-0 form `"./platform/core"` is
    // canonicalized too. Requiring at least one `../` missed it, and two
    // rostered twins are written that way (`src/editor-host.ts`, `src/App.tsx`).
    // It erred toward over-reporting drift, which is the safe direction, but the
    // cosmetic-only count is myne#473's stated ratchet baseline, so a number
    // that is merely safe is still the wrong number.
    s = s.replace(
      new RegExp(`"(?:\\.\\.?/)+platform/${name}"`, "g"),
      `"${token}"`,
    );
  }
  return s
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0)
    .join("\n");
}

/** `{ byteEqual, semanticEqual }` for one pair, or null when a side is unreadable. */
function compare(a, b, aliases) {
  let x;
  let y;
  try {
    x = readFileSync(at(a), "utf8");
    y = readFileSync(at(b), "utf8");
  } catch {
    return null;
  }
  // `normalize` is a pure function of its input, so equal bytes imply equal
  // normal forms. Skipping the pass on the byte-identical pairs is one word and
  // the implication is unconditional.
  const byteEqual = x === y;
  // Per side rather than once for the pair. Every pair on today's roster shares
  // an extension, but a curated entry is free to pair two that do not, and
  // taking one side's language as the other's would apply the Rust `'` reading
  // to a `.ts` file, which is the exact false-equal the window exists to avoid.
  return {
    byteEqual,
    semanticEqual:
      byteEqual ||
      normalize(x, aliases, a.endsWith(".rs")) ===
        normalize(y, aliases, b.endsWith(".rs")),
  };
}

function main() {
  const rootsFlag = process.argv.indexOf("--roots");
  const injected = rootsFlag !== -1;
  const deskDir = injected ? process.argv[rootsFlag + 1] : null;

  // `--roots <desktopDir> <mobileDir>` points the walk at a throwaway tree
  // instead of the real ones. It exists so this guard's own test can inject the
  // defects it claims to catch without touching `src/` or `mobile/src`: an
  // earlier version of `check-token-adoption.mjs` mutated a production source
  // file, and a crashed run left it that way.
  const pairs = injected
    ? [[deskDir, process.argv[rootsFlag + 2]]]
    : TREE_PAIRS;
  const curated = injected ? readInjected(deskDir, "curated.json") : CURATED_TWINS;
  let twins;
  try {
    twins = discover(pairs, curated);
  } catch (err) {
    console.error(err.message);
    process.exit(1);
  }
  const roster = injected ? readInjected(deskDir, "roster.json") : ROSTER;

  let failed = false;

  // A curated pair is hand-asserted, so a missing side is a real event rather
  // than bookkeeping: somebody moved or deleted a file this list says answers a
  // shared product question, and nobody told the list. Reported separately from
  // the set comparison below because the two say different things to the reader.
  const curatedStale = curated.filter(
    (c) => !existsSync(at(c.a)) || !existsSync(at(c.b)),
  );
  if (curatedStale.length > 0) {
    console.error(
      `twin-inventory: ${curatedStale.length} curated pair(s) name a file that no longer exists:\n` +
        curatedStale
          .map((c) => `    ${c.a}\n      paired with ${c.b}`)
          .join("\n") +
        "\n  A curated pair is hand-asserted, so this is a moved or deleted file rather than a\n" +
        "  bookkeeping slip. Re-point the entry in CURATED_TWINS or remove it, and say which in\n" +
        "  its reason. Dropping it silently would shrink the denominator without an argument.",
    );
    failed = true;
  }

  // The roster set and the discovered set must be EQUAL, compared both ways.
  //
  // An earlier draft checked the second direction by asking whether both files
  // still existed, which is a proxy and a weak one: an entry whose pair stopped
  // being a twin (one side moved to a path the sweep no longer matches, or a
  // curated entry was deleted while its roster row stayed) passed cleanly while
  // every published count was wrong, including the projection's headline, which
  // reads `roster.length`. Set equality is the property the header claims, so it
  // is the property the code checks. `check-ornament-vocabulary.mjs` compares
  // its cells the same way and for the same reason.
  const discovered = new Map(twins.map((t) => [pairKey(t), t]));
  const rostered = new Map(roster.map((e) => [pairKey(e), e]));

  const missing = [...discovered.keys()].filter((k) => !rostered.has(k));
  if (missing.length > 0) {
    console.error(
      `twin-inventory: ${missing.length} twin(s) have no verdict:\n` +
        missing
          .map((k) => {
            const t = discovered.get(k);
            return `    ${t.a}\n      paired with ${t.b}`;
          })
          .join("\n") +
        "\n  Add one to ROSTER in scripts/check-twin-inventory.mjs. A twin with no verdict is a\n" +
        "  module nobody has decided is shared or per-client, which is how one classification\n" +
        "  becomes seven inconsistent ones.",
    );
    failed = true;
  }

  const orphaned = [...rostered.keys()].filter((k) => !discovered.has(k));
  if (orphaned.length > 0) {
    console.error(
      `twin-inventory: ${orphaned.length} entr(ies) describe a pair that is no longer a twin:\n` +
        orphaned
          .map((k) => {
            const e = rostered.get(k);
            const why = !existsSync(at(e.a))
              ? `${e.a} no longer exists`
              : !existsSync(at(e.b))
                ? `${e.b} no longer exists`
                : "both files exist but the pair is not discovered: a path moved, or a curated entry was removed";
            return `    ${e.a}\n      paired with ${e.b}\n      ${why}`;
          })
          .join("\n") +
        "\n  Remove the entry, re-point it, or restore the pair. An entry that outlives its pair\n" +
        "  is a verdict about nothing, and it inflates every count this guard publishes.",
    );
    failed = true;
  }

  // A duplicated pair is invisible to every check above: `rostered` is a Map and
  // the suite compares Sets, so both collapse it, while every published count
  // reads `roster.length` and is silently one too high. Latent today; it costs
  // one comparison to keep it that way.
  if (rostered.size !== roster.length) {
    const seenKeys = new Set();
    const dupes = roster
      .filter((e) => (seenKeys.has(pairKey(e)) ? true : (seenKeys.add(pairKey(e)), false)))
      .map((e) => `    ${e.a}\n      paired with ${e.b}`);
    console.error(
      `twin-inventory: ${roster.length - rostered.size} duplicate roster entr(ies):\n` +
        dupes.join("\n") +
        "\n  The unit is the pair, so one pair gets one verdict. A duplicate inflates every\n" +
        "  count this guard publishes without changing what it checks.",
    );
    failed = true;
  }

  // A verdict outside the vocabulary is a typo that would otherwise classify a
  // module into a category no sibling knows how to act on.
  const badVerdict = roster.filter((e) => !VERDICTS.includes(e.verdict));
  if (badVerdict.length > 0) {
    console.error(
      `twin-inventory: ${badVerdict.length} entr(ies) carry a verdict outside the vocabulary:\n` +
        badVerdict.map((e) => `    ${e.a}: "${e.verdict}"`).join("\n") +
        `\n  Valid verdicts: ${VERDICTS.join(", ")}.`,
    );
    failed = true;
  }

  // Both difference fields, computed live rather than recorded. A recorded flag
  // goes stale the moment either file is edited, and this one is cheap: two
  // reads per pair, cheap enough to run before the gate exits. myne-md/myne#473
  // records the resulting COUNTS as its ratchet baseline; the per-pair values
  // stay derived.
  const aliases = seamAliases(injected ? join(deskDir, "platform") : undefined);
  const diffs = twins
    .map((t) => ({ ...t, ...(compare(t.a, t.b, aliases) ?? {}) }))
    .filter((t) => t.byteEqual !== undefined);
  const counts = {
    byteDiff: diffs.filter((t) => !t.byteEqual).length,
    semanticDiff: diffs.filter((t) => !t.semanticEqual).length,
    cosmeticOnly: diffs.filter((t) => !t.byteEqual && t.semanticEqual).length,
  };

  // `--emit` runs BEFORE the gate exits, deliberately. It used to run after, so
  // whenever the guard was red for any unrelated reason (the ordinary mid-work
  // state) a regeneration wrote nothing and left whatever was in the file
  // standing. A projection of an inconsistent roster is still exactly what the
  // roster says, which is the honest output; the gate then fails on its own
  // terms one line later.
  //
  // Under `--roots` it writes into the throwaway tree instead of the repository
  // document. That is what lets the suite assert this ordering on a real emit
  // rather than on the absence of one, which would be an assertion that cannot
  // fail.
  if (process.argv.includes("--emit")) {
    emitProjection(roster, counts, injected ? join(deskDir, "projection.md") : PROJECTION);
  }

  if (failed) process.exit(1);

  // `--check` is the other way round: comparing against a roster already known
  // to be wrong would report staleness that is a symptom of the real failure.
  if (process.argv.includes("--check")) {
    checkProjection(roster, counts, injected ? join(deskDir, "projection.md") : PROJECTION);
  }

  const by = (k) => roster.filter((e) => e.verdict === k).length;
  console.log(
    `twin-inventory: ok (${twins.length} twin(s) discovered, ` +
      `${roster.length} classified: ${by("decision")} decision, ` +
      `${by("screen")} screen, ${by("absent")} absent, ${by("delegated")} delegated)\n` +
      `twin-inventory: ${counts.byteDiff} byte-different, ${counts.semanticDiff} semantically different, ` +
      `${counts.cosmeticOnly} differing only in comments or the seam import`,
  );
}

/**
 * Under `--roots`, the roster and the curated list come from JSON beside the
 * injected desktop directory, so a test can vary either without editing this
 * file.
 */
function readInjected(dir, name) {
  const path = at(join(dir, name));
  if (!existsSync(path)) return [];
  return JSON.parse(readFileSync(path, "utf8"));
}

if (import.meta.url === `file://${process.argv[1]}`) main();

export {
  ROSTER,
  TREE_PAIRS,
  CURATED_TWINS,
  VERDICTS,
  discover,
  pairKey,
  seamAliases,
  stripComments,
  normalize,
  compare,
};
