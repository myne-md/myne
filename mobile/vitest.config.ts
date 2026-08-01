import { fileURLToPath, URL } from "node:url";
import { defineConfig } from "vitest/config";

// Resolve a path relative to THIS config file (myne-mobile/), so the sibling
// shared packages under the parent `myne/` repo resolve regardless of cwd.
const sib = (p: string) => fileURLToPath(new URL(p, import.meta.url));

// Frontend unit tests for the mobile client — mirrors the main repo's vitest
// setup. Tests live under `tests/` (NOT `src/`), so `pnpm build` (tsc, which
// only checks `include: ["src"]`) does not cover them; `pnpm test` is the gate.
//
// The cryptographic primitives are validated upstream by `myne-test-vectors`
// against the shared `protocol` crate (reused here by path dep, byte-identical
// by construction), and the mirrored backend carries 560 Rust unit tests
// (`cargo test`). These TS tests cover the ported state machine + helpers.
export default defineConfig({
  // The shared @myne/{editor,dialect} engines are source-aliased to the
  // sibling parent-repo packages — the same aliases as vite.config.ts (vitest
  // does not read that file, so any test transitively importing
  // `src/dialect/*` fails to resolve without this mirror).
  resolve: {
    alias: [
      { find: /^@myne\/editor$/, replacement: sib("../editor/src/index.ts") },
      { find: /^@myne\/editor\/(.*)$/, replacement: sib("../editor/src/$1") },
      { find: /^@myne\/dialect$/, replacement: sib("../dialect/src/index.ts") },
      { find: /^@myne\/dialect\/(.*)$/, replacement: sib("../dialect/src/$1") },
      { find: "@myne/locales-en", replacement: sib("../locales/en/common.json") },
      // Shared react-i18next runtime (MYND-485) — mirror of vite.config.ts.
      { find: /^@myne\/i18n$/, replacement: sib("../src/i18n/index.ts") },
      { find: /^@myne\/i18n\/(.*)$/, replacement: sib("../src/i18n/$1") },
      // Shared decoration vocabulary for the synced `folder_icons` / `item_colors`
      // prefs maps (MYND-516) — mirror of vite.config.ts, which carries the
      // rationale for sharing these rather than copying them.
      // The reminder scheduling decision core (MYND-619 task 5) — mirror of
      // vite.config.ts, which carries the rationale for sharing rather than
      // copying it.
      { find: /^@myne\/reminder-schedule$/, replacement: sib("../src/lib/reminderSchedule.ts") },
      // The shared enrol gate (myne-md/myne-mobile#38) — mirror of
      // vite.config.ts, which carries the rationale for sharing it.
      { find: /^@myne\/enroll-gate$/, replacement: sib("../src/lib/enroll-gate.ts") },
      // The custom-theme syntax derivation (MYND-598) — mirror of
      // vite.config.ts, which carries the rationale for sharing it.
      { find: /^@myne\/syntax-theme$/, replacement: sib("../src/lib/syntaxTheme.ts") },
      // The task index's wire decoder (myne-md/myne-mobile#36) — mirror of
      // vite.config.ts, which carries the rationale for sharing it.
      { find: /^@myne\/task-wire$/, replacement: sib("../src/notes/taskWire.ts") },
      { find: /^@myne\/task-panel$/, replacement: sib("../src/notes/components/TaskListPanel.tsx") },
      { find: /^@myne\/task-filters$/, replacement: sib("../src/notes/taskFilters.ts") },
      { find: /^@myne\/task-scope$/, replacement: sib("../src/notes/taskScope.ts") },
      { find: /^@myne\/task-write$/, replacement: sib("../src/notes/taskWriteCore.ts") },
      { find: /^@myne\/note-completion$/, replacement: sib("../src/notes/completeNoteCore.ts") },
      { find: /^@myne\/decorations$/, replacement: sib("../src/notes/decorations.ts") },
      { find: /^@myne\/decorations\/folderIcons$/, replacement: sib("../src/notes/folderIcons.ts") },
    ],
  },
  test: {
    include: ["tests/**/*.test.ts", "tests/**/*.test.tsx"],
    environment: "node",
    globals: false,
  },
});
