// Import to vault: the plain surface's one-shot crossing into the vault
// (myne-md/myne#788, task 9).
//
// This component is mounted BY the plain surface but deliberately does NOT
// live under `src/plain/`: `scripts/check-plain-surface-imports.mjs` forbids
// that tree from reaching `src/notes/**` or `src/lib/vault-*`, and this is the
// one control whose whole job is to reach them. Everything it touches is gated
// on an unlocked vault first, and the flush/close ordering lives in the plain
// store (`importToVault`), which is vault-free and takes the note write as an
// injected callback.
//
// The note write itself reuses the importer's own two pieces: `mapImportedFile`
// (filename-derived title injected through the same surgery create/rename use)
// and `noteCreate` (the exact sink `src/notes/import/ports.ts` binds). No new
// note-creation path exists here, and nothing links the note back to the file:
// no path, no origin metadata, no embed.
//
// Refusals are the app's calm answer for the state, not a passphrase prompt:
// a locked vault and a vault-less device each get one sentence, and the file
// stays untouched on disk either way.

import { useState } from "react";
import { useTranslation } from "react-i18next";
import { IconButton } from "../primitives/IconButton";
import { mapImportedFile } from "../../notes/import/mapping";
import { noteCreate } from "../../notes/createNote";
import { requestNoteOpen } from "../../notes/pendingNoteOpen";
import { isVaultUnlocked } from "../../lib/vault-unlock";
import { listVaults } from "../../lib/vault-list";
import { importToVault } from "../../plain/store";

interface ImportPlainFileButtonProps {
  /** The handle of the tab this action imports. */
  handle: number;
}

export function ImportPlainFileButton({ handle }: ImportPlainFileButtonProps) {
  const { t } = useTranslation();
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  const importFile = async () => {
    setBusy(true);
    setMessage(null);
    try {
      const unlocked = await isVaultUnlocked().catch(() => false);
      if (!unlocked) {
        // Distinguish the two states only to say the right sentence: one asks
        // for an unlock, the other for a vault that does not exist yet.
        const list = await listVaults();
        const vaultless = "ok" in list && list.ok.length === 0;
        setMessage(t(vaultless ? "plainFile.importNeedsVault" : "plainFile.importLocked"));
        return;
      }
      const noteId = await importToVault(handle, async ({ name, content }) => {
        const mapped = mapImportedFile(name, content, { titleFromFilename: true });
        const created = await noteCreate(mapped.plaintext, null);
        // Lands when the Editor remounts after this surface closes; dropped if
        // the note is not in the live list by then (src/notes/pendingNoteOpen).
        requestNoteOpen(created);
        return created;
      });
      if (noteId === null) setMessage(t("plainFile.importFailed"));
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <IconButton
        icon="copy"
        label={t("plainFile.import")}
        tooltip
        bordered
        disabled={busy}
        testId="plain-file.import"
        onClick={() => void importFile()}
      />
      {message !== null && (
        <span
          role="alert"
          data-testid="plain-file.import-guidance"
          style={{
            color: "var(--fg-2)",
            fontSize: "var(--text-xs)",
            whiteSpace: "nowrap",
          }}
        >
          {message}
        </span>
      )}
    </>
  );
}
