// The shared editor's `EditorHost` seam. Installs the IPC surface (tag index,
// spell, on-device AI, attachment IO, prefs, open-URL) + i18n into
// `@myne/editor` before any editor mounts. The pure engine + all pure helpers
// live in the package; only these platform-coupled operations are injected here.
// Imported for its side effect by `main.tsx` (after `./i18n`, before `<App>`).
//
// # One host, two clients (phase3-web-client task 26)
//
// This file compiles UNCHANGED for the web client — every import below either
// goes through `src/platform/` (substituted at build time) or through `invoke`,
// which the web seam routes into the wasm Worker. What differs is not the code
// but the **capability answers**, so the optional members are gated on
// `platform/capabilities` rather than duplicated into a second host file. A
// second file would be two places for one contract to drift, and the drift would
// present as an affordance that throws.
//
// Each member's web answer, so "every member has one" is checkable by reading:
//
// | member | web |
// |---|---|
// | `t`, `notes`, `prefsRead`, `openExternal`, `workspace` | same code, ported backends |
// | `attachments.attachmentExport` / `Rename` / `readText` / `readStructured` | same code; the attachment port is task 44, and until it lands these reject as `NotPortedToWeb` rather than lying |
// | `attachments.pickExportDestination` | **omitted** — no API grants a page a write path (`nativeSaveAs` absent); task 48's download flow is a different affordance |
// | `ai`, `transcribe`, `transcriptHonestyNote` | **omitted** — `localAi` is absent by decision (multi-GiB weights, one Worker thread) |
// | `spell` | **omitted** — task 47 decided spell-check is absent on web this release, and the reason is bundle size rather than portability (dictionaries are bundled binary resources). `spellCheck` is in the web descriptor's ABSENT set and the dispatcher answers `Unsupported`. The `MYD1` personal dictionary is untouched: it is vault content (`sync-protocol.md` §9 Class 1, set-union merge), so it keeps syncing and a desktop session keeps using it — what is absent is the CHECKER, not the word list. |

import { openUrl } from "./platform/opener";
import { writeText as clipboardWriteText } from "./platform/clipboardManager";
import { save } from "./platform/dialog";
import { convertFileSrc } from "./platform/core";
import {
  pickFiles,
  resolveLiteralSource,
  importPicked,
  pickedFromDropped,
} from "./platform/filePicker";
import { warmAttachmentUrls } from "./platform/attachments";
import { has } from "./platform/capabilities";
// Import from the `./host` sub-entry, NOT the package barrel: the barrel
// re-exports CMEditor + myneExtensions (the whole CodeMirror graph), and pulling
// setEditorHost through it drags that graph into the first-load bundle even
// though this boot-time seam install needs none of it. host.ts is CodeMirror-free
// at runtime (its only `@codemirror/*` reference is an `import type`).
import { setEditorHost, type EditorHost, type EditorPrefs } from "@myne/editor/host";
import { isPlainSurfaceActive } from "./plain/surfaceMode";
import { PlatformUnsupportedError } from "./platform/unsupported";
import i18n from "./i18n";
import { tagTree, isMediaTarget } from "./notes/vaultIndices";
import {
  attachmentExport,
  attachmentRename,
  attachmentReadText,
  attachmentReadStructured,
  attachmentImport,
  catalogList,
} from "./lib/attachments";
import {
  voiceRecordStart,
  voiceRecordStop,
  voiceRecordCancel,
  onVoiceLevel,
  onVoiceClip,
} from "./lib/voice-record";
import { prefsRead } from "./lib/prefs";
import { renameFlushHooks } from "./notes/renameFlushHook";
import { CLOSE_ACTIVE_TAB_EVENT } from "./notes/closeActiveTabSignal";
import {
  OPEN_COVER_PICKER_EVENT,
  REMOVE_COVER_EVENT,
} from "@myne/editor/cover-signal";
import { infer,
  inferAmbient, buildCompletionPrompt, buildTitlePrompt } from "./lib/writing-assistant";
import { spellCheck, addToPersonalDictionary, ignoreWordInVault } from "./lib/spell";
import { startTranscription } from "./lib/transcribe";
import { AI_TRANSCRIPT_HONESTY_NOTE } from "./lib/load-bearing-copy";
import { setAttachmentToastSink } from "./editor/attachments/toast";
import { toast } from "./components/toast/toastStore";

/**
 * The editor preferences the plain surface answers with (myne-md/myne#788).
 *
 * Never read from the vault: `vault.prefs` is unreadable with the vault locked
 * and does not exist before one, which is exactly the states the surface must
 * work in. `spell_enabled: false` is the second half of the grill's Q18 (no
 * spellcheck on this surface), enforced here rather than by remembering to
 * hide the squiggles.
 */
const PLAIN_SURFACE_PREFS: EditorPrefs = {
  editor_content_width: null,
  editor_font_family: null,
  editor_line_spacing: null,
  editor_text_size: null,
  spell_enabled: false,
  spell_languages: [],
};

const host: EditorHost = {
  t: (key, opts) => i18n.t(key, opts ?? {}),
  notes: {
    // The tag tree is vault content, and the tag suggestion band asks for it
    // the moment a `#` is typed. While the plain surface is active the answer
    // is the empty tree, so a loose file's tags lead nowhere rather than
    // reaching into the vault. (`isMediaTarget` is a pure predicate.)
    tagTree: () =>
      isPlainSurfaceActive() ? Promise.resolve([]) : tagTree(),
    isMediaTarget,
  },
  // Same code for desktop and web, and the substitution is the whole point: the
  // desktop seam re-exports the Tauri clipboard plugin's write, the web seam IS
  // the raw WebView write. `editor/` sees one member either way, which is what
  // lets the clipboard guard prohibit that raw API everywhere except
  // `web/src/platform/`, the one file that legitimately is the seam.
  clipboardWrite: clipboardWriteText,
  attachments: {
    // The members task 76 moved off `@myne/editor`'s direct Tauri imports. The
    // IPC strings and payloads are byte-unchanged — only the caller moved.
    //
    // A picked source is imported BY THE SEAM (task 67), because the two
    // platforms differ in who reads the bytes: desktop hands Rust a path and
    // Rust opens it inside its root-confined seam, while a browser has no path
    // and moves the `File` handle to the Worker so the page never allocates the
    // content. The unwrap used to live in `src/lib/picked-file.ts` and THREW for
    // any handle it had not minted — i.e. for every web pick.
    import: (source) => {
      if (isPlainSurfaceActive()) {
        return Promise.reject(new PlatformUnsupportedError("core.invoke"));
      }
      return source.kind === "picked"
        ? importPicked(source.file)
        : attachmentImport(source);
    },
    // The host shapes the rows, so the editor's render path holds no knowledge
    // of the IPC field names.
    catalogList: async () =>
      isPlainSurfaceActive()
        ? []
        : (await catalogList()).map((r) => ({
        id: r.id,
        contentType: r.content_type,
        filename: r.filename,
        size: r.size,
      })),
    // Both go through `platform/filePicker`, which is where the path-vs-`File`
    // difference is absorbed: desktop wraps the native dialog's absolute paths,
    // web wraps `File`s, and neither ever reaches this file or the editor.
    pickFiles,
    resolveLiteralSource,
    // Task 67: a `File` from an HTML5 drop or paste, wrapped so the HOST moves
    // it. Installed unconditionally rather than capability-gated — the desktop
    // arm answers `null` ("no handle for a DataTransfer file"), which is the
    // modelled answer the editor already falls back from, and gating it would
    // put a platform test here for a call whose desktop cost is one return.
    pickedFromDropped,
    // The `attachment://` custom protocol in this platform's form. MYND-519:
    // Android WebView and Windows WebView2 cannot intercept a custom scheme, so
    // Tauri serves it as `http://attachment.localhost/<id>` there;
    // `convertFileSrc` emits whichever form the platform needs and
    // `scheme_core::extract_id` accepts them all. The web seam answers with the
    // canonical literal until task 44 mints object URLs.
    resolveRef: (id: string) => convertFileSrc(id, "attachment"),
    // Unconditional, not capability-gated: the desktop arm is an immediate
    // resolve because `attachment://<id>` needs no IO, and the web arm decrypts
    // the ids a note references so its synchronous `resolveRef` can answer.
    // Gating would put a platform test here for a call whose desktop cost is
    // zero.
    //
    // The `void` wrapper is deliberate. `warmAttachmentUrls` resolves to the ids
    // whose URL CHANGED (myne#388) — the library surfaces need that, so they go
    // through `src/platform/attachments` directly — but the editor's own caller
    // warms the ids the OPEN DOCUMENT embeds and has no thumbnails to remount,
    // so it wants the void contract. Keeping `EditorHost.warmRefs` as-is is also
    // what keeps this change out of the mobile client's build.
    // Vault-coupled: the warm pass asks the attachments plugin for ids. While
    // the plain surface is active it is skipped entirely, so a loose file that
    // happens to embed an `attachment://` literal warms nothing. (`resolveRef`
    // beside it needs no guard: on desktop it is a pure string transform, no
    // IPC and no IO.)
    warmRefs: async (ids) => {
      if (isPlainSurfaceActive()) return;
      await warmAttachmentUrls(ids);
    },
    attachmentExport,
    attachmentRename,
    // Desktop: native Save-As dialog (the OS confirms any overwrite). Omitted
    // where `nativeSaveAs` is absent — the editor then renders no Export
    // affordance at all, rather than one that fails on click.
    ...(has("nativeSaveAs")
      ? { pickExportDestination: (filename: string) => save({ defaultPath: filename }) }
      : {}),
    // MYND-268 Tier-1: decrypt-to-text for the inline read-only preview.
    readText: attachmentReadText,
    // MYND-268 Tier-2: decrypt + Rust-parse docx/xlsx into a structured model.
    readStructured: attachmentReadStructured,
  },
  prefsRead: async (): Promise<EditorPrefs> =>
    isPlainSurfaceActive()
      ? PLAIN_SURFACE_PREFS
      : ((await prefsRead()) as EditorPrefs),
  openExternal: (url) => {
    void openUrl(url).catch((err: unknown) => {
      if (import.meta.env.DEV) console.warn("openExternal: openUrl rejected", err);
    });
  },
  // On-device AI: omitted where `localAi` is absent, which takes the ghost-text
  // and the AI slash commands with it — the seam's own contract for `ai`.
  ...(has("localAi")
    ? { ai: { infer, inferAmbient, buildCompletionPrompt, buildTitlePrompt } }
    : {}),
  // Omitted where `spellCheck` is absent (task 47) — the seam's own contract for
  // `spell` is that omission disables the feature, so the editor renders no
  // squiggles and no dictionary affordances rather than ones that reject.
  ...(has("spellCheck")
    ? {
        spell: {
          // The personal dictionary is vault content. While the plain surface
          // is active every member answers emptily, so the pass cannot read
          // or write `vault.dictionary` even if a future change re-enables
          // `spell_enabled` for this surface.
          spellCheck: (words: string[], langs: string[]) =>
            isPlainSurfaceActive() ? Promise.resolve([]) : spellCheck(words, langs),
          addToPersonalDictionary: (word: string) =>
            isPlainSurfaceActive()
              ? Promise.resolve()
              : addToPersonalDictionary(word),
          ignoreWordInVault: (word: string) =>
            isPlainSurfaceActive()
              ? Promise.resolve()
              : ignoreWordInVault(word),
        },
      }
    : {}),
  // Native mic capture (MYND-259). Present on both clients as CODE — the calls
  // route through the seam like everything else — but the web `invoke` refuses
  // `plugin:attachments|voice_record_*` loudly (`attachments` is still
  // `Class::Pending`), so `/record` surfaces a failure rather than silence. That
  // is the interim task 44 fixes; a capability flag would be the wrong tool
  // because the browser CAN capture audio (`getUserMedia`) — the decision owed
  // here is which backend, not whether.
  voice: {
    start: voiceRecordStart,
    stop: voiceRecordStop,
    cancel: voiceRecordCancel,
    onLevel: onVoiceLevel,
    onClip: onVoiceClip,
  },
  // Speech-to-text (voice-to-text MYND-552, SYNC-V7): bridge the shared audio
  // widget's Transcribe affordance to the local-inference `transcribe` command
  // via the shared helper (streaming Channel + shared cancel). `view` is unused
  // desktop-side today; the seam threads it for parity/future use.
  // Both ride `localAi`: transcription IS the on-device engine, and the honesty
  // note exists to caveat a transcript. Shipping the note without the feature
  // would caveat something that cannot happen.
  ...(has("localAi")
    ? {
        transcribe: (_view: unknown, attachmentId: string, opts?: { onSegment?: (s: string) => void }) =>
          startTranscription(attachmentId, opts?.onSegment),
        // The load-bearing transcript-fallibility honesty note, rendered
        // VERBATIM by the widget's read-only expander (SYNC-V8 — never i18n'd).
        transcriptHonestyNote: AI_TRANSCRIPT_HONESTY_NOTE,
      }
    : {}),
  // vim `:` command line (MYND-313). Both members bridge into React-owned state
  // from module scope, so each goes through an existing cross-provider seam
  // rather than reaching into a context it cannot see:
  //   - `:w` reuses the workspace layer's already-registered flush-all hook (the
  //     same one rename auto-update drives).
  //   - `:q` emits a window event the editor shell listens for; the shell owns
  //     the pane tree and is the only thing that can close a tab correctly.
  // The cover picker is a React modal the shell mounts, the same reason
  // `closeActiveTab` below is an event rather than a call. The TARGET, though,
  // now rides along instead of being inferred from focus on the far side
  // (myne-md/myne#520): the banner knows which note it is drawing, and in a
  // split that is the only thing that does at the moment the control is pressed.
  cover: {
    openPicker: (hasCover, noteId) =>
      window.dispatchEvent(
        new CustomEvent(OPEN_COVER_PICKER_EVENT, { detail: { hasCover, noteId } }),
      ),
    remove: (noteId) =>
      window.dispatchEvent(new CustomEvent(REMOVE_COVER_EVENT, { detail: { noteId } })),
  },
  workspace: {
    flushPendingSaves: () => renameFlushHooks().flushOpenPanes(),
    closeActiveTab: () => window.dispatchEvent(new CustomEvent(CLOSE_ACTIVE_TAB_EVENT)),
  },
};

setEditorHost(host);

// Route the editor's imperative toasts (attachment insert/convert, vim `:w`,
// wikilink convert, palette failures) into the app's central store so they join
// the shared <Toaster> stack instead of drawing their own separate surface (#238).
setAttachmentToastSink((message, variant, durationMs) => {
  toast({ message, variant, durationMs });
});
