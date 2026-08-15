// Mobile implementation of the shared editor's `EditorHost` seam (the analog of
// the desktop `src/editor-host.ts`). Installs the Tauri-backed IO the shared
// `@myne/editor` engine needs, before any editor mounts. Imported for its
// side-effect by `main.tsx`.
//
// Mobile reuses what already exists (attachment export/rename, prefs) and OMITS
// the surfaces mobile has no backend for yet (AI, spell, voice) — those slots
// are optional in the EditorHost contract, so leaving them off simply keeps the
// corresponding editor affordances inert. `t()` delegates to the shared
// react-i18next runtime (`@myne/i18n`, MYND-485); `tagTree` and `openExternal`
// are built here since mobile has no direct equivalent. `isMediaTarget` is the
// SHARED predicate (myne-md/myne#199) — it used to be a hand-copied extension
// list here, which is the shape that lets desktop add an extension and this
// client silently keep treating that embed as a note link.

import { setEditorHost, type EditorHost, type EditorPrefs } from "@myne/editor/host";
import { isMediaTarget } from "@myne/editor/host/notes/graphModel";
import i18n from "@myne/i18n";
import { openUrl } from "./lib/open-url";
import { documentDir, join } from "@tauri-apps/api/path";
import {
  attachmentExport,
  attachmentImport,
  attachmentRename,
  catalogList,
} from "./lib/attachments";
import { attachmentSrc } from "./lib/attachmentRef";
import { prefsRead } from "./lib/prefs";
import { writeText as clipboardWriteText } from "./lib/clipboard";
import { currentEditorTagTree } from "./lib/editor-tag-bridge";
import { requestVoiceRecording } from "./lib/voice-record-bridge";

const host: EditorHost = {
  // Delegate to the shared react-i18next runtime (MYND-485) — replaces the
  // former English-only hand-rolled catalog lookup, so the editor's menu/toast
  // labels honor the active UI language + Weblate translations. i18next handles
  // nested keys, `{{var}}` interpolation, and `_one`/`_other` count plurals.
  t: (key, opts) => i18n.t(key, opts ?? {}),
  // Through the mobile clipboard seam (myne-md/myne#455), which reaches the
  // in-repo `sensitive-clipboard` plugin. A code block is ordinary content, so
  // it takes the PLAIN write: no device confinement, no expiry. Someone copying
  // a snippet may well want it on their Mac, and expiring it out from under them
  // thirty seconds later would be a bug wearing a security feature's clothes.
  clipboardWrite: clipboardWriteText,
  notes: {
    // The editor flow publishes its live flat tag index (built from decrypted
    // note bodies) into the bridge; the #tag autocomplete reads the latest here.
    tagTree: async () => currentEditorTagTree(),
    isMediaTarget,
  },
  attachments: {
    // The three members that moved onto the seam when `@myne/editor` stopped
    // importing Tauri directly. The IPC strings and payloads are unchanged —
    // only the caller moved.
    //
    // `picked` cannot reach this host: it carries a `PickedFile` whose handle is
    // host-private, and this host mints none (it omits `pickFiles`,
    // `resolveLiteralSource` and `pickedFromDropped`, so the editor renders no
    // picker affordance at all and every mobile attach goes through the React
    // sheet's own `<input type="file">` → `importFile`). Rejecting is the honest
    // answer to a handle from a host that does not exist here; silently reading
    // `handle` as if it were a `File` would be a guess.
    import: (source) => {
      if (source.kind === "picked") {
        return Promise.reject(
          new Error("editor-host: this host mints no PickedFile, so it cannot import one"),
        );
      }
      return attachmentImport({
        kind: "bytes",
        bytes: source.bytes,
        filename: source.filename,
      });
    },
    // The host shapes the rows, so the editor's render path holds no knowledge
    // of the IPC field names.
    catalogList: async () =>
      (await catalogList()).map((r) => ({
        id: r.id,
        contentType: r.content_type,
        filename: r.filename,
        size: r.size,
      })),
    // The `attachment://` scheme in whichever form this platform can actually
    // intercept — MYND-519: Android's WebView cannot intercept a custom scheme
    // and Tauri serves it as `http://attachment.localhost/<id>` there, so this
    // must go through `convertFileSrc` rather than build the literal.
    // `warmRefs` is omitted: the URL derives from the id with no IO, so there
    // is nothing to warm.
    resolveRef: attachmentSrc,
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
    // Hands the URL to the OS (myne-ops#15). This used to be a `window.open`
    // fallback with a comment saying no opener plugin was wired — the plugin
    // was in fact already in `Cargo.toml` and in the capability grant; what was
    // missing was a caller. Inside a WebView `window.open` opens an in-app
    // view, is eaten by the popup blocker, or does nothing, depending on the
    // platform; none of those is what a link in a note is asking for.
    void openUrl(url).catch(() => {
      /* Nothing to fall back to, and nothing worth interrupting the editor for. */
    });
  },
};

setEditorHost(host);
