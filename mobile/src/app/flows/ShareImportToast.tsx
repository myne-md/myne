// SF5 confirmation surface for the share-import flow (§9.20, ledger SYNC-6/18):
// a calm, non-modal toast shown after a SILENT drain imports one or more shared
// files into the attachment library. Stay-put — no navigation (SYNC-18); it
// auto-dismisses. The drain itself lives in `lib/shareImport.ts`; this component
// only listens for its result event and renders the confirmation.
//
// NOTE: the copy here (and the "Open library" button label) is still literal
// English. The mobile-i18n catalogs (MYND-485) have since landed; moving these
// strings into the shared toast copy family is owed but tracked separately — it
// is not part of the MYND-640 visibility fix.

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
 *  once inside the post-unlock shell (EditorFlow).
 *
 *  MYND-640: the toast is the ONLY thing that tells a user their share arrived —
 *  the drain files it into the attachment library, which is not where they were
 *  looking — and it used to be `pointerEvents: "none"`, so it could not be
 *  tapped. A share therefore ended as a sentence that vanished after a few
 *  seconds, and the file was somewhere the user had no reason to open. Given
 *  `onOpenLibrary`, the toast becomes the way there. */
export function ShareImportToast({ onOpenLibrary }: { onOpenLibrary?: () => void }) {
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
        insetInlineStart: 0,
        insetInlineEnd: 0,
        bottom: 24,
        display: "flex",
        justifyContent: "center",
        zIndex: 50,
        // This wrapper is a full-width fixed band; keep it click-through so its
        // transparent left/right regions never swallow taps meant for the
        // TabBar/FormatBar beneath it (a handler-less div with pointerEvents:
        // "auto" still captures clicks — transparency is not pass-through). Only
        // the inner button re-enables pointer events; see its style below.
        pointerEvents: "none",
      }}
    >
      {onOpenLibrary === undefined ? (
        <Toast>{message}</Toast>
      ) : (
        /* A button, not a div with a handler: this is the route to the file, so
           it has to be reachable by keyboard and announced as actionable. */
        <button
          type="button"
          aria-label="Open library"
          onClick={() => {
            setMessage(null);
            onOpenLibrary();
          }}
          data-testid="share-import-toast-open"
          style={{
            // Re-enable pointer events on JUST the pill. The wrapper stays
            // click-through (pointerEvents: "none" above), so the nav bar behind
            // the toast's transparent side regions still receives taps while the
            // pill itself remains tappable — a child overrides the parent's
            // "none". When onOpenLibrary is undefined there is no button at all,
            // so nothing is tappable: same inert result, no side-band regression.
            pointerEvents: "auto",
            border: 0,
            padding: 0,
            background: "transparent",
            cursor: "pointer",
            font: "inherit",
            textAlign: "inherit",
          }}
        >
          <Toast>{message}</Toast>
        </button>
      )}
    </div>
  );
}
