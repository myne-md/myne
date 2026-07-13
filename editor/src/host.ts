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
