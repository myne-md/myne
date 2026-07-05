// Desktop implementation of the shared editor's `EditorHost` seam. Installs the
// Tauri-backed IPC surface (tag index, spell, on-device AI, attachment IO,
// prefs, open-URL) + i18n into `@myne/editor` before any editor mounts. The
// pure engine + all pure helpers live in the package; only these platform-
// coupled operations are injected here. Imported for its side effect by
// `main.tsx` (after `./i18n`, before `<App>` renders).

import { openUrl } from "@tauri-apps/plugin-opener";
import { setEditorHost, type EditorHost, type EditorPrefs } from "@myne/editor";
import i18n from "./i18n";
import { tagTree, isMediaTarget } from "./notes/vaultIndices";
import { attachmentExport, attachmentRename } from "./lib/attachments";
import { prefsRead } from "./lib/prefs";
import { infer, buildCompletionPrompt, buildTitlePrompt } from "./lib/writing-assistant";
import { spellCheck, addToPersonalDictionary, ignoreWordInVault } from "./lib/spell";

const host: EditorHost = {
  t: (key, opts) => i18n.t(key, opts ?? {}),
  notes: { tagTree, isMediaTarget },
  attachments: { attachmentExport, attachmentRename },
  prefsRead: async (): Promise<EditorPrefs> => (await prefsRead()) as EditorPrefs,
  openExternal: (url) => {
    void openUrl(url);
  },
  ai: { infer, buildCompletionPrompt, buildTitlePrompt },
  spell: { spellCheck, addToPersonalDictionary, ignoreWordInVault },
  warn: import.meta.env.DEV ? (...args) => console.warn(...args) : undefined,
};

setEditorHost(host);
