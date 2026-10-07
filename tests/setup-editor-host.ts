// Install a test EditorHost so the shared @myne/editor engine's host-injected
// bridges (i18n, tag index, prefs, attachments) resolve under vitest — the test
// analog of the desktop `src/editor-host.ts` wiring done in `main.tsx`. Real
// i18n; the pure `isMediaTarget` is inlined (see below); IPC surfaces are inert
// stubs (editor unit tests don't drive the vault backend).
//
// This setup file runs for EVERY test, so it MUST NOT import anything that
// pulls `@tauri-apps/api/core` (or otherwise touches Tauri/`window`): doing so
// evaluates the real `invoke` at setup time, BEFORE any test's `vi.mock` runs,
// pre-caching it unmocked and crashing every node-env test that mocks Tauri
// (`window is not defined`). Two consequences of that rule, both deliberate:
import i18n from "../src/i18n";
// (1) Import the host seam directly, NOT the `@myne/editor` barrel — the barrel
//     re-exports CMEditor + myneExtensions, which would eagerly evaluate the
//     whole engine (→ voiceRecord → `@tauri-apps/api/core`).
import { setEditorHost } from "@myne/editor/host";

// (2) Inline `isMediaTarget` instead of importing it from
//     `src/notes/vaultIndices` — that module also imports `@tauri-apps/api/core`,
//     so importing the pure helper would drag Tauri in. Faithful copy of the
//     desktop list (src/notes/vaultIndices.ts::MEDIA_EXTENSIONS).
const MEDIA_EXTENSIONS = [
  ".png", ".jpg", ".jpeg", ".gif", ".webp", ".svg", ".bmp", ".ico",
  ".pdf", ".mp3", ".m4a", ".wav", ".ogg", ".mp4", ".webm", ".mov",
];
const isMediaTarget = (target: string): boolean => {
  const lastSegment = target.split("/").pop() ?? target;
  const lower = lastSegment.toLowerCase();
  return MEDIA_EXTENSIONS.some((ext) => lower.endsWith(ext));
};

setEditorHost({
  t: (key, opts) => i18n.t(key, opts ?? {}),
  // Meeting sessions (myne-md/myne#789). A no-op rather than an absent member:
  // `src/AGENTS.md` records that a test asserting an optional seam member is
  // ABSENT is vacuous unless the shared stub provides it, and the `/meeting`
  // trigger's positive path needs the member to exist.
  meetingSession: () => {},
  notes: { tagTree: async () => [], isMediaTarget },
  // The clipboard write the code-block copy button goes through
  // (myne-md/myne#390). Delegates to the WebView API so a test that wants to
  // observe a copy keeps doing what it already did: patch `navigator.clipboard`
  // and read the spy. The seam moved; what a test has to mock did not.
  clipboardWrite: (value) => navigator.clipboard.writeText(value),
  attachments: {
    attachmentExport: async () => {},
    attachmentRename: async () => {},
    pickExportDestination: async () => null,
    // phase3-web-client task 76 moved these off direct `@tauri-apps/*` imports
    // inside the package, so they are part of the contract now and a host must
    // answer them. Inert defaults; the tests that exercise a flow install their
    // own host over this one.
    import: async () => {
      throw new Error("test host: attachments.import not installed");
    },
    catalogList: async () => [],
    // The default `attachment://<id>` literal — what the package itself used to
    // fall back to outside Tauri, kept identical so every render-path test that
    // merely needs A url is unaffected by the move.
    resolveRef: (id: string) => `attachment://${id}`,
  },
  prefsRead: async () => ({
    editor_content_width: null,
    editor_font_family: null,
    editor_line_spacing: null,
    editor_text_size: null,
    spell_enabled: null,
    spell_languages: [],
  }),
  openExternal: () => {},
  // The real desktop and web hosts both install this (it is not capability
  // gated), so the shared stub does too. Without it every cover control is
  // silently skipped and the tests that assert "absent when the host has no
  // seam" pass for the wrong reason.
  cover: { openPicker: () => {}, remove: () => {} },
});
