import { fileURLToPath, URL } from "node:url";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import packageJson from "./package.json";

// @ts-expect-error process is a nodejs global
const host = process.env.TAURI_DEV_HOST;

// Resolve a path relative to THIS config file (mobile/), so the sibling
// shared packages under the parent `myne/` repo resolve regardless of cwd.
const sib = (p: string) => fileURLToPath(new URL(p, import.meta.url));

// Tauri-aware Vite config - mirrors the main `myne` desktop repo.
// https://v2.tauri.app/start/frontend/vite/
export default defineConfig(async () => ({
  plugins: [react()],

  // The shared editor/dialect engines are consumed AS SOURCE from the sibling
  // `myne/{editor,dialect}` packages (the WebView analog of the Rust
  // `path`-dep on `../../core`; decisions.md 2026-07-05). Alias the `@myne/*`
  // specifiers straight to that source so Vite compiles them into the mobile
  // bundle - no publish/link step, exactly like the desktop repo does in-tree.
  resolve: {
    alias: [
      { find: /^@myne\/editor\/CMEditor$/, replacement: sib("../editor/src/CMEditor.tsx") },
      { find: /^@myne\/editor$/, replacement: sib("../editor/src/index.ts") },
      { find: /^@myne\/editor\/(.*)$/, replacement: sib("../editor/src/$1") },
      { find: /^@myne\/dialect$/, replacement: sib("../dialect/src/index.ts") },
      { find: /^@myne\/dialect\/(.*)$/, replacement: sib("../dialect/src/$1") },
      // The shared sync-staleness RULE (myne#583). Aliased rather than copied
      // for the reason the load-bearing copy is shared: the threshold that
      // decides when a failed sync is old enough to interrupt the user must be
      // one number, or the two clients disagree about when their own vault is
      // at risk. Like `@myne/i18n` below, this reaches into the desktop `src/`
      // tree rather than a top-level workspace package.
      { find: "@myne/sync-staleness", replacement: sib("../src/lib/sync-staleness.ts") },
      // The shared RECOVERY-KIT FILE FORMAT (myne-md/myne#468). Aliased for
      // exactly the reason above: the kit is a plain-text document a user saves
      // on one client and reads back into the recovery flow on ANOTHER, so its
      // shape has to be one function or the two clients write two different
      // documents under one name. A hand-copy drifts silently — nothing compares
      // a phone's kit against a desktop's, and the failure surfaces as "my
      // recovery file does not work", months later, with the file in hand.
      { find: "@myne/recovery-kit", replacement: sib("../src/lib/recovery-kit.ts") },
      // The shared English catalog (repo-root `locales/en`) - now consumed only
      // by `src/lib/welcomeNote.ts` for its seed-time welcome-note copy. (The
      // editor host resolved its labels through this too until MYND-485 moved it
      // onto the full `@myne/i18n` runtime below.)
      { find: "@myne/locales-en", replacement: sib("../locales/en/common.json") },
      // The shared react-i18next RUNTIME (MYND-485). NOTE - unlike @myne/editor /
      // dialect / copy (extracted top-level workspace packages), this aliases the
      // desktop APP source `../src/i18n/` directly, so mobile source-depends on
      // desktop internals with no package contract. It works because that runtime
      // is Tauri-free + portable (its `import.meta.glob("../../locales/*")` is
      // file-relative → loads all 24 shared catalogs whichever client imports it).
      // FOLLOW-UP: extract `src/i18n/` into a real `@myne/i18n` package (like
      // `copy/`) and make desktop's `src/i18n` a re-export shim.
      { find: /^@myne\/i18n$/, replacement: sib("../src/i18n/index.ts") },
      { find: /^@myne\/i18n\/(.*)$/, replacement: sib("../src/i18n/$1") },
      // The shared DECORATION VOCABULARY (MYND-516) - the color-label slot list
      // and the folder-icon glyph table. Like @myne/i18n above, this aliases
      // desktop APP source (`../src/notes/`) with no package contract.
      // WHY it must be shared rather than copied: `folder_icons` / `item_colors`
      // are SYNCED prefs maps, so the VALUE crosses the client boundary. A
      // hand-copy lets the vocabulary drift silently - desktop adds a 17th glyph,
      // a user assigns it, the name syncs, and mobile's FolderGlyph resolves
      // `undefined` and falls back to the default folder. No type error, no test,
      // no build failure catches that; one alias does.
      // NOTE - deliberately EXACT specifiers, not the `/(.*)$` subpath form the
      // i18n alias uses: `../src/notes/` also holds Tauri-coupled modules
      // (readNote, vaultExport, …), and a wildcard would let those resolve into
      // the mobile bundle. Only the two PURE DATA modules are shared; the
      // presentational wrappers (FolderGlyph, ColorDot) stay mobile-local.
      { find: /^@myne\/decorations$/, replacement: sib("../src/notes/decorations.ts") },
      { find: /^@myne\/decorations\/folderIcons$/, replacement: sib("../src/notes/folderIcons.ts") },
      // The reminder scheduling DECISION CORE (MYND-619 task 5). Shared for the
      // same reason as the decoration vocabulary, and with more at stake: what
      // it decides is which reminders the operating system is currently holding,
      // and a second copy of "compute the target set, diff it, cancel before you
      // schedule" would be two answers to a question the epic insists has one.
      // Mobile adds a bound on top (`src/lib/reminderPass.ts`) rather than
      // reimplementing any of it.
      // Safe to alias despite living in Tauri-coupled `../src/lib/`: this module's
      // ONLY import is `import type { VaultTask }`, which erases at compile time,
      // so nothing from the desktop app tree reaches the mobile bundle. It costs
      // ~0.7s of typecheck. Exact specifier, no wildcard - `../src/lib/` is full
      // of modules that would drag `@tauri-apps/*` in.
      { find: /^@myne\/reminder-schedule$/, replacement: sib("../src/lib/reminderSchedule.ts") },
      // The ENROL GATE (myne-md/myne-mobile#38) - whether "Add this device" is
      // a real action for this device, or dead UI that mints a second device
      // registration. Desktop fixed it once (MYND-635) and this client, which
      // keeps its own tree, went on offering the row to an already-syncing
      // phone: the exact failure mode a hand-ported condition has. It reads a
      // `sync_status` state tag, which is `myne-core`'s answer and therefore
      // identical on both clients by construction.
      // Safe to alias out of Tauri-coupled `../src/lib/`: the module has NO
      // imports at all.
      { find: /^@myne\/enroll-gate$/, replacement: sib("../src/lib/enroll-gate.ts") },
      // The LEGAL DOCUMENT URLs (myne-ops#15) - which of the two published
      // editions of each text a client links to, keyed on interface language.
      // Shared rather than copied because a second copy is how one client ends
      // up linking at a slug the website no longer serves, silently, months
      // later: the URLs live in another repo entirely and nothing here would
      // notice them moving.
      // Safe to alias out of Tauri-coupled `../src/lib/`: the module has NO
      // imports at all - it is a slug table and one pure function.
      { find: /^@myne\/legal-urls$/, replacement: sib("../src/lib/legal-urls.ts") },
      // The custom-theme SYNTAX DERIVATION (MYND-598). Shared for the same
      // reason as the reminder core: it encodes a readability rule both clients
      // must answer identically - which of the 12 `--syntax-*` roles a custom
      // palette leaves undefined get aliased to the built-in dark ramp. Desktop
      // has already had to fix this twice (MYND-356, then MYND-527 when the
      // first fix's all-or-nothing gate missed partial token sets); a hand-copy
      // is how it drifts a third time, silently, into unreadable code blocks.
      // Safe to alias out of Tauri-coupled `../src/lib/`: the module has NO
      // imports at all - pure functions over a `Record<string, string>`, no DOM,
      // no host calls. Exact specifier, no wildcard (same reasoning as above).
      { find: /^@myne\/syntax-theme$/, replacement: sib("../src/lib/syntaxTheme.ts") },
      // The measure-token CLAMP (deep-customization, myne#394). Shared for the
      // same reason as the syntax derivation, and for a stronger one: the clamp
      // is a protective envelope, so two clients disagreeing about it means one
      // of them paints a theme value the other refused. Aliasable out of
      // Tauri-coupled `../src/lib/` because the module's only environmental
      // touch is `getComputedStyle` on an element the caller passes in.
      { find: /^@myne\/theme-measure$/, replacement: sib("../src/lib/themeMeasure.ts") },
      // The CLIPBOARD COPY CONTRACT (myne-md/myne#390 + myne-md/myne#455). Shared
      // because "what does a Copy tell the user" is not a per-client preference:
      // eleven call sites across three trees each answered it alone and produced
      // four patterns, two of which said nothing on either outcome. On the
      // recovery-phrase step that means a failed copy is indistinguishable from a
      // successful one, on the one screen where the phrase is shown once.
      // Aliasable out of Tauri-coupled `../src/lib/` for the strongest version of
      // the reason the siblings above give: this module has NO imports at all,
      // not even a type-only one. Everything environmental, the write, the
      // clear, the error sink, is injected, which is also what lets `editor/`
      // use it under its total ban on `@tauri-apps/*`. Exact specifier, no
      // wildcard (same reasoning as above).
      { find: /^@myne\/clipboard$/, replacement: sib("../src/lib/clipboard.ts") },
      // The shared ORNAMENT LAYER (myne#394) - the stylesheet a theme's ornament
      // selections resolve against, plus the role helper components declare
      // through. Wildcard rather than exact, because the CSS is a second entry
      // point (`@myne/ornaments/ornaments.css`) and a client imports it from its
      // own root the way it imports its token sheet.
      { find: /^@myne\/ornaments$/, replacement: sib("../ornaments/src/index.ts") },
      { find: /^@myne\/ornaments\/(.*)$/, replacement: sib("../ornaments/src/$1") },
      // The task index's WIRE DECODER (myne-md/myne-mobile#36). Shared because
      // the null-vs-absent conversion is not a local preference: it is a
      // statement about how the Rust `TaskRecord` serializes, which it cannot
      // stop doing (the same struct is the on-disk `MYI1` payload, so a
      // `skip_serializing_if` would be a format change). A hand-copy drifts the
      // day a sixth `Option<String>` field is added, and the failure is a null
      // reaching `.slice`/`.split` on a surface, not a type error.
      // Safe to alias out of `../src/notes/`, which is full of Tauri-coupled
      // modules: this one's ONLY import is `import type`, so after erasure it
      // has no imports at all. Exact specifier, no wildcard (same reasoning as
      // above).
      { find: /^@myne\/task-wire$/, replacement: sib("../src/notes/taskWire.ts") },
      // The graph's overlay layer (myne-md/myne#727): the ONE implementation of
      // "tags become nodes, the colour rules paint them", called by the desktop
      // pane and by this client's `WikiGraph` so the two draw the same picture
      // of the same vault by construction. Both modules are pure (their only
      // `../lib/prefs` import is a TYPE import, erased at build), which is what
      // makes them safe to alias out of the Tauri-coupled `../src/notes/`.
      { find: /^@myne\/graph-overlay$/, replacement: sib("../src/notes/graphOverlay.ts") },
      { find: /^@myne\/graph-color-groups$/, replacement: sib("../src/notes/graphColorGroups.ts") },
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
      // comment is the reason: `docs/decisions/ai/0515` records this sentence as
      // the compensating control for the remote arm having no volume bound, and
      // "a control that is worded in two places is a control that is worded
      // differently in two places". Its only imports are React and i18next.
      { find: /^@myne\/run-cost-line$/, replacement: sib("../src/notes/agent/components/RunCostLine.tsx") },
      // The run indicator, shared for the reason the cost line is: it is a
      // NAMED motion-canon exemption (`docs/decisions/ai/0621`), and every one
      // of the conditions that exemption rests on — bounded by the run, paused
      // when hidden or off-screen, one static frame under reduced motion,
      // budgeted, `aria-hidden` — is a property of the implementation rather
      // than of the design. A second copy on the phone would be a second place
      // for one of those five to go missing, on a surface where nobody would
      // look. Its imports are React and the shared agent store, both of which
      // mobile already consumes.
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
    ],
    // The aliased editor source lives OUTSIDE this repo (../editor/src), so its
    // bare-specifier imports could otherwise resolve to the parent repo's
    // node_modules - a second physical copy that silently breaks CM6's
    // cross-module `instanceof`/facet invariants. Dedupe every engine dep so
    // Vite always resolves them to mobile's own single copy.
    dedupe: [
      "@codemirror/state",
      "@codemirror/view",
      "@codemirror/language",
      "@codemirror/commands",
      "@codemirror/autocomplete",
      "@codemirror/search",
      "@codemirror/lang-css",
      "@codemirror/lang-html",
      "@codemirror/lang-javascript",
      "@codemirror/lang-json",
      "@codemirror/lang-markdown",
      "@codemirror/lang-python",
      "@codemirror/lang-rust",
      "@codemirror/lang-yaml",
      "@codemirror/legacy-modes",
      "@lezer/common",
      "@lezer/highlight",
      "@lezer/markdown",
      "katex",
      "mermaid",
      // Excalidraw canvas (drawing notes, MYND-515) - the aliased @myne/editor
      // source lives outside the repo, so its bare `@excalidraw/excalidraw`
      // import otherwise resolves to editor/node_modules' copy; dedupe to
      // mobile's single copy (same class as the CodeMirror engine deps above).
      "@excalidraw/excalidraw",
      "dompurify",
      "js-yaml",
      "react",
      "react-dom",
      // i18n singletons: the aliased desktop runtime and mobile components must
      // share ONE react-i18next context instance, so dedupe to mobile's copy.
      "i18next",
      "react-i18next",
    ],
  },

  // Compile-time version injection (Settings → About reads __APP_VERSION__).
  define: {
    __APP_VERSION__: JSON.stringify(packageJson.version),
  },

  // Vite options tailored for Tauri development.
  //
  // 1. prevent Vite from obscuring rust errors
  clearScreen: false,
  // 2. tauri expects a fixed port, fail if that port is not available.
  //
  // One port per client, and they must not collide now that all three live in
  // one repo: desktop 1420 (hard-pinned, root vite.config.ts), web 1421, mobile
  // 1422 (HMR 1423). While mobile was a separate checkout it also claimed 1420,
  // which was survivable only because nobody ran both at once - and it was not
  // actually survivable: `strictPort` made a running desktop server fail the
  // mobile start, and the flow-logic Playwright config's `reuseExistingServer`
  // did something worse, silently attaching the mobile specs to the DESKTOP app.
  server: {
    port: 1422,
    strictPort: true,
    host: host || false,
    hmr: host
      ? {
          protocol: "ws",
          host,
          port: 1423,
        }
      : undefined,
    watch: {
      // 3. tell Vite to ignore watching `src-tauri`
      ignored: ["**/src-tauri/**"],
    },
    // 4. the shared @myne/{editor,dialect} source + en catalog live in the parent
    //    `myne/` repo (one level up), so let the dev server serve from there.
    fs: {
      allow: [sib("."), sib("..")],
    },
  },
}));
