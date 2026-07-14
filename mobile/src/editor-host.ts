// Mobile implementation of the shared editor's `EditorHost` seam (the analog of
// the desktop `src/editor-host.ts`). Installs the Tauri-backed IO the shared
// `@myne/editor` engine needs, before any editor mounts. Imported for its
// side-effect by `main.tsx`.
//
// Mobile reuses what already exists (attachment export/rename, prefs) and OMITS
// the surfaces mobile has no backend for yet (AI, spell, voice) — those slots
// are optional in the EditorHost contract, so leaving them off simply keeps the
// corresponding editor affordances inert. `t()` delegates to the shared
// react-i18next runtime (`@myne/i18n`, MYND-485); `isMediaTarget`, `tagTree`,
// and `openExternal` are built here since mobile has no direct equivalent.

import { setEditorHost, type EditorHost, type EditorPrefs } from "@myne/editor/host";
import i18n from "@myne/i18n";
import { documentDir, join } from "@tauri-apps/api/path";
import { attachmentExport, attachmentRename } from "./lib/attachments";
import { prefsRead } from "./lib/prefs";
import { currentEditorTagTree } from "./lib/editor-tag-bridge";
import { requestVoiceRecording } from "./lib/voice-record-bridge";

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
  // Delegate to the shared react-i18next runtime (MYND-485) — replaces the
  // former English-only hand-rolled catalog lookup, so the editor's menu/toast
  // labels honor the active UI language + Weblate translations. i18next handles
  // nested keys, `{{var}}` interpolation, and `_one`/`_other` count plurals.
  t: (key, opts) => i18n.t(key, opts ?? {}),
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
