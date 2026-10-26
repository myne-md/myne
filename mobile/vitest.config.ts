import { fileURLToPath, URL } from "node:url";
import { defineConfig } from "vitest/config";

// Resolve a path relative to THIS config file (mobile/), so the sibling
// shared packages under the parent `myne/` repo resolve regardless of cwd.
const sib = (p: string) => fileURLToPath(new URL(p, import.meta.url));

// Frontend unit tests for the mobile client - mirrors the main repo's vitest
// setup. Tests live under `tests/` (NOT `src/`), so `pnpm build` (tsc, which
// only checks `include: ["src"]`) does not cover them; `pnpm test` is the gate.
//
// The cryptographic primitives are validated upstream by `myne-test-vectors`
// against the shared `protocol` crate (reused here by path dep, byte-identical
// by construction), and the mirrored backend carries 560 Rust unit tests
// (`cargo test`). These TS tests cover the ported state machine + helpers.
export default defineConfig({
  // The shared @myne/{editor,dialect} engines are source-aliased to the
  // sibling parent-repo packages - the same aliases as vite.config.ts (vitest
  // does not read that file, so any test transitively importing
  // `src/dialect/*` fails to resolve without this mirror).
  resolve: {
    alias: [
      { find: /^@myne\/editor$/, replacement: sib("../editor/src/index.ts") },
      { find: /^@myne\/editor\/(.*)$/, replacement: sib("../editor/src/$1") },
      { find: /^@myne\/dialect$/, replacement: sib("../dialect/src/index.ts") },
      { find: /^@myne\/dialect\/(.*)$/, replacement: sib("../dialect/src/$1") },
      // The shared sync-staleness RULE (myne#583) - mirror of vite.config.ts,
      // which carries the rationale for sharing it. `mobile/src/components/
      // SyncBanners.tsx` imports it, so any test that reaches the components
      // barrel fails to TRANSFORM without this line, and the file appears in
      // no count. The mirror is kept complete rather than only where today's
      // specs happen to reach it.
      { find: "@myne/sync-staleness", replacement: sib("../src/lib/sync-staleness.ts") },
      { find: "@myne/locales-en", replacement: sib("../locales/en/common.json") },
      // The legal-document URL table (operations#15) - mirror of vite.config.ts,
      // which carries the rationale. `SettingsSheet.tsx` imports it, so without
      // this line the sheet cannot be mounted in a component test and appears in
      // no count, passing or failing.
      { find: /^@myne\/legal-urls$/, replacement: sib("../src/lib/legal-urls.ts") },
      // Shared react-i18next runtime (MYND-485) - mirror of vite.config.ts.
      { find: /^@myne\/i18n$/, replacement: sib("../src/i18n/index.ts") },
      { find: /^@myne\/i18n\/(.*)$/, replacement: sib("../src/i18n/$1") },
      // Shared decoration vocabulary for the synced `folder_icons` / `item_colors`
      // prefs maps (MYND-516) - mirror of vite.config.ts, which carries the
      // rationale for sharing these rather than copying them.
      // The reminder scheduling decision core (MYND-619 task 5) - mirror of
      // vite.config.ts, which carries the rationale for sharing rather than
      // copying it.
      { find: /^@myne\/reminder-schedule$/, replacement: sib("../src/lib/reminderSchedule.ts") },
      // The shared enrol gate (myne-md/myne-mobile#38) - mirror of
      // vite.config.ts, which carries the rationale for sharing it.
      { find: /^@myne\/enroll-gate$/, replacement: sib("../src/lib/enroll-gate.ts") },
      // The custom-theme syntax derivation (MYND-598) - mirror of
      // vite.config.ts, which carries the rationale for sharing it.
      // The ornament role contract and the measure-token clamp (myne#394) -
      // mirror of vite.config.ts. `src/lib/customTheme.ts` imports both, so
      // without these two lines every test that reaches custom-theme code fails
      // to TRANSFORM: two files never load and their 21 tests appear in no
      // count, passing or failing. This file's own header says why the mirror
      // exists, and it is exactly the failure it warns about.
      { find: /^@myne\/theme-measure$/, replacement: sib("../src/lib/themeMeasure.ts") },
      { find: /^@myne\/theme-canon$/, replacement: sib("../src/lib/themeCanon.ts") },
      { find: /^@myne\/ornaments$/, replacement: sib("../ornaments/src/index.ts") },
      { find: /^@myne\/ornaments\/(.*)$/, replacement: sib("../ornaments/src/$1") },
      // The shared knowledge-graph overlay builder (myne-md/myne#727) - mirror of
      // vite.config.ts. `mobile/src/components/WikiGraph.tsx` and
      // `EditorFlow.tsx` import it, so without these a test that reaches either
      // fails to TRANSFORM and appears in no count, passing or failing.
      { find: /^@myne\/graph-overlay$/, replacement: sib("../src/notes/graphOverlay.ts") },
      { find: /^@myne\/graph-color-groups$/, replacement: sib("../src/notes/graphColorGroups.ts") },
      // The task index's wire decoder (myne-md/myne-mobile#36) - mirror of
      // vite.config.ts, which carries the rationale for sharing it.
      { find: /^@myne\/task-wire$/, replacement: sib("../src/notes/taskWire.ts") },
      { find: /^@myne\/task-panel$/, replacement: sib("../src/notes/components/TaskListPanel.tsx") },
      { find: /^@myne\/task-filters$/, replacement: sib("../src/notes/taskFilters.ts") },
      { find: /^@myne\/task-scope$/, replacement: sib("../src/notes/taskScope.ts") },
      { find: /^@myne\/task-view$/, replacement: sib("../src/notes/taskView.ts") },
      { find: /^@myne\/task-write$/, replacement: sib("../src/notes/taskWriteCore.ts") },
      { find: /^@myne\/note-completion$/, replacement: sib("../src/notes/completeNoteCore.ts") },
      // The agent's wire types and its RAM-only run store (myne-md/myne#456).
      // Both are safe to alias out of `../src/`, and for the same reason the
      // task-* block above is: neither reaches a host. `agent-protocol.ts` was
      // SPLIT out of `agent-run.ts` precisely so this alias could exist, since
      // that file opens IPC channels through DESKTOP's platform seam and a
      // mobile client importing it would be reaching through the wrong
      // boundary. `agentStore.ts` imports only React and the protocol module,
      // so mobile shares the whole 755-line state machine, the epoch guards,
      // the rejection sets, the apply/undo bookkeeping, rather than retyping
      // rules that already exist.
      { find: /^@myne\/agent-protocol$/, replacement: sib("../src/lib/agent-protocol.ts") },
      { find: /^@myne\/agent-store$/, replacement: sib("../src/notes/agent/agentStore.ts") },
      { find: /^@myne\/agent-run-core$/, replacement: sib("../src/lib/agent-run-core.ts") },
      // The three-figure cost line, shared rather than re-worded. Its own module
      // comment is the reason: `design-notes/ai/0515` records this sentence as
      // the compensating control for the remote arm having no volume bound, and
      // "a control that is worded in two places is a control that is worded
      // differently in two places". Its only imports are React and i18next.
      { find: /^@myne\/run-cost-line$/, replacement: sib("../src/notes/agent/components/RunCostLine.tsx") },
      // The last-run undo's LOGIC, shared rather than retyped. Its own header is
      // the argument: it carries three recorded defect fixes, each invisible
      // until it happens to a user, and it imports neither client's bindings:
      // they arrive as arguments, exactly as `agent-run-core` takes a seam.
      { find: /^@myne\/undo-last-run$/, replacement: sib("../src/notes/agent/useUndoLastRun.ts") },
      // The `EngineError` cause taxonomy. Zero imports, so it is pure by
      // construction, and it is the ONE reader of that wire shape: a second
      // hand-written table is how a Rust variant a client has never heard of
      // falls into the catch-all and four situations render one sentence.
      // `tests/lib/engineErrorTaxonomy.test.ts` parses the Rust enum and holds
      // this file to it, so the alias buys mobile that drift lock too.
      { find: /^@myne\/engine-error$/, replacement: sib("../src/lib/engine-error.ts") },
      { find: /^@myne\/decorations$/, replacement: sib("../src/notes/decorations.ts") },
      { find: /^@myne\/decorations\/folderIcons$/, replacement: sib("../src/notes/folderIcons.ts") },
      // Mirror of vite.config.ts (myne-md/myne#867): the note-mention matcher,
      // which `mobile/src/components/MentionText.tsx` imports. The mirror is
      // kept complete rather than only where today's specs happen to reach it.
      { find: /^@myne\/note-mentions$/, replacement: sib("../src/notes/ai/noteMentions.ts") },
      // The live-collaboration awareness cluster (myne-md/myne#849) - mirror of
      // vite.config.ts, which carries the rationale. `mobile/src/lib/awareness.ts`
      // imports four of these, so without the mirror every spec that reaches it
      // fails to TRANSFORM, and the store a spec drives would be a DIFFERENT module
      // instance from the one the app reads.
      { find: /^@myne\/awareness-store$/, replacement: sib("../src/notes/collab/awarenessStore.ts") },
      { find: /^@myne\/participant$/, replacement: sib("../src/notes/collab/participant.ts") },
      { find: /^@myne\/identity-label$/, replacement: sib("../src/notes/collab/identityLabel.ts") },
      { find: /^@myne\/presence-labels$/, replacement: sib("../src/notes/collab/presenceLabels.ts") },
      { find: /^@myne\/presence-jump$/, replacement: sib("../src/notes/collab/presenceJump.ts") },
      { find: /^@myne\/resolved-identity$/, replacement: sib("../src/types/resolved-identity.ts") },
    ],
  },
  test: {
    include: ["tests/**/*.test.ts", "tests/**/*.test.tsx"],
    environment: "node",
    globals: false,
    // A working `Storage` over Node 25's incomplete experimental global, which
    // shadows jsdom's and breaks every spec that reads `localStorage`. The file
    // carries the failure it prevents and the reason it is a setup file rather
    // than a per-spec helper.
    setupFiles: ["./tests/setup-usable-storage.ts"],
  },
});
