#!/usr/bin/env node
// Every desktop/mobile twin module has a verdict, and no verdict outlives its
// files (myne-md/myne#472, epic myne-md/myne#242).
//
// # The failure this prevents
//
// Desktop and mobile compile from trees meant to share their decisions and
// sharing almost none of them. The measurement that opened this epic was 90
// same-relative-path twins, 19 byte-identical, 71 drifted; it is 104 and 80 now
// (the platform seam, myne-md/myne#492, plus two more pairs), and the numbers
// live in the projection rather than here precisely because they move. `scripts/check-twin-drift.mjs` (#261) warns when a change touches
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
// The semantic comparison is the one myne-md/myne#473 may gate on, because a
// meaningful fraction of the drifted pairs are byte-different and behave
// identically: `src/types/vault-summary.ts` differs only in a JSDoc bullet, two
// `src/dialect/` shims differ only by a header comment (and which side carries
// it flips between them), and eight Rust files differ only in doc prose. Gating
// on bytes would make those permanent red entries that no sibling can close.
//
// **The counts are not written here.** They were, as "16 of the 76", and by the
// time this branch merged they were 15 of 80, in a comment eleven lines under
// one saying the numbers live in the projection because they move. Run the
// guard.
//
// Four pairs used to be the headline example: `vault-status.ts`,
// `vault-slot-kind.ts`, `vault-recover.ts` and `vault-change-password.ts` each
// differed in exactly one line, the seam import. All four are byte-identical
// now — myne-md/myne#492 gave `mobile/src` its own seam directory, so both sides
// import from `../platform/` — and the seam-canonicalization arm of the rule
// consequently moves NO pair on today's roster. Disabling it yields the same two
// counts. It is kept because it is the right rule and will have members again
// the moment a seam member diverges, but it is currently carrying an argument
// nothing in the tree exercises, which is worth knowing before citing it.
//
// **The rule: two files are semantically identical iff they compare equal after
// stripping comments, canonicalizing the seam import specifier, and eliding
// blank lines and leading indentation.**
//
// The third clause is not decoration and it used to be missing from every
// published statement of this rule. It does the most work of the three:
// comments and the seam alone give 78 semantic and 2 cosmetic when that measurement was taken, and the elision
// gave 65 / 15 when measured (67 / 15 today), so thirteen of the fifteen cosmetic-only verdicts come from
// that clause alone. A reader given the two-clause rule could not reproduce the
// number the projection publishes. `normalize` states what it costs.
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

// The fourteen Rust-error mirrors that myne-md/myne#475 hoisted into
// `@myne/client-core`. Hoisted like `SHIM_REASON` above and for the same reason:
// fourteen entries saying one thing is fourteen places for it to be said
// differently, and the difference between them is only which enum they mirror,
// which the parity test already knows by name.
const TYPE_SHIM_REASON =
  "Re-export shim into `@myne/client-core/types/…`, one line, byte-identical on both sides (myne-md/myne#475). The mirror itself is now a single file rather than two hand copies, so a variant added to the Rust enum can no longer reach one client and not the other. Its agreement with the Rust source is asserted by `tests/types/rustEnumParity.test.ts`, which parses the enum rather than trusting a comment, and fails BY NAME when the Rust file moves, which twelve of these files' header comments had silently done.";

const CURATED_TWINS = [
  {
    a: "src/components/settings/MemorySection.tsx",
    b: "mobile/src/app/flows/MemorySection.tsx",
    what: "the agent-memory management surface: list, edit, delete, clear-all-with-confirm, and the personality editor (myne-md/myne#697)",
    why:
      "The two files answer the same product question at different paths, so " +
      "the path sweep cannot pair them. The phone side is recut for touch " +
      "(stacked confirms with the safe answer last, inline two-tap delete) " +
      "while the desktop side uses the settings primitives; the commands, " +
      "testids and the ai_enabled gate are the shared answer both must keep.",
  },
  {
    a: "src/notes/components/MemoryPopover.tsx",
    b: "mobile/src/app/flows/MemorySheet.tsx",
    what: "the in-chat memory surface: the live roster beside the conversation, with delete (myne-md/myne#697)",
    why:
      "A popover has no phone posture, so the mobile twin is a bottom sheet " +
      "opened from the AI flow's memory button. Same roster, same delete " +
      "path, same report-don't-empty read; editing lives in Settings on both.",
  },
  {
    a: "src/notes/dailyNote.ts",
    b: "mobile/src/lib/daily.ts",
    what: "hand-mirrors the whole period resolver: isoWeek, formatDailyDate, zonedNow, PERIODS, PERIOD_DEFAULTS, periodRange, periodSettings, resolvePeriodNote",
    why:
      "Two different paths, so the path sweep cannot pair them and `check-twin-drift.mjs` " +
      "inherits the blindness through `NAMED_TWINS`. Six doc comments across the two files say " +
      "one mirrors the other `exactly`, and until myne-md/myne#177 nothing measured that. What a " +
      "one-sided edit costs is stated by the files themselves: a period note is matched by " +
      "folder plus title and nothing else, so a `PERIOD_DEFAULTS` or escape-grammar divergence " +
      "files one week under two titles and the same vault ends up with two notes for it. The " +
      "BEHAVIOURAL half is pinned separately and better, by `core/src/plugins/notes/" +
      "period-title-cases.json`, which both trees and the Rust implementation run against; this " +
      "entry is what makes a one-sided EDIT visible.",
  },
  {
    a: "src/notes/folderBackfill.ts",
    b: "mobile/src/lib/folderBackfill.ts",
    what: "registers an existing vault's folders once, on the first load after unlock",
    why:
      "The once-per-unlock back-fill (myne-md/myne#613), written twice because mobile carries a " +
      "note's folder in its BODY and has no `TitleRecord`, so the parsing half is genuinely " +
      "different code. Everything else is the same four properties in the same order, and each " +
      "file's header names the other as its twin, which is precisely the pair a path sweep cannot " +
      "see: they sit at different relative paths. The pr-review found the mobile test already " +
      "omitting the `deleted` and `conflict` cases the desktop one covers, which is the drift this " +
      "entry exists to make visible.",
  },
  {
    a: "src/notes/moveNote.ts",
    b: "mobile/src/lib/note-organize.ts",
    what: "moves a note between folders and registers the destination",
    why:
      "The move-and-register pair. Desktop split `moveNote` into a non-registering form plus one " +
      "`registerDestination` so a bulk gesture pays ONE prefs write; mobile kept the registration " +
      "inside its move and its folder rename therefore issued one full `vault.prefs` re-encrypt per " +
      "note in the subtree, outside the `withPrefsBatch` that exists to stop exactly that. " +
      "`check-twin-drift.mjs` cannot see it either, for the same different-paths reason, so nothing " +
      "reported the asymmetry until a human read both files (myne-md/myne#613 pr-review).",
  },
  {
    a: "src/App.tsx",
    b: "mobile/src/app/AppShell.tsx",
    what: "carries the twin boot probe, reprobe, Stage switch and dispatch",
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
    what: "re-implements its note-flag predicates (see @myne/editor/host/notes/selectors)",
    why:
      "Mobile re-implements the note-flag predicates rather than importing them from " +
      "`@myne/editor/host/notes/selectors`. This epic's own motivating case, and it is outside the " +
      "90 the path sweep finds, so a record fixed at 90 would omit the defect the epic exists to " +
      "fix. Line counts are meaningless for this pair: it is a behavioural " +
      "counterpart, not a copy, so only the semantic comparison of the shared predicates says " +
      "anything.",
  },
  {
    a: "src/hooks/useDateTimeDisplaySync.ts",
    b: "mobile/src/lib/useDateTimeDisplaySync.ts",
    what: "publishes the shared date/time display store, one adapter per client",
    why:
      "The two publishers into `editor/src/host/lib/datetimeFormat.ts`'s module-scope store. " +
      "Cross-path (`src/hooks` against `mobile/src/lib`), so the sweep cannot pair them, and this " +
      "is the exact module class myne-md/myne#609 was filed about: for as long as mobile had no " +
      "adapter at all, there was one publisher and three readers and nothing said so. Not a copy: " +
      "each reads its own client's prefs seam, and mobile additionally re-reads on the prefs nonce " +
      "because its host mounts the adapter above the stage machine. What must stay in step is the " +
      "PUBLISHED VALUE, `displayFromPrefs(prefs, language)`, and the language listener that " +
      "republishes it, since a language switch does not re-render either mounting component. " +
      "`check-datetime-display-publisher.mjs` holds the weaker property (each client tree has a " +
      "publisher at all); a one-sided edit to what gets published is what this pair is for.",
  },
  {
    a: "src/notes/prefsNonce.ts",
    b: "mobile/src/lib/prefsNonce.ts",
    what: "is the same prefs-nonce mechanism, duplicated rather than shared",
    why:
      "Byte-identical, and neither side is a shim: this is real code with two homes. " +
      "It is the mechanism `check-prefs-nonce.mjs` exists to protect, duplicated across the trees " +
      "the guard is meant to hold, which makes it the sharpest argument for why the curated half " +
      "of the denominator is not optional.",
  },
  {
    a: "src/notes/setNoteCover.ts",
    b: "mobile/src/lib/setNoteCover.ts",
    what: "writes the note-cover frontmatter field, and the byte sequence must match",
    why:
      "Read, patch `cover:`, bump `updated:`, write. Cross-path, so the sweep cannot see it, and " +
      "the pair's own justification is byte-identity: myne-md/myne#410's decision entry rests the " +
      "case for a second implementation on 'a cover set on a phone is byte-identical to one set on " +
      "a desktop'. What is shared is the primitives; the ORDER (patch cover, then stamp updated) is " +
      "retyped on each side, and that order is the byte-deciding part. Desktop additionally " +
      "re-indexes and takes a property key; mobile does neither.",
  },
  {
    a: "src/notes/localDateTime.ts",
    b: "mobile/src/lib/localDateTime.ts",
    what: "is a shim on one side and a hand copy on the other",
    why:
      "Shim against hand copy. Desktop is a one-line `export * from " +
      '"@myne/editor/host/notes/localDateTime"`; mobile carries 33 lines of its own. Desktop ' +
      "already delegates and mobile has not been pointed at the same source.",
  },
  {
    a: "src/notes/attachmentRef.ts",
    b: "mobile/src/lib/attachmentRef.ts",
    what: "is a shim on one side and a hand copy on the other",
    why:
      "Shim against hand copy, same shape as localDateTime. Desktop re-exports " +
      '`@myne/editor/host/notes/attachmentRef`; mobile carries 69 lines.',
  },
  {
    a: "src/dialect/welcomeNote.ts",
    b: "mobile/src/lib/welcomeNote.ts",
    what: "is the English-only hand copy of the shared welcome note",
    why:
      "Shim against hand copy, and the one case where mobile carries BOTH. " +
      "`mobile/src/dialect/welcomeNote.ts` is the one-line shim into `@myne/dialect` (already a " +
      "same-path twin, classified `delegated`), while `mobile/src/lib/welcomeNote.ts` is a " +
      "separate 62-line copy at a different path. The shared source is `dialect/src/welcomeNote.ts` " +
      "at 37 lines, so the copy is not even a stale duplicate of it. This is the English-only " +
      "welcomeNote named in `check-twin-drift.mjs`'s own header.",
  },
  {
    a: "core/src/inference/engine.rs",
    b: "mobile/src-tauri/src/plugins/local_inference/engine.rs",
    what: "is the shared engine trait against mobile's surviving copy of it",
    why:
      "Cross-path since myne-md/myne#456 moved the desktop side into `myne-core`, so the sweep " +
      "cannot see it and only a curated entry keeps it in the denominator. The pair is not a " +
      "desktop-against-mobile comparison any more: `a` is the shared answer both clients are " +
      "supposed to reach, and `b` is a copy mobile still declares `mod engine;` for. That is the " +
      "class this record exists to name, and losing the pair at the moment the shared side landed " +
      "would have read as the duplication being resolved.",
  },
  {
    a: "core/src/inference/error.rs",
    b: "mobile/src-tauri/src/plugins/local_inference/error.rs",
    what: "is the shared engine-error enum against mobile's subset of it",
    why:
      "Same move, same reason as `engine.rs` above. Worth its own entry rather than a mention " +
      "inside that one because this file has a second reader: `tests/lib/engineErrorTaxonomy.test.ts` " +
      "reads `a` by an exact path and fails by NAME when it moves, which is how the move was " +
      "caught. Nothing reads `b` that way.",
  },
  {
    a: "core/src/inference/state.rs",
    b: "mobile/src-tauri/src/plugins/local_inference/state.rs",
    what: "is the shared inference state machine against an unrelated file of the same name",
    why:
      "The pair worth keeping precisely because the two files are NOT versions of each other: " +
      "1466 lines of chat and embedding session state against 40 lines of transcription wiring " +
      "that happens to share a basename inside the same plugin directory. Recorded so a future " +
      "reader who greps `state.rs` in the inference area is told which one is which, rather than " +
      "assuming the small one is a trimmed copy of the large one.",
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
 * on every entry. The projection renders live counts instead.
 */
const ROSTER = [
  // The two myne-md/myne#613 folder-registration pairs. Both are cross-path, so
  // the sweep cannot find them and both sit in `CURATED_TWINS` above; both are
  // `decision`, because mobile's half is genuinely different code answering the
  // same product question rather than a copy of desktop's.
  {
    a: "src/notes/folderBackfill.ts",
    b: "mobile/src/lib/folderBackfill.ts",
    verdict: "decision",
    destination: "stays per-client",
    reason:
      "Same four properties in the same order, deliberately not shared: mobile carries a note's folder in its BODY and has no `TitleRecord`, so the input shape and therefore the parsing half differ, and sharing would mean a seam for one function. What must not drift is the liveness rule and the identity fold; each header names the other file so a reader lands on both.",
  },
  {
    a: "src/notes/moveNote.ts",
    b: "mobile/src/lib/note-organize.ts",
    verdict: "decision",
    destination: "stays per-client",
    reason:
      "Per-client by construction: a registration site is a client-side surface, and mobile's file also holds its note-flag readers. Both now carry the same split (a non-registering move plus one caller-side registration), which is the asymmetry the pr-review found: mobile's folder rename issued one prefs write per note in the subtree while desktop batched.",
  },
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
    a: "src/components/settings/MemorySection.tsx",
    b: "mobile/src/app/flows/MemorySection.tsx",
    verdict: "screen",
    destination: "undecided",
    reason:
      "Same surface, different client posture (myne-md/myne#697). Desktop uses the settings primitives; mobile owns its styles with stacked confirms and inline two-tap delete. Commands, testids and the ai_enabled gate are the shared answer; presentation is per-client by design.",
  },
  {
    a: "src/notes/components/MemoryPopover.tsx",
    b: "mobile/src/app/flows/MemorySheet.tsx",
    verdict: "screen",
    destination: "undecided",
    reason:
      "Same surface, different client posture (myne-md/myne#697): a popover has no phone form, so the mobile twin is a bottom sheet. Roster, delete path and the report-don't-empty read are shared; the container is per-client by design.",
  },
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
    a: "src/lib/chats.ts",
    b: "mobile/src/lib/chats.ts",
    verdict: "decision",
    destination: "undecided",
    reason:
      "IPC wrapper and DTO mirror over the shared chats core, the attachments-twin shape: six commands plus the two error-kind unions plus ConversationEntry. Both sides register the full subset the shared ACL grants, so unlike attachments there is no per-command absence question here: the wrapper shape is one answer. Its error taxonomy overlaps myne-md/myne#475.",
  },
  {
    a: "src/lib/memory.ts",
    b: "mobile/src/lib/memory.ts",
    verdict: "decision",
    destination: "undecided",
    reason:
      "IPC wrapper and DTO mirror over the shared memory core, the chats-twin shape: six commands plus the two error-kind unions plus MemoryEntryRow/MemoryListRow/PersonalityView. Both sides register the full subset the shared ACL grants, so unlike attachments there is no per-command absence question here: the wrapper shape is one answer (myne-md/myne#697).",
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
      "RESOLVED in myne-md/myne#474. SYNC-42 strings whose exact wording is a privacy property: both sides now re-export the shared family from `@myne/copy` rather than declaring it, so the literals are byte-identical BY CONSTRUCTION, which is what `pnpm-workspace.yaml` had claimed while mobile imported the package zero times. Mobile also gained the five beta-terms clauses it could not reach, because those are text a user AGREED to and an acceptance recorded against a paraphrase on one client is not an acceptance of what another asked. What still differs is each client's own surface copy, which is per-client by design.",
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
      "The Stage and Action unions plus the transition table. Set-differencing the two LEGAL tables yields exactly ONE substantive disagreement, `unlock.join-success` against `editor.join-success`, and that one is DELIBERATE: desktop routes the account-chip join through `unlock` because `leaveActiveVault` must tear the vault down first, while mobile re-addresses the payload in place. The other three differences follow from mobile shipping seven Stage variants to desktop's nine (`account-entry` and `pending-approval` are web-first surfaces), which is a screen difference rather than a routing one. So this is the most shareable large module in the tree rather than the least. myne-md/myne#477 removed the concrete divergence that WAS here, two orphaned docblocks arguing post-delete should route to `welcome`, attached to no union member, which is the pair `check-twin-drift.mjs`'s header records as unseen for seven months, and left the extraction itself for a dedicated pass, because moving a 1300-line state machine in the same change as six other slices is how a PR becomes unreviewable.",
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
      "Byte-identical since myne-md/myne#492 gave `mobile/src` its own seam directory, so both sides now import from `../platform/`. Before that the single differing line WAS the seam import, and this entry is one of the four that argument was built on. Its error enum is in core/src/plugins/vault_change_password/error.rs, measured, so discriminator 5 puts it squarely in the shared column.",
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
      "RESOLVED in myne-md/myne#476. What a destructive action targets. Mobile declared `deleteVault(vaultId?: string)`, the optional shape myne-md/myne#250 removed because THE FALLBACK WAS THE BUG, under a docstring promising a backend fallback the shared Rust core stopped accepting at the same time, so `deleteVault(undefined)` was a deserialization rejection wearing a reassuring comment. The parameter is required on both sides now, which moved the mistake to compile time and named the two call sites that were passing an optional prop straight through; both refuse an unresolved target instead. Also cut: a 110-line copy of desktop's `mapDeleteVaultError` with zero callers here, whose own docstring named three desktop components as its consumers.",
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
      "RESOLVED in myne-md/myne#476. Which vault is active. Mobile exported `resolveActiveVaultId()`, deleted from desktop in myne-md/myne#250 for naming the wrong vault after a quick-unlock or a recovery, zero production callers, so a landmine rather than a live bug, and the first caller reaching for the obvious-sounding name would have reproduced a data-loss defect on a device whose vault is often the only copy. It could not simply be ported over, because the authoritative answer is an IPC command mobile registered NOWHERE: `vault_active_id` has lived in `myne-core` since #250 and only desktop's `generate_handler!`, `build.rs` and ACL knew about it. Mobile now registers it across all three, and carries the same `activeVaultId()` and `soleVaultId()` with the same `null` contracts: `null` means no target, never `use whichever one looks most recent`.",
  },
  {
    a: "src/lib/account.ts",
    b: "mobile/src/lib/account.ts",
    verdict: "decision",
    destination: "undecided",
    reason:
      "Byte-identical by construction (myne-md/myne#684): the account-record command mirrors plus the `accountIdForVault` grouping helper. Both sides import from their own `../platform/core` seam, and the shared answer is `myne_core::account` behind the IPC. The helper lives here rather than in `vault-list.ts` precisely so the `vault-list.ts` twin stays byte-identical and the twin-drift ratchet stays green.",
  },
  {
    a: "src/lib/vault-recover.ts",
    b: "mobile/src/lib/vault-recover.ts",
    verdict: "decision",
    destination: "undecided",
    reason:
      "Byte-identical since myne-md/myne#492 gave `mobile/src` its own seam directory, so both sides now import from `../platform/`. Before that the single differing line WAS the seam import, and this entry is one of the four that argument was built on. Error enum in core/src/plugins/vault_recover/error.rs, measured.",
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
      "Byte-identical since myne-md/myne#492 gave `mobile/src` its own seam directory, so both sides now import from `../platform/`. Before that the single differing line WAS the seam import, and this entry is one of the four that argument was built on. What the runtime slot map reports is one answer.",
  },
  {
    a: "src/lib/vault-status.ts",
    b: "mobile/src/lib/vault-status.ts",
    verdict: "decision",
    destination: "undecided",
    reason:
      "Byte-identical since myne-md/myne#492 gave `mobile/src` its own seam directory, so both sides now import from `../platform/`. Before that the single differing line WAS the seam import, and this entry is one of the four that argument was built on.",
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
    a: "src/hooks/useDateTimeDisplaySync.ts",
    b: "mobile/src/lib/useDateTimeDisplaySync.ts",
    // `decision`, not `screen`. `screen` is an enumerated verdict meaning the
    // rendered surface or the HOST, and an adapter that reads a prefs seam is
    // neither; the spec holds that list to its definition rather than to its
    // size, which is what caught this. The destination is settled all the same,
    // so it is `per-client` rather than `undecided`.
    verdict: "decision",
    destination: "per-client",
    reason:
      "Per-client by construction, not by drift: each adapter reads its own client's prefs seam, and mobile additionally re-reads on the prefs nonce because its host mounts the adapter above the stage machine, so unlock is the event that makes prefs readable at all. What must not diverge is the VALUE published, displayFromPrefs(prefs, language), and the language listener that republishes it, since a language switch re-renders neither mounting component. check-datetime-display-publisher.mjs holds the weaker property that each client tree has a publisher at all; a one-sided edit to what gets published is what this pair is here for (myne-md/myne#609).",
  },
  {
    a: "src/notes/dailyNote.ts",
    b: "mobile/src/lib/daily.ts",
    verdict: "decision",
    destination: "undecided",
    reason:
      "Real code with two homes, at two different paths, so the path sweep cannot see it and check-twin-drift.mjs inherits that blindness. Six doc comments across the two files claim one mirrors the other exactly and nothing measured it. What a one-sided edit costs is stated by the files themselves: a period note is matched by folder plus title and nothing else, so a PERIOD_DEFAULTS or escape-grammar divergence files one week under two titles and one vault ends up with two notes for it. The behavioural half is pinned separately and better, by core/src/plugins/notes/period-title-cases.json, which both TypeScript trees and the Rust implementation run against; this entry exists so a one-sided EDIT is visible too. myne-md/myne#177.",
  },
  {
    a: "src/notes/prefsNonce.ts",
    b: "mobile/src/lib/prefsNonce.ts",
    verdict: "decision",
    destination: "undecided",
    reason:
      "Byte-identical and neither side a shim: real code with two homes. It is the mechanism check-prefs-nonce.mjs exists to protect, duplicated across the two trees that guard is meant to hold, which is the sharpest argument in the record for why the curated half of the denominator is not optional.",
  },
  {
    a: "src/notes/sidebarState.tsx",
    b: "mobile/src/app/flows/EditorFlow.tsx",
    verdict: "decision",
    destination: "undecided",
    reason:
      "Mobile re-implements the note-flag predicates rather than importing them from @myne/editor/host/notes/selectors. Line counts are meaningless for this pair: it is a behavioural counterpart, not a copy, so only the shared predicates are the twin.",
  },
  {
    a: "src/styles/tokens.css",
    b: "mobile/src/styles/tokens.css",
    verdict: "delegated",
    destination: "@myne/client-core",
    reason:
      "The design TOKENS moved to `client-core/src/tokens.css` (myne-md/myne#478); what these two files still hold is each client's component-local custom properties, which is per-client wiring over a shared answer. The gap they used to carry was 105 declarations across four palette blocks, the earlier count of twenty was the `:root` block alone, plus two shared names carrying DIFFERENT values, so a name-only comparison would have passed over the second class entirely. Both classes are now `scripts/check-token-parity.mjs`'s, which fires on one name with two independent declarations and on a fallback-less `var()` naming a token nothing declares. The AMOLED grey pair survives as a RECORDED override with its reason (mobile's recessed surfaces overlay the page rather than adjoining it), which is why this pair still differs and correctly so.",
  },
  {
    a: "src/types/note-create-error.ts",
    b: "mobile/src/types/note-create-error.ts",
    verdict: "delegated",
    destination: "@myne/client-core",
    reason: TYPE_SHIM_REASON,
  },
  {
    a: "src/types/note-delete-error.ts",
    b: "mobile/src/types/note-delete-error.ts",
    verdict: "delegated",
    destination: "@myne/client-core",
    reason: TYPE_SHIM_REASON,
  },
  {
    a: "src/types/note-list-error.ts",
    b: "mobile/src/types/note-list-error.ts",
    verdict: "delegated",
    destination: "@myne/client-core",
    reason: TYPE_SHIM_REASON,
  },
  {
    a: "src/types/note-read-error.ts",
    b: "mobile/src/types/note-read-error.ts",
    verdict: "delegated",
    destination: "@myne/client-core",
    reason: TYPE_SHIM_REASON,
  },
  {
    a: "src/types/note-update-error.ts",
    b: "mobile/src/types/note-update-error.ts",
    verdict: "delegated",
    destination: "@myne/client-core",
    reason: TYPE_SHIM_REASON,
  },
  {
    a: "src/types/protocol-error.ts",
    b: "mobile/src/types/protocol-error.ts",
    verdict: "delegated",
    destination: "@myne/client-core",
    reason: TYPE_SHIM_REASON,
  },
  {
    a: "src/types/quick-unlock-error.ts",
    b: "mobile/src/types/quick-unlock-error.ts",
    verdict: "delegated",
    destination: "@myne/client-core",
    reason: TYPE_SHIM_REASON,
  },
  {
    a: "src/types/slot-kind.ts",
    b: "mobile/src/types/slot-kind.ts",
    verdict: "delegated",
    destination: "@myne/client-core",
    reason: TYPE_SHIM_REASON,
  },
  {
    a: "src/types/vault-change-password-error.ts",
    b: "mobile/src/types/vault-change-password-error.ts",
    verdict: "delegated",
    destination: "@myne/client-core",
    reason: TYPE_SHIM_REASON,
  },
  {
    a: "src/types/vault-delete-error.ts",
    b: "mobile/src/types/vault-delete-error.ts",
    verdict: "delegated",
    destination: "@myne/client-core",
    reason: TYPE_SHIM_REASON,
  },
  {
    a: "src/types/vault-recovery-error.ts",
    b: "mobile/src/types/vault-recovery-error.ts",
    verdict: "delegated",
    destination: "@myne/client-core",
    reason: TYPE_SHIM_REASON,
  },
  {
    a: "src/types/vault-repair-error.ts",
    b: "mobile/src/types/vault-repair-error.ts",
    verdict: "decision",
    destination: "undecided",
    reason:
      "The one src/types twin that did NOT move into `@myne/client-core` with its fourteen siblings (myne-md/myne#475), and the rubric is what held it back rather than an oversight: discriminator 5 shares a Rust-mirroring TS module iff the Rust source is in `core/` or `protocol/`, and this one mirrors src-tauri/src/plugins/vault_repair/error.rs, which is itself an unresolved twin of mobile's copy. Hoisting the mirror above the thing it mirrors would put the shared answer one layer higher than the question. What actually differs is narrower than an earlier version of this reason claimed, and the correction is worth keeping: the two RUST enums already agree, variant for variant (`VaultBusyAuth`, `VaultPresent`, `NothingToRepair`, `PartialDelete`, `Io`), differing only in comments. The split is on the TS side, where desktop reaches for `IoErrorKind` from protocol-error and mobile for `IoFailureKind` from vault-unlock-error, the same four strings under two spellings. Both mirrors are held to their own Rust enum by `tests/types/rustEnumParity.test.ts`, which covers the mobile side too: package membership and parity coverage are independent decisions, and using one reason to skip both is how the uncovered mirror would have been the excused one.",
  },
  {
    a: "src/types/vault-status.ts",
    b: "mobile/src/types/vault-status.ts",
    verdict: "delegated",
    destination: "@myne/client-core",
    reason: TYPE_SHIM_REASON,
  },
  {
    a: "src/types/vault-summary.ts",
    b: "mobile/src/types/vault-summary.ts",
    verdict: "delegated",
    destination: "@myne/client-core",
    reason: TYPE_SHIM_REASON,
  },
  {
    a: "src/types/vault-unlock-error.ts",
    b: "mobile/src/types/vault-unlock-error.ts",
    verdict: "delegated",
    destination: "@myne/client-core",
    reason: TYPE_SHIM_REASON,
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
  // ── The two platform seams, and the six files that make them up
  //
  // These arrived after this roster was first measured (myne-md/myne#492 gave
  // `mobile/src` its own seam directory; `src/platform/` already had one), which
  // is the ENTERING-the-set case this guard exists to catch, and it caught them.
  //
  // Every one is `screen` under the second clause, and the clause was written
  // for exactly this shape: the file exists to name the host it renders into.
  // Two things follow from that and neither is drift. A seam names what ITS OWN
  // host is asked for, so a member present on one side and absent on the other
  // is a client that has no such call site rather than a gap. And desktop's seam
  // has a second implementation behind it (the web build substitutes a
  // wasm-Worker module with the same shape) while mobile's has none, so the two
  // are not even answering the same question: desktop's holds a contract open,
  // mobile's holds a boundary closed.
  //
  // The exception is `clipboardManager.ts`, which is `decision`, and mobile's
  // own file header already says why in as many words.
  {
    a: "src/platform/core.ts",
    b: "mobile/src/platform/core.ts",
    verdict: "screen",
    destination: "undecided",
    reason:
      "The IPC entry point. Identical export line on both sides; the headers differ because desktop's explains the web substitution the seam holds a contract open for, and mobile's explains that nothing substitutes behind it. Comment-only difference.",
  },
  {
    a: "src/platform/event.ts",
    b: "mobile/src/platform/event.ts",
    verdict: "screen",
    destination: "undecided",
    reason:
      "Backend-to-UI push. Mobile also exports `emit`, for the `share-file` event its setup hook listens for; desktop has no such call site, and adding one to make the files match would be inventing it. Mobile's header says so.",
  },
  {
    a: "src/platform/window.ts",
    b: "mobile/src/platform/window.ts",
    verdict: "screen",
    destination: "undecided",
    reason:
      "Host-window lifecycle. Same one-line export; the headers diverge on what the host IS, which is the point of the seam (a browser tab has no window to destroy; a phone has no `onCloseRequested` to swallow a fail-closed exit).",
  },
  {
    a: "src/platform/deepLink.ts",
    b: "mobile/src/platform/deepLink.ts",
    verdict: "screen",
    destination: "undecided",
    reason:
      "Deep-link registration. Desktop loads the plugin lazily because it is desktop-only and the import itself pulls a Tauri IPC binding into the web bundle; mobile is a Tauri host on both targets and needs no such guard.",
  },
  {
    a: "src/platform/path.ts",
    b: "mobile/src/platform/path.ts",
    verdict: "screen",
    destination: "undecided",
    reason:
      "Path arithmetic. The two clients address DIFFERENT directories on purpose: desktop re-exports `appDataDir`, mobile `documentDir`, because desktop picks an export destination through the OS save dialog and mobile has no dialog to pick with (myne-md/myne#491). Making the member lists match would be wrong on both sides.",
  },

  // ── The two Rust/TS pairs the merge brought in
  {
    a: "src/notes/setNoteCover.ts",
    b: "mobile/src/lib/setNoteCover.ts",
    verdict: "decision",
    destination: "@myne/dialect",
    reason:
      "One question with one answer: what bytes a cover write produces. myne-md/myne#410's decision entry rests the case for a second implementation on 'a cover set on a phone is byte-identical to one set on a desktop', and what is actually shared is the primitives rather than the ORDER (patch `cover:`, then stamp `updated:`), which is the byte-deciding part. A pure `applyCoverToPlaintext(current, choice, nowIso)` in `@myne/dialect` would make the claimed property hold by construction instead of by comment; both clients already source-consume that package. Desktop additionally re-indexes and takes a property key, and those are legitimately per-client. One further asymmetry is DELIBERATE and recorded here rather than left to be noticed (myne-md/myne#520): desktop flushes every dirty pane INSIDE this writer (`flushBeforeFrontmatterWrite`), on the argument that a caller-side guard is opt-in and caller three inherits the gap, which is exactly what happened to the saved-view card's Set cover. Mobile flushes at its single caller in `EditorFlow.applyNoteCover` instead, because this client has no flush registry to put it inside: one note is open at a time and the buffer lives in the flow. Nothing is reachable today, since mobile's one caller passes the open note's id; the day it grows a second caller or a second open note, this sentence is what says what it owes.",
  },
  {
    a: "src-tauri/src/navigation.rs",
    b: "mobile/src-tauri/src/navigation.rs",
    verdict: "decision",
    destination: "undecided",
    reason:
      "The WebView navigation allowlist: the one exfiltration channel the CSP cannot see (myne-md/myne#383, mobile twin myne-md/myne#453). Which origins a WebView may navigate to after a DOMPurify bypass is one security question with one answer, and the two files argue it in near-identical prose. What legitimately differs is the allowlist CONTENTS (dev-server port, `tauri.localhost` versus the Android asset host), which is data, not policy. A shared core taking a per-client allowlist is the obvious destination and nobody has decided it.",
  },
  {
    a: "src/hooks/useHeadFingerprintCompare.ts",
    b: "mobile/src/hooks/useHeadFingerprintCompare.ts",
    verdict: "decision",
    destination: "undecided",
    reason:
      "When two devices have converged, and what the UI says while they have not (myne-md/myne#462). One question, one answer, and a wrong answer on either client tells the user their vaults match when they do not. The twins were kept byte-identical through that change deliberately; nothing about convergence is per-client.",
  },

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
      "The per-client implementation of `myne_core::hooks::VaultLifecycleHooks`. One per client IS the seam, not drift: this is where a client that has no equivalent of a desktop side-effect says so, by leaving the method a no-op. But 'no-op' and 'the guarantee, unenforced' look identical in this file, and myne-md/myne#479 found one of each. `emit_snapshot_write_failed` was a bare empty body while mobile really does capture snapshots, fixed before that issue ran, and `check-twin-drift.mjs`'s header was the thing left stale, now corrected. `effective_auto_lock_secs` was the second and the more instructive: mobile returned `prefs_value.unwrap_or(DEFAULT)` with NO clamp, and so did web. Stated at its real size, because the first version of this reason overstated it: that value is read only by the desktop tick loop, which neither client compiles, so it was a trap for the next Rust-side reader rather than a shipped A6 window. Chasing it is what surfaced the exposure that WAS live, one language over, in the web client's `useIdleAutoLock` call sites, which took the raw pref and read `null` as 'disabled' against `threat-model.md` §7. The fix moved the envelope into `myne-core`, gave the trait method a clamping DEFAULT, and routed both WebView call sites through the TypeScript mirror.",
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
    a: "src-tauri/src/plugins/chats/mod.rs",
    b: "mobile/src-tauri/src/plugins/chats/mod.rs",
    verdict: "delegated",
    destination: "myne-core",
    reason:
      SHIM_REASON,
  },
  {
    a: "src-tauri/src/plugins/memory/mod.rs",
    b: "mobile/src-tauri/src/plugins/memory/mod.rs",
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
    a: "src-tauri/src/plugins/account/mod.rs",
    b: "mobile/src-tauri/src/plugins/account/mod.rs",
    verdict: "delegated",
    destination: "myne-core",
    reason:
      "Host-registration shim for the account record (the account/vault split, myne-md/myne#684). Both sides carry `pub use myne_core::account::{...}` (a crate-root module, like `vault_label`) and keep only the Tauri plugin builder and its capability grant, so the shared answer is already in `myne-core` and the divergence is the wiring. The two grants are known to differ BY DESIGN: desktop and mobile both register all four commands, but on Android the keychain has no backend so the record holds nothing and vaults show standalone.",
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
      "The `attachment://` URI-scheme handler. No `pub use` on either side, so both hold real logic, and what a scheme request is allowed to read out of a vault is one answer rather than two. 261 lines against 84.",
  },
  {
    a: "src-tauri/src/plugins/workspace/mod.rs",
    b: "mobile/src-tauri/src/plugins/workspace/mod.rs",
    verdict: "delegated",
    destination: "myne-core",
    reason:
      "RESOLVED in myne-md/myne#479. Both sides now carry `pub use myne_core::plugins::workspace::{commands, error}` and keep only the Tauri plugin builder, so what remains is the wiring. Mobile's 297-line fork was justified by 'hoisting would mean migrating desktop in the same change' and desktop had since been migrated, so the fork outlived its own stated exit condition, and had fallen behind in two ways nothing could see: it parsed `vault.meta` with the v0.1-only `parse_vault_meta`, which hard-rejects `NTV5`, so on a MIGRATED vault this client's workspace reads and writes both failed while every other plugin worked; and it read through a flat `std::fs::read` rather than `singleton::open_newest_and_sweep`, so it had none of myne-md/myne#301's torn-write recovery. The command SET stays asymmetric and correctly so: the core exports a third `#[tauri::command]`, `workspace_stage`, for desktop's Cmd+Q RAM-staging, and mobile's `generate_handler!`, `build.rs` and ACL are all two wide.",
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
      "The WAV reader and resampler, and the file myne-md/myne#485 (mobile) and myne-md/myne#510 (desktop) both live in. The divergence those two closed was real and cost a fix twice: mobile shipped without the rate clamp, then desktop kept a picked 8-hour ceiling that the attachment cap and the 4x clamp put permanently out of reach, so it refused nothing while its own test asserted around the branch. Both now derive `MAX_PCM_SAMPLES` from `protocol::MAX_ATTACHMENT_LEN`, bound the decode inside `parse_wav`, and check above the identity fast-path. Imports only `serde::Serialize` and `protocol::MAX_ATTACHMENT_LEN`, both already in `core/Cargo.toml`, so extracting it to `myne-core` adds no crate to any dependency closure, and myne-md/myne#510 converged their BEHAVIOUR without converging their text: both now derive the ceiling the same way, bound the decode in the same place and check above the same fast-path. The figures an earlier version of this reason carried were wrong and are replaced with measured ones. `diff` over the two files reports 443 differing lines; stripping comments and blank lines and diffing what is left reports 135. Neither is the 146-lines-nearly-all-prose figure nor the nine-differing-executable-lines figure this reason used to claim. What IS true and is the part that matters for an extraction: desktop carries two `const _: () = assert!` blocks tying its ceiling to the voice recorder's duplicated copy, and mobile carries neither because it has no cpal recorder to tie to. This guard reports it in the byte-different bucket, which is the honest flag. Extracting to `myne-core` is therefore a merge of two comment sets plus a decision about where those two desktop-only assertions live, not a byte-for-byte move. An earlier version of this reason claimed semantic identity, which was true for one review round and stopped being true inside the same branch. Tracked with its sibling `whisper.rs` under myne-md/myne#479; this row cited no issue at all until then, which is how a free extraction ends up with no owner.",
  },
  {
    a: "src-tauri/src/plugins/local_inference/model_store.rs",
    b: "mobile/src-tauri/src/plugins/local_inference/model_store.rs",
    verdict: "decision",
    destination: "undecided",
    reason:
      "Model resolution and integrity checking, 1019 lines against 766. Needs only `sha2`, `serde` and `thiserror`, all already declared in `core/Cargo.toml`, so it extracts with no dependency movement.",
  },
  {
    a: "core/src/inference/engine.rs",
    b: "mobile/src-tauri/src/plugins/local_inference/engine.rs",
    verdict: "decision",
    destination: "myne-core",
    reason:
      "The engine trait and its shared implementation. The verdict is no longer a prediction: myne-md/myne#456 MOVED the desktop side into `myne-core`, so `a` is the shared answer and 2263 lines against 389 now measures how far mobile's copy trails it rather than how much the two clients differ. Mobile still declares its own `mod engine;` and compiles against that copy, which is a live duplication rather than a narrowing: `transcribe` is real there while `infer` and `embed` return `NotReady`, and the same shape now exists once in core. Deleting mobile's copy is the follow-up this row exists to keep visible; #456 stopped at the remote arm because that is what it needed and pulling the transcription path across would have been a second migration inside one PR.",
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
    a: "core/src/inference/error.rs",
    b: "mobile/src-tauri/src/plugins/local_inference/error.rs",
    verdict: "decision",
    destination: "myne-core",
    reason:
      "The engine error enum, 242 lines against 129. Re-pointed by myne-md/myne#456, which moved the desktop side into `myne-core`, so the shared answer exists and mobile's is a stale subset of it rather than a peer mirror. Same drift class as the `src/types/*-error.ts` mirrors one layer up, with one difference that matters: `tests/lib/engineErrorTaxonomy.test.ts` reads `a` by an exact path and compares the TypeScript taxonomy against it, so THIS side cannot drift silently. Mobile's can, and does.",
  },
  {
    a: "src-tauri/src/plugins/local_inference/commands.rs",
    b: "mobile/src-tauri/src/plugins/local_inference/commands.rs",
    verdict: "absent",
    destination: "undecided",
    reason:
      "STRAINED VERDICT, recorded as such. Mobile registers exactly two commands (`transcribe`, `read_transcript`, measured) against desktop's full set, so most of this file is a surface mobile does not ship, and `absent` is the dominant reading. The two it does ship are duplicated logic. The LIVE DEFECT this row used to record is FIXED in myne-md/myne#479: mobile read the vault meta with the v0.1-only `protocol::parse_vault_meta` where desktop uses `parse_vault_meta_any`, and since both swallow the result with `.ok()?`, on a MIGRATED vault the MYE1 attachments-text cache was silently never written and never read, no error, no log, a plausible nothing-cached. Its `derive_subkey` sites remain and are legitimate for the same reason the desktop twin's are (a rebuildable cache the migration drops), and are now RECORDED in `check-version-routing.mjs` rather than merely invisible to it: that guard's ROOTS were `core/src` and `src-tauri/src`, so it reported `0 still debt` over a tree it never opened, and `mobile/src-tauri/src` joined them in the same change.",
  },
  {
    a: "src-tauri/src/plugins/local_inference/mod.rs",
    b: "mobile/src-tauri/src/plugins/local_inference/mod.rs",
    verdict: "absent",
    destination: "undecided",
    reason:
      "Plugin registration for a surface mobile ships a two-command slice of. 1078 lines against 112, and mobile's is independently written rather than a trimmed copy.",
  },
  {
    a: "src/lib/agent-run.ts",
    b: "mobile/src/lib/agent-run.ts",
    verdict: "delegated",
    destination: "myne-core",
    reason:
      "Each client's SEAM INJECTION for the agent's IPC bindings, and nothing else: 29 lines against 40, of which the difference is one import specifier and the comment explaining it. The bindings themselves, their command names and their argument shapes, live in `src/lib/agent-run-core.ts` and are consumed by both, which is what myne-md/myne#456 built rather than letting mobile retype them. `delegated` is the right verdict even though the shared half is not in `myne-core`: this record's `destination` vocabulary is about where a shared answer LIVES, and for a TypeScript module that place is a shared package, which is what `@myne/agent-run-core` aliases to. What could not be delegated is exactly the two names `invoke` and `Channel`, because `scripts/check-platform-seam.mjs` requires each guarded root to reach them through its own directory. The pair stays in the record rather than being dropped as trivial, since it is where a client could quietly stop delegating.",
  },
  {
    a: "src-tauri/src/plugins/agent/mod.rs",
    b: "mobile/src-tauri/src/plugins/agent/mod.rs",
    verdict: "absent",
    destination: "undecided",
    reason:
      "Plugin registration for the agent surface, new on mobile in myne-md/myne#456, 337 lines against 366. `absent` rather than `decision` because what these two files hold is each host's own wiring: the `tauri::plugin::Builder`, the `generate_handler!` roster and the state each client manages. The shared answer they both call is already in `myne-core` (`plugins/agent/host_commands.rs`), which is why the two are close in size while sharing no logic. Neither is a copy of the other: mobile registers nine commands against desktop's eight, and the ninth (`agent_list_provider_models`) exists because mobile has no local model to fall back on.",
  },
  {
    a: "src-tauri/src/plugins/agent/commands.rs",
    b: "mobile/src-tauri/src/plugins/agent/commands.rs",
    verdict: "absent",
    destination: "undecided",
    reason:
      "The `#[tauri::command]` layer, 567 lines against 390, and the pair is the three-layer command shape working rather than drift. myne-md/myne#456 reduced desktop's side from 1442 lines to thin wrappers by moving the body into `myne-core`; mobile's was written against that same core from the start. The /simplify pass then took two more: `agent_apply` and `agent_undo` were still retyped verbatim on both sides, and the undo retype had silently DROPPED the myne-md/myne#531 fix that puts failed restore points back, so a partial undo failure consumed the record permanently on mobile. Both moved to `host_commands::{apply_from_host, undo_from_host}`. What is left on each side is argument marshalling and the client's own two seams (its engine and its scope searcher), which are BY DEFINITION per-client. Measured rather than assumed: neither file carries a security rule, a precondition or a refusal of its own. The `agent_start` argument disagreement this reason used to record (desktop declared `language` and `history`, mobile did not, desktop read neither) is closed by myne-md/myne#648: both sides declare and seed both now.",
  },
  {
    a: "src-tauri/src/plugins/agent/adapters.rs",
    b: "mobile/src-tauri/src/plugins/agent/adapters.rs",
    verdict: "absent",
    destination: "undecided",
    reason:
      "Each client's implementation of the two seams `myne-core`'s agent loop asks for, 226 lines against 117. The desktop one bridges to a local Candle engine and desktop's own search index; mobile's bridges to `NoLocalEngine` plus the remote provider registry. The gap is the whole of what #456 is about, so treating them as one answer would be classifying the seam as drift. Desktop's extra 105 lines are the local-inference arm and the capability-probe test that moved here with it.",
  },
  {
    a: "core/src/inference/state.rs",
    b: "mobile/src-tauri/src/plugins/local_inference/state.rs",
    verdict: "decision",
    destination: "myne-core",
    reason:
      "The inference state machine, 1467 lines against 40. Re-pointed AND re-verdicted by myne-md/myne#456, and the re-verdict is the point: `absent` rested on mobile not shipping chat or embedding sessions, and #456 ships chat on mobile through the remote arm, so the premise is gone. `a` moved into `myne-core` in the same change and mobile now reaches its remote half through the core registry, while these 40 lines remain wiring for the transcription path. What the pair records today is that mobile holds a second, unrelated `state.rs` under the same name in the same plugin, which is exactly the confusion a verdict is for.",
  },
];

const VERDICTS = ["decision", "screen", "absent", "delegated"];

/** Every file under `dir`, as paths relative to `root`. */
function* walk(dir, root) {
  let entries;
  try {
    // `withFileTypes` rather than a `statSync` per entry: the directory read
    // already knows which entries are directories, and asking again cost 946
    // extra syscalls on this tree. Measured 4.25 ms -> 3.35 ms for the walk
    // alone. `check-prefs-nonce.mjs` and `check-platform-seam.mjs` moved off the
    // statSync form for the same reason.
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (SKIP_DIRS.has(entry.name)) continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) yield* walk(full, root);
    else if (entry.isFile()) yield relative(root, full);
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
    // BOTH roots, same treatment. A missing desktop root used to `continue`
    // silently, which scans zero files and surfaces later as a pile of
    // "orphaned" entries rather than as the one fact that explains them; the
    // mobile side threw. Same event, so same answer.
    //
    // Thrown rather than `process.exit`, because `discover` is exported and the
    // suite calls it directly: an exit here kills the Vitest worker and reports
    // as an infrastructure crash instead of a named failure. `main` catches it
    // and exits.
    for (const root of [deskRoot, mobRoot]) {
      if (!existsSync(at(root))) {
        throw new Error(
          `twin-inventory: ${root} is missing. Both sides are in-repo since decisions.md 0488, so this is a broken checkout rather than an un-cloned companion.`,
        );
      }
    }
    // Intersect two walks rather than walking one side and `existsSync`-ing the
    // other: the per-file existence probe cost 864 stat syscalls to answer a
    // question the (much smaller) mobile walk already contains. Measured 6.51 ms
    // -> 4.91 ms, and 1,810 stat syscalls -> 0.
    const mobFiles = new Set(walk(at(mobRoot), at(mobRoot)));
    for (const rel of walk(at(deskRoot), at(deskRoot))) {
      if (mobFiles.has(rel)) twins.push({ a: join(deskRoot, rel), b: join(mobRoot, rel) });
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
function projectionBody(roster) {
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

  const body = `<!-- GENERATED by scripts/check-twin-inventory.mjs --emit. Do not edit by hand:
     the roster in that script is the source of truth, and it is also the gate. -->

# Twin inventory: every desktop/mobile module that answers the same question twice

Desktop (\`src/\`, \`src-tauri/src/\`) and mobile (\`mobile/…\`) compile from trees meant to share
their decisions. This is the record of where they do, where they do not, and which of those is a
bug. It is generated from \`scripts/check-twin-inventory.mjs\`, which is also the gate, so the two
cannot disagree.

**${roster.length} twins:** ${byVerdict("decision").length} decision, ${byVerdict("screen").length} screen, ${byVerdict("absent").length} absent, ${byVerdict("delegated").length} delegated.

Those five numbers come from the roster, so they move only when the roster does, which is exactly
when this document should be regenerated. How many pairs currently *differ*, and how many differ only
cosmetically, are measurements of the trees rather than of the record: they are printed by
\`node scripts/check-twin-inventory.mjs\` and deliberately kept out of this byte-gated file.

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

Every pair carries a mechanical **byte** flag and a **semantic** one. Some byte-different pairs
behave identically, mostly Rust files whose only difference is doc prose, and gating on bytes would
make those permanent red entries nobody can close.

**The counts are deliberately not in this document.** They move whenever any twin is edited, and
this document is byte-gated by \`--check\`, so publishing them here means a comment added to either
side of any byte-identical pair reddens \`pre-commit\` with a message whose first suggestion is that
this file was hand-edited. \`node scripts/check-twin-inventory.mjs\` prints them.

The four \`src/lib/vault-*.ts\` pairs this argument was originally built on are **byte-identical**
now: myne-md/myne#492 gave \`mobile/src\` its own seam directory, so the one line that used to differ
no longer does, and the seam-canonicalization arm of the rule currently moves no pair at all. The
mechanism is kept because it is the right rule and will have members again the moment a seam member
diverges.

**Two files are semantically identical iff they compare equal after stripping comments,
canonicalizing the seam import specifier, and eliding blank lines and leading indentation.** The
third clause carries most of the count: comments and the seam alone would give 78 semantic and 2
cosmetic. The seam map is derived from \`src/platform/\` at runtime rather than hardcoded, so it
cannot drift from the seam it describes.

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

function emitProjection(roster, target = PROJECTION) {
  writeFileSync(at(target), projectionBody(roster));
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
function checkProjection(roster, target = PROJECTION) {
  const want = projectionBody(roster);
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
 * The raw-string opener at `i` as `{ length, hashes }`, or null when there is none.
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

function stripComments(text, grammar = "js") {
  // `grammar` was a boolean `isRust` until CSS joined the roster and turned the
  // two-valued question into a three-valued one. The boolean spelling is gone:
  // the seven remaining callers were all in this file's own spec, and they were
  // passing `true` where the signature says `string`, which nothing reported
  // until `tsconfig.tests.json` gained `allowJs` and TypeScript could finally
  // read this script. A parameter that answers to two shapes is one a caller can
  // get wrong in a way no checker sees.
  const isRust = grammar === "rust";
  const lineComments = grammar !== "css";
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
    if (lineComments && c === "/" && text[i + 1] === "/") {
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
 * `grammar` selects the `'` reading and the `//` reading in `stripComments`
 * and nothing else.
 */
function normalize(text, aliases, grammar = "js") {
  let s = stripComments(text, grammar);
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
  // Blank lines are dropped. This is the part of the rule that does the most
  // work and was, until myne-md/myne#472's review, the part no published
  // statement of the rule mentioned: with comments and the seam alone the
  // counts are 78 semantic / 2 cosmetic, and with the blank-line elision they
  // are 65 / 15. Thirteen of the fifteen cosmetic-only verdicts come from here
  // alone, so a reader given the shorter rule cannot reproduce the number.
  //
  // It is kept, because a comment removed from the middle of a block leaves a
  // blank line behind and calling that a semantic difference would make the
  // comment-stripping pointless. What it costs is stated rather than hidden:
  // indentation and blank lines INSIDE a multi-line string are content, so
  // `\`a\n    b\`` and `\`a\nb\`` compare equal here. That is a false-equal in
  // the direction the header calls unsafe, it is latent (no rostered pair
  // differs that way today), and the honest form of the claim is the one now
  // published: equal after stripping comments, canonicalizing the seam import
  // AND eliding blank lines and leading indentation.
  //
  // The per-line `trim()` is measured at zero contribution today (the counts
  // are 65 / 15 with or without it) and kept only because it is what makes
  // reindentation cosmetic, which is the same argument as the blank line.
  return s
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0)
    .join("\n");
}

/**
 * The comment grammar to read a file under, from its extension.
 *
 * `.css` is the case this exists for: `//` is NOT a comment in CSS, and reading
 * it as one truncates the rest of the line on BOTH sides, so
 * `url(https://cdn/a.png); border: 1px` and `url(https://cdn/b.png); border: 9px`
 * both collapse to `url(https:` and compare EQUAL. Two `tokens.css` files are on
 * the roster. Latent today (neither contains a `//`), and it is the
 * under-reporting direction the header calls unsafe, which is the one that
 * hides drift rather than inventing it.
 */
function grammarFor(path) {
  if (path.endsWith(".rs")) return "rust";
  if (path.endsWith(".css")) return "css";
  return "js";
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
      normalize(x, aliases, grammarFor(a)) === normalize(y, aliases, grammarFor(b)),
  };
}

function main() {
  const rootsFlag = process.argv.indexOf("--roots");
  const injected = rootsFlag !== -1;
  // Arity checked here rather than left to an uncaught TypeError out of
  // `readInjected`, which fires BEFORE the try/catch that exists to turn
  // `discover`'s throw into a named failure, so `--roots` alone died with a
  // stack trace.
  if (injected && (!process.argv[rootsFlag + 1] || !process.argv[rootsFlag + 2])) {
    console.error(
      "twin-inventory: --roots takes two directories: --roots <desktop-tree> <mobile-tree>.",
    );
    process.exit(2);
  }
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

  // A reason is the record's whole value: it is what stops the next reader
  // re-deriving the verdict. An entry without one is a verdict pretending to be
  // one, and it renders as an empty table cell that `--check` accepts as
  // consistent. The spec asserted this and the guard did not, so `CLAUDE.md`'s
  // claim that this guard enforces "a verdict AND a reason" was half true and
  // an entry could land empty through `pre-commit`.
  const reasonless = roster.filter((e) => !(e.reason ?? "").trim());
  if (reasonless.length > 0) {
    console.error(
      `twin-inventory: ${reasonless.length} entr(ies) carry no reason:\n` +
        reasonless.map((e) => `    ${e.a}`).join("\n") +
        `\n  A verdict with no reason makes the next reader re-derive it, which is the` +
        `\n  bookkeeping this record exists to replace.`,
    );
    failed = true;
  }

  // Line counts written into a reason go stale silently, and this record is
  // republished verbatim into a CC-BY document. Five were already wrong when
  // this was added: `model_store.rs` said "820 lines against 766" against a
  // live 1019, `sidebarState.tsx` said 3384 against a live 3414, and
  // `prefsNonce.ts` said "Byte-identical at 60 lines" against 178. Two of the
  // three were wrong in two places at once, because the same sentence was
  // copied into a second field.
  //
  // The alternative was to ban absolute counts from reasons. Rejected: the size
  // ratio is often the whole argument (`1416 lines against 40` is what makes a
  // pair obviously not a copy), and a rule that forbids the evidence to avoid
  // checking it is the wrong trade. So they are allowed and they are checked.
  const COUNT_CLAIM = /\(?(\d+)\s+(?:lines?\s+)?against\s+(\d+)\)?|Byte-identical at (\d+) lines/g;
  const lineCount = (rel) => {
    try {
      return readFileSync(at(rel), "utf8").split("\n").length - 1;
    } catch {
      return null;
    }
  };
  const staleCounts = [];
  for (const e of roster) {
    const la = lineCount(e.a);
    const lb = lineCount(e.b);
    if (la === null || lb === null) continue;
    for (const m of (e.reason ?? "").matchAll(COUNT_CLAIM)) {
      if (m[3] !== undefined) {
        if (Number(m[3]) !== la) {
          staleCounts.push(`    ${e.a}: "${m[0]}", but it is ${la} lines`);
        }
      } else if (Number(m[1]) !== la || Number(m[2]) !== lb) {
        staleCounts.push(`    ${e.a}: "${m[0]}", but it is ${la} against ${lb}`);
      }
    }
  }
  if (staleCounts.length > 0) {
    console.error(
      `twin-inventory: ${staleCounts.length} line-count claim(s) in a reason no longer describe the files:\n` +
        staleCounts.join("\n") +
        `\n  These are republished into docs/dev/twin-inventory.md, so a stale one is a` +
        `\n  published false claim rather than a private note. Update the reason.`,
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
  const compared = twins.map((t) => ({ ...t, ...(compare(t.a, t.b, aliases) ?? {}) }));
  const diffs = compared.filter((t) => t.byteEqual !== undefined);
  // A pair `compare` could not read used to vanish from both published counts
  // with no message, which is the shrinking-denominator failure every other
  // check here refuses. `existsSync` passes for a DIRECTORY, so a curated entry
  // naming one clears the stale check and the set comparison, then disappears
  // here. Say so.
  const unreadable = compared.filter((t) => t.byteEqual === undefined);
  if (unreadable.length > 0) {
    console.error(
      `twin-inventory: ${unreadable.length} pair(s) could not be read, so they are absent from ` +
        `every count below:\n` +
        unreadable.map((t) => `    ${t.a}\n      paired with ${t.b}`).join("\n") +
        `\n  A directory passes existsSync, so this is usually an entry naming one.`,
    );
    failed = true;
  }
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
    emitProjection(roster, injected ? join(deskDir, "projection.md") : PROJECTION);
  }

  if (failed) process.exit(1);

  // `--check` is the other way round: comparing against a roster already known
  // to be wrong would report staleness that is a symptom of the real failure.
  if (process.argv.includes("--check")) {
    checkProjection(roster, injected ? join(deskDir, "projection.md") : PROJECTION);
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
  // Exported for `scripts/check-twin-drift-ratchet.mjs` (myne-md/myne#473),
  // which compares INJECTED text rather than paths so its own test can drive it
  // against synthetic pairs. `compare` reads from disk, so a ratchet built on it
  // has a seam that does not actually inject, which is what that guard's first
  // version had, and what its first test caught.
  grammarFor,
  compare,
};
