// EditorHost — the injection seam for the platform-COUPLED operations only.
// Everything pure (parser, decorations, wikilink resolution, fuzzy match, date
// formatting, imperative modals, icons, attachment-ref helpers) lives in the
// package directly. What remains here is genuine IPC / platform surface: i18n,
// the vault tag index, spell, on-device AI, attachment export/rename + export
// destination-pick, prefs, open-URL. The consuming app installs it once at
// startup via `setEditorHost`; the engine's thin bridge modules (./i18n,
// ./host/notes/vaultIndices, ./host/lib/*) forward.
//
// NOT yet behind this seam (Phase A): attachment *insert*/catalog/picker/voice-
// record + convert-command still call Tauri `invoke`/`plugin-dialog`/`event`
// directly (see editor/package.json peerDependencies). Both clients are Tauri
// today; routing them through the host is deferred to Phase B.
//
// Optional members (`ai`, `spell`) may be omitted on a platform that doesn't back
// them — the engine then hides those affordances.

import type { EditorView } from "@codemirror/view";

/** A node of the Rust-built tag tree (mirror of notes/vaultIndices). */
export interface TagTreeNode {
  key: string;
  display: string;
  depth: number;
  directCount: number;
  subtreeCount: number;
}

/** A spell result for one word (mirror of lib/spell `SpellWord`). */
export interface SpellWord {
  word: string;
  misspelled: boolean;
  suggestions: string[];
}

/** Options for a transcription run (voice-to-text, SYNC-V5/V7). */
export interface TranscribeOptions {
  /** Called with each streamed per-segment partial transcript as it decodes
   *  (SYNC-V5). Omit to consume only the final string. */
  onSegment?: (segment: string) => void;
}

/** A running transcription (SYNC-V5). `done` resolves with the FULL transcript
 *  when transcription completes and rejects on failure — the rejection carries a
 *  `{ kind }`-tagged error where `kind === "not_ready"` signals AI-off / no
 *  transcription model side-loaded (the widget surfaces a "select a model" hint
 *  rather than a silent failure). `stop()` cancels the in-flight run (drives the
 *  shared backend cancel; also fired on widget teardown). */
export interface TranscribeHandle {
  readonly done: Promise<string>;
  stop: () => void;
}

/** The prefs fields the editor engine reads (a narrow projection the host maps
 *  its full PrefsView onto). */
export interface EditorPrefs {
  editor_content_width: string | null;
  editor_font_family: string | null;
  editor_line_spacing: string | null;
  editor_text_size: string | null;
  spell_enabled: boolean | null;
  spell_languages: string[];
}

export interface EditorHost {
  /** i18n lookup (react-i18next `t`, bound). */
  t: (key: string, opts?: Record<string, unknown>) => string;

  /** Vault tag index (IPC) + the one pure media-target predicate. */
  notes: {
    tagTree: () => Promise<TagTreeNode[]>;
    isMediaTarget: (target: string) => boolean;
  };

  /** Attachment IO (export/rename dialogs — IPC). */
  attachments: {
    attachmentExport: (id: string, dest: string, overwrite: boolean) => Promise<void>;
    attachmentRename: (id: string, name: string) => Promise<void>;
    /** Pick/derive the on-device destination for exporting an attachment's
     *  decrypted bytes: desktop opens a native Save dialog, mobile returns a
     *  Documents path (no picker). Returns the destination, or null on cancel. */
    pickExportDestination: (filename: string) => Promise<string | null>;
    /** OPTIONAL — MYND-268 Tier-1: decrypt an attachment's plaintext as TEXT for
     *  a read-only inline preview (txt/code/csv/md). RAM-only; the promise
     *  rejects (Locked / NotFound / Denied / Io) on failure. `truncated` flags a
     *  source larger than the preview cap. Render as inert text, never
     *  interpreted. Omit to fall back to the export-only file-card. */
    readText?: (id: string) => Promise<{ text: string; truncated: boolean }>;
    /** OPTIONAL — MYND-268 Tier-2: decrypt + parse a docx/xlsx attachment into a
     *  SAFE structured model (grid/blocks) for inline preview. Parsed in Rust —
     *  the model carries no raw bytes/HTML. RAM-only; rejects on failure. Omit to
     *  fall back to the file-card. */
    readStructured?: (
      id: string,
      kind: "xlsx" | "docx",
    ) => Promise<
      | { kind: "grid"; rows: string[][] }
      | { kind: "blocks"; blocks: { heading_level: number | null; text: string }[] }
    >;
  };

  /** Prefs read (editor typography + spell settings — IPC). */
  prefsRead: () => Promise<EditorPrefs>;

  /** Open an external URL in the OS browser (autolink click). */
  openExternal: (url: string) => void;

  /** OPTIONAL — on-device AI. Omit to hide ghost-text + AI slash commands. */
  ai?: {
    infer: (prompt: string) => Promise<string>;
    buildCompletionPrompt: (precedingText: string) => string;
    buildTitlePrompt: (noteBody: string) => string;
  };

  /** OPTIONAL — spell check + dictionary ops. Omit to disable spell. */
  spell?: {
    spellCheck: (words: string[], langs: string[]) => Promise<SpellWord[]>;
    addToPersonalDictionary: (word: string) => Promise<void>;
    ignoreWordInVault: (word: string) => Promise<void>;
  };

  /** OPTIONAL — record a voice note into `view`. When set, the `/record` slash
   *  command routes through this instead of the package-default desktop `cpal`
   *  recorder — mobile provides a WebView (`getUserMedia`) implementation. Omit
   *  on a platform with no recorder and `/record` falls back to the default. */
  voiceRecord?: (view: EditorView) => void;

  /** OPTIONAL — on-device speech-to-text (voice-to-text, SYNC-V7). Transcribe
   *  audio attachment `attachmentId` through the platform ASR engine. The shared
   *  audio widget calls ONLY this slot — never Tauri directly — so `@myne/editor`
   *  stays platform-agnostic; the desktop app bridges it to the `local-inference|
   *  transcribe` command (streaming `Channel<String>` + shared cancel). Mobile
   *  leaves it unset and the Transcribe affordance is omitted from the audio ⋮
   *  menu. `view` is threaded so a run can be tied to its editor (unused today).
   *  Returns a handle exposing the streaming segments + a stop + a final-string
   *  resolution (SYNC-V5). */
  transcribe?: (
    view: EditorView,
    attachmentId: string,
    opts?: TranscribeOptions,
  ) => TranscribeHandle;

  /** OPTIONAL — the load-bearing transcript-fallibility honesty note (SYNC-V8),
   *  rendered VERBATIM (never i18n'd) beneath the read-only transcript expander.
   *  Injected by the app so the shared widget renders app-owned load-bearing copy
   *  (`src/lib/load-bearing-copy.ts::AI_TRANSCRIPT_HONESTY_NOTE`) without
   *  depending on the desktop `src/` tree. Omit and the note is skipped. */
  transcriptHonestyNote?: string;

  /** Workspace reach for the vim `:` command line (vim-keyboard-mode, MYND-313).
   *  OPTIONAL: a platform that does not back these simply gets an ex command that
   *  does nothing rather than a crash — and the desktop is the only client that
   *  exposes vim today. Kept behind the seam (rather than a direct Tauri call)
   *  because this package is compiled by the mobile client too. */
  workspace?: {
    /** Persist any pending autosave immediately (`:w`). */
    flushPendingSaves: () => Promise<void>;
    /** Close the focused note tab (`:q`). */
    closeActiveTab: () => void;
  };
}

// ── Registry ─────────────────────────────────────────────────────────────────

let current: EditorHost | null = null;

/** Install the host. Call once at app startup, before any editor mounts. */
export function setEditorHost(host: EditorHost): void {
  current = host;
}

/** The installed host. Throws if the app forgot to call `setEditorHost`. */
export function getHost(): EditorHost {
  if (current === null) {
    throw new Error("@myne/editor: setEditorHost() was not called before the editor mounted.");
  }
  return current;
}
