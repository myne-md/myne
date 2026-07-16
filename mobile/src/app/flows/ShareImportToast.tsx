// SF5 confirmation surface for the share-import flow (§9.20, ledger SYNC-6/18):
// a calm, non-modal toast shown after a SILENT drain imports one or more shared
// files into the attachment library. Stay-put — no navigation (SYNC-18); it
// auto-dismisses. The drain itself lives in `lib/shareImport.ts`; this component
// only listens for its result event and renders the confirmation.
//
// NOTE: the copy is literal English pending the mobile-i18n catalogs
// (MYND-485); move to `t("shareImport.toast.*")` when that lands.

import { useEffect, useState } from "react";
import { Toast } from "../../components";
import { SHARES_IMPORTED_EVENT, type ImportedShare } from "../../lib/shareImport";

const DISMISS_MS = 4000;

function labelFor(imported: ImportedShare[]): string | null {
  // Only fresh (non-dedup) files are worth confirming (SYNC-9).
  const fresh = imported.filter((s) => !s.deduplicated);
  if (fresh.length === 0) return null;
  if (fresh.length === 1) return `${fresh[0].filename} added to your library`;
  return `${fresh.length} files added to your library`;
}

/** Listens for the share-drain result and shows a bottom-centered toast. Mount
 *  once inside the post-unlock shell (EditorFlow). */
export function ShareImportToast() {
  const [message, setMessage] = useState<string | null>(null);

  useEffect(() => {
    const onImported = (e: Event) => {
      const imported = (e as CustomEvent<ImportedShare[]>).detail ?? [];
      const label = labelFor(imported);
      if (label !== null) setMessage(label);
    };
    window.addEventListener(SHARES_IMPORTED_EVENT, onImported);
    return () => window.removeEventListener(SHARES_IMPORTED_EVENT, onImported);
  }, []);

  useEffect(() => {
    if (message === null) return;
    const id = window.setTimeout(() => setMessage(null), DISMISS_MS);
    return () => window.clearTimeout(id);
  }, [message]);

  if (message === null) return null;
  return (
    <div
      role="status"
      data-testid="share-import-toast"
      style={{
        position: "fixed",
        left: 0,
        right: 0,
        bottom: 24,
        display: "flex",
        justifyContent: "center",
        zIndex: 50,
        pointerEvents: "none",
      }}
    >
      <Toast>{message}</Toast>
    </div>
  );
}
