// Mobile implementation of the shared editor's `EditorHost` seam (the analog of
// the desktop `src/editor-host.ts`). Installs the Tauri-backed IO the shared
// `@myne/editor` engine needs, before any editor mounts. Imported for its
// side-effect by `main.tsx`.
//
// Mobile reuses what already exists (attachment export/rename, prefs) and OMITS
// the surfaces mobile has no backend for yet (AI, spell, voice) — those slots
// are optional in the EditorHost contract, so leaving them off simply keeps the
// corresponding editor affordances inert. `t()`, `isMediaTarget`, `tagTree`, and
// `openExternal` are built here since mobile has no direct equivalent.

import { setEditorHost, type EditorHost, type EditorPrefs } from "@myne/editor/host";
import enCatalog from "@myne/locales-en";
import { documentDir, join } from "@tauri-apps/api/path";
import { attachmentExport, attachmentRename } from "./lib/attachments";
import { prefsRead } from "./lib/prefs";
import { currentEditorTagTree } from "./lib/editor-tag-bridge";
import { requestVoiceRecording } from "./lib/voice-record-bridge";

// ── i18n: a minimal react-i18next-compatible lookup over the SHARED English
//    catalog (the same strings the desktop ships). Handles nested keys,
//    `{{var}}` interpolation, and `_one`/`_other` count plurals — enough for the
//    editor's menu/toast labels. Falls back to the raw key if unmapped.
type Dict = { [k: string]: string | Dict };
const CATALOG = enCatalog as unknown as Dict;

function lookupKey(key: string): string | undefined {
  let node: string | Dict | undefined = CATALOG;
  for (const seg of key.split(".")) {
    if (typeof node !== "object" || node === null) return undefined;
    node = node[seg];
  }
  return typeof node === "string" ? node : undefined;
}

function translate(key: string, opts?: Record<string, unknown>): string {
  const count = typeof opts?.count === "number" ? opts.count : undefined;
  let raw: string | undefined;
  if (count !== undefined) raw = lookupKey(`${key}_${count === 1 ? "one" : "other"}`);
  raw ??= lookupKey(key);
  if (raw === undefined) return key;
  return raw.replace(/\{\{\s*(\w+)\s*\}\}/g, (_m, name: string) => {
    const v = opts?.[name];
    return v === undefined || v === null ? "" : String(v);
  });
}

// ── isMediaTarget: pure extension check (faithful copy of the desktop
//    src/notes/vaultIndices.ts::MEDIA_EXTENSIONS list).
const MEDIA_EXTENSIONS = [
  ".png", ".jpg", ".jpeg", ".gif", ".webp", ".svg", ".bmp", ".ico",
  ".pdf", ".mp3", ".m4a", ".wav", ".ogg", ".mp4", ".webm", ".mov",
];
function isMediaTarget(target: string): boolean {
  const lastSegment = target.split("/").pop() ?? target;
  const lower = lastSegment.toLowerCase();
  return MEDIA_EXTENSIONS.some((ext) => lower.endsWith(ext));
}

const host: EditorHost = {
  t: (key, opts) => translate(key, opts as Record<string, unknown> | undefined),
  notes: {
    // The editor flow publishes its live flat tag index (built from decrypted
    // note bodies) into the bridge; the #tag autocomplete reads the latest here.
    tagTree: async () => currentEditorTagTree(),
    isMediaTarget,
  },
  attachments: {
    attachmentExport,
    attachmentRename,
    // Mobile has no Save-As dialog plugin: export the decrypted bytes into the
    // app's Documents folder (reachable from the iOS Files app). Overwrites by
    // name (exportAttachment is called with overwrite=true). Sanitize to a bare
    // basename first — a crafted attachment name containing `/`, `\`, or a
    // leading `..` must not let join() escape the Documents directory.
    pickExportDestination: async (filename) => {
      const safe = filename.replace(/[/\\]/g, "_").replace(/^\.+/, "").trim() || "attachment";
      return join(await documentDir(), safe);
    },
  },
  // The shared `/record` slash command records into the CMEditor view. Mobile
  // has no native `cpal` recorder (the `voice_record_*` commands aren't
  // registered), so the WebView records via `getUserMedia`: signal the React
  // EditorFlow to open the RecordingSheet (which imports the WAV as an
  // attachment). `view` is unused — the sheet appends the embed to the note body,
  // matching how the paperclip attach path inserts on mobile.
  voiceRecord: () => requestVoiceRecording(),
  // PrefsView ⊇ EditorPrefs (identical field types), so this is structurally sound.
  prefsRead: async (): Promise<EditorPrefs> => prefsRead(),
  openExternal: (url) => {
    // No opener plugin wired on mobile yet; best-effort WebView open.
    try {
      window.open(url, "_blank");
    } catch {
      /* no-op */
    }
  },
};

setEditorHost(host);
