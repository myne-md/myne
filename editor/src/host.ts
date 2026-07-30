// EditorHost — the injection seam for the platform-COUPLED operations only.
// Everything pure (parser, decorations, wikilink resolution, fuzzy match, date
// formatting, imperative modals, icons, attachment-ref helpers) lives in the
// package directly. What remains here is genuine IPC / platform surface: i18n,
// the vault tag index, spell, on-device AI, attachment export/rename + export
// destination-pick, prefs, open-URL. The consuming app installs it once at
// startup via `setEditorHost`; the engine's thin bridge modules (./i18n,
// ./host/notes/vaultIndices, ./host/lib/*) forward.
//
// Phase B closed with phase3-web-client task 76: attachment insert / catalog /
// picker / voice-record / convert-command and the attachment-ref URL builder all
// route through this seam now, and `editor/package.json` declares no
// `@tauri-apps/*` peer at all. `scripts/check-platform-seam.mjs` holds that:
// nothing under `editor/`, `dialect/` or `copy/` may import `@tauri-apps/*`,
// because a module-scope import lands in the bundle whether or not the call ever
// fires — and one of the clients compiling this package is not Tauri.
//
// Optional members (`ai`, `spell`, `voice`, `pickFiles`, `warmRefs`, …) may be
// omitted on a platform that doesn't back them — the engine then hides those
// affordances rather than showing one that fails on click.

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

/** One file the user chose through the host's picker.
 *
 * **Opaque on purpose** (phase3-web-client task 76). Every picking flow used to
 * hand back an absolute path string, which a browser picker cannot produce — it
 * produces a `File`. A path-shaped seam therefore compiles on web and fails at
 * runtime, which is the failure mode this whole seam exists to convert into a
 * modelled one.
 *
 * `handle` is deliberately `unknown`: only the host that MINTED the value ever
 * interprets it. Desktop puts the absolute path there and unwraps it back into
 * the existing `{ kind: "path" }` import source, so the Rust side keeps doing
 * the read inside its root-confined seam and the bytes never cross IPC. Web puts
 * the `File` there and streams it into the Worker. `@myne/editor` reads only the
 * three descriptive fields and passes the handle straight back.
 */
export interface PickedFile {
  /** Display filename, no directory component. */
  readonly name: string;
  /** Size in bytes when the host knows it cheaply; `null` when it does not. */
  readonly size: number | null;
  /** The picker's claimed MIME, or `null`. **A hint only** — the content type is
   *  always re-sniffed from the decrypted bytes host-side, never trusted from
   *  here (`protocol.md` §9.9). */
  readonly mimeHint: string | null;
  /** Host-private. Never inspected by this package. */
  readonly handle: unknown;
}

/** Options for {@link EditorHost.attachments.pickFiles}. */
export interface PickFilesOptions {
  /** Allow selecting more than one file. Default `false`. */
  readonly multiple?: boolean;
  /** Lowercase extensions to bias the dialog toward, e.g. `["png", "pdf"]`.
   *  A hint: a host with no filter concept ignores it, and nothing downstream
   *  depends on it (the import path accepts any bytes since MYND-173). */
  readonly extensions?: readonly string[];
  /** Already-localized label for the extension filter group. */
  readonly filterLabel?: string;
}

/** The stored attachment `attachment_import` returns. */
export interface ImportedAttachment {
  readonly id: string;
  readonly content_type: string;
  readonly filename: string;
  readonly size: number;
  readonly created_at: number;
  readonly deduplicated: boolean;
  /** Byte length before ingest-time compression (`ingest-image-compression`),
   *  present only when a fresh import actually got smaller. Optional (rather
   *  than `| null`) so the many existing test fixtures built before this
   *  field existed stay valid without an edit. */
  readonly original_size?: number | null;
  /** `true` only when `original_size` is set and the re-encode also changed
   *  the container (e.g. PNG → WebP). */
  readonly container_changed?: boolean;
}

/** The `source` argument to an attachment import.
 *
 * `bytes` is the paste / drop path. `picked` carries a {@link PickedFile} the
 * host itself produced — it replaces the old `{ kind: "path" }` variant at the
 * seam, and the desktop host maps it straight back onto that IPC payload, so
 * `plugin:attachments|attachment_import`'s wire shape is unchanged.
 */
export type ImportSource =
  | { readonly kind: "bytes"; readonly bytes: number[]; readonly filename: string | null }
  | { readonly kind: "picked"; readonly file: PickedFile };

/** One catalog row, as the editor's render path needs it. */
export interface CatalogRow {
  readonly id: string;
  readonly contentType: string;
  readonly filename: string;
  readonly size: number;
}

/** The host-provided voice recorder (MYND-259). Optional as a whole: a platform
 *  with no capture path omits it and `/record` renders no affordance. */
export interface VoiceRecorder {
  /** Begin capture. Rejects if the platform refuses (no device, denied). */
  start: () => Promise<void>;
  /** Stop and store the clip. Resolves to the stored attachment, or `null` when
   *  the platform delivered it through {@link onClip} instead. */
  stop: () => Promise<ImportedAttachment | null>;
  /** Abandon the capture, storing nothing. */
  cancel: () => Promise<void>;
  /** Subscribe to input-level updates (0..1) for the meter. Resolves to an
   *  unsubscribe fn. */
  onLevel: (cb: (level: number) => void) => Promise<() => void>;
  /** Subscribe to an out-of-band stored clip. Resolves to an unsubscribe fn. */
  onClip: (cb: (clip: ImportedAttachment) => void) => Promise<() => void>;
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
    /** Import one source and return the stored attachment. Rejects with the
     *  backend's own `AttachmentImportError` so the caller's skip-reason mapping
     *  keeps working (phase3-web-client task 76). */
    import: (source: ImportSource) => Promise<ImportedAttachment>;
    /** The full attachment catalog, already shaped. A host that cannot read it
     *  right now resolves to an empty list rather than rejecting — § 9.10.4's
     *  fall-back-to-empty, which the render path treats as "tombstones". */
    catalogList: () => Promise<CatalogRow[]>;
    /** Open the host's file picker. `null` = the user cancelled.
     *
     *  Returns opaque {@link PickedFile} handles, never paths — see that type
     *  for why. A host with no picker at all omits this member, and the callers
     *  render no picker affordance. */
    pickFiles?: (opts?: PickFilesOptions) => Promise<PickedFile[] | null>;
    /** OPTIONAL — turn a source string a NOTE names (`![](…/pic.png)`) into a
     *  {@link PickedFile}, or `null` when this host cannot reach it.
     *
     *  The import-and-convert command tries the literal reference first and only
     *  falls back to the picker when that fails. That auto-resolve step is
     *  inherently host-specific: a desktop can open the path the document names,
     *  a browser cannot open anything it was not handed by a user gesture. A
     *  host that returns `null` (or omits this) makes every ref go straight to
     *  the picker — the correct web behaviour, and a modelled one rather than a
     *  read that fails. Returning a handle does NOT promise the file exists; the
     *  import is still the resolution test, so no extra `fs` capability is
     *  needed. */
    resolveLiteralSource?: (source: string) => PickedFile | null;
    /** OPTIONAL — turn a `File` from an HTML5 drop or clipboard paste into a
     *  {@link PickedFile}, or `null` when this host has no use for one.
     *
     *  Present only where the host can move the file WITHOUT the editor reading
     *  it (phase3-web-client task 67): a browser hands the `File` handle to its
     *  Worker, which reads the content off-thread, so a 64 MiB drop never
     *  becomes a 64-million-element array on the page. A host that returns
     *  `null` (or omits this) gets the byte path below, which is what desktop
     *  has always done and what its Rust side expects.
     *
     *  `nameOverride` carries the auto-generated name for a pasted screenshot,
     *  whose `File.name` is empty — the naming convention belongs to the editor,
     *  so the host only relays it. */
    pickedFromDropped?: (file: File, nameOverride?: string) => PickedFile | null;
    /** The URL a display surface uses as `<img src>` / media src for an
     *  attachment's decrypted bytes.
     *
     *  Desktop returns the platform form of the `attachment://` custom protocol
     *  (the Rust handler decrypts in memory and serves an allowlisted,
     *  re-sniffed type). A browser has no custom protocol and returns an object
     *  URL minted in the Worker instead (task 44) — which is why this is a host
     *  slot rather than a shared string builder. */
    resolveRef: (id: string) => string;
    /** OPTIONAL — make [`resolveRef`] able to answer for these ids.
     *
     * **Exists because `resolveRef` is synchronous and one client's answer is
     * not** (phase3-web-client task 44). Desktop derives `attachment://<id>`
     * from the id with no IO, so it omits this and nothing changes. A browser
     * has to decrypt the bytes in its Worker and mint an object URL first, which
     * cannot happen inside a render — so the render is split: warm the ids a
     * document references, then resolve them synchronously while painting.
     *
     * Idempotent, and cheap for an already-warm id. Resolves when every id it
     * can answer for is answerable; an id it cannot (deleted, undecryptable)
     * simply stays unresolved rather than rejecting, because one broken
     * attachment must not take a note's other images down with it. */
    warmRefs?: (ids: readonly string[]) => Promise<void>;
    attachmentExport: (id: string, dest: string, overwrite: boolean) => Promise<void>;
    attachmentRename: (id: string, name: string) => Promise<void>;
    /** OPTIONAL — pick/derive the on-device destination for exporting an
     *  attachment's decrypted bytes: desktop opens a native Save dialog, mobile
     *  returns a Documents path (no picker). Returns the destination, or null on
     *  cancel.
     *
     *  **Optional because a browser has no analogue** (phase3-web-client task
     *  26): no web API grants a page an arbitrary write path, and the download
     *  flow that replaces it (task 48) is a differently-shaped affordance, not
     *  this one. A host that omits it makes the Export action **absent** — the
     *  menu item is not rendered — rather than present-and-failing, per
     *  `decisions.md` 2026-07-26's absent-not-disabled rule. Use
     *  [`canExportAttachment`](./host/lib/attachments) to ask. */
    pickExportDestination?: (filename: string) => Promise<string | null>;
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

  /** OPTIONAL — the capture backend the package-default `/record` recorder
   *  drives (phase3-web-client task 76). Distinct from [`voiceRecord`], which
   *  REPLACES the whole recorder UI; this fills in only the platform calls the
   *  shared UI makes. Omit both and `/record` has nothing to run. */
  voice?: VoiceRecorder;

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
