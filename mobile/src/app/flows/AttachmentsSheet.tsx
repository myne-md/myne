// Attachments library sheet (mobile) — lists the vault catalog (MYC1) with a
// decrypt thumbnail per row, and Insert / Rename / Delete actions. Reads through
// the shared `myne-core` attachments plugin; images are served by the in-app
// `attachment://` scheme (decrypt in RAM + re-sniff). No voice / text-extraction.

import { useCallback, useEffect, useState } from "react";
import { Sheet, Banner, Spinner } from "../../components";
import { catalogList, attachmentDelete, attachmentRename, attachmentUnusedList, attachmentCleanUnused, type CatalogEntry } from "../../lib/attachments";
import { attachmentSrc } from "../../lib/attachmentRef";
import { HAS_TAURI } from "../../lib/app-window";
import { formatBytes } from "../../lib/util";
import { showAttachmentLightbox } from "@myne/editor/attachments/lightbox";

const isImage = (t: string) => t.startsWith("image/");
/** Which preview the shared lightbox can show for a content-type (else null). */
const previewKind = (t: string): "image" | "pdf" | null =>
  t === "application/pdf" ? "pdf" : t.startsWith("image/") ? "image" : null;
/** Open the shared image/PDF lightbox (same preview as tapping an embed in a note). */
const openPreview = (e: CatalogEntry) => {
  const kind = previewKind(e.content_type);
  if (kind) showAttachmentLightbox({ url: attachmentSrc(e.id), alt: e.filename, kind, id: e.id });
};

export function AttachmentsSheet({
  onClose,
  onInsert,
  variant = "sheet",
}: {
  onClose: () => void;
  /** When provided, each row shows an "Insert" action that embeds the
   *  attachment into the open note. Omitted for the top-level library (browse /
   *  rename / delete only). */
  onInsert?: (id: string, filename: string) => void;
  /** `"sheet"` = floating modal (in-editor insert picker). `"page"` = full
   *  bottom-tab page (the top-level Files library). */
  variant?: "sheet" | "page";
}) {
  const [entries, setEntries] = useState<CatalogEntry[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [renameText, setRenameText] = useState("");
  // Clean-unused review: the unused entries being confirmed for erase, or null.
  const [cleanup, setCleanup] = useState<CatalogEntry[] | null>(null);
  const [cleaning, setCleaning] = useState(false);
  const [note, setNote] = useState<string | null>(null);

  async function reviewUnused() {
    setError(null);
    setNote(null);
    if (!HAS_TAURI) {
      setNote("Attachment cleanup needs the app.");
      return;
    }
    try {
      const unused = await attachmentUnusedList();
      if (unused.length === 0) setNote("No unused attachments — every file is referenced.");
      else setCleanup(unused);
    } catch {
      setError("Couldn't scan for unused attachments.");
    }
  }

  async function eraseUnused() {
    if (cleanup === null) return;
    setCleaning(true);
    try {
      const res = await attachmentCleanUnused(cleanup.map((e) => e.id));
      setCleanup(null);
      setNote(`Erased ${res.deleted} unused ${res.deleted === 1 ? "file" : "files"}.`);
      load();
    } catch {
      setError("Couldn't erase the unused attachments.");
    } finally {
      setCleaning(false);
    }
  }

  const load = useCallback(() => {
    if (!HAS_TAURI) {
      setEntries([]);
      return;
    }
    setError(null);
    void catalogList()
      .then((e) => setEntries([...e].sort((a, b) => b.created_at - a.created_at)))
      .catch(() => setError("Couldn't read attachments."));
  }, []);
  useEffect(() => load(), [load]);

  async function remove(id: string) {
    try {
      if (HAS_TAURI) await attachmentDelete(id);
      setEntries((es) => (es ?? []).filter((e) => e.id !== id));
    } catch {
      setError("Couldn't delete that attachment.");
    }
  }

  async function commitRename(id: string) {
    const name = renameText.trim();
    setRenaming(null);
    if (name === "") return;
    try {
      if (HAS_TAURI) await attachmentRename(id, name);
      setEntries((es) => (es ?? []).map((e) => (e.id === id ? { ...e, filename: name } : e)));
    } catch {
      setError("Couldn't rename that attachment.");
    }
  }

  const totalUnusedBytes = (cleanup ?? []).reduce((s, e) => s + e.size, 0);

  // Shared bits between the modal (sheet) and the full-page (Files tab) render.
  const cleanAction = cleanup ? (
    <button onClick={() => setCleanup(null)} style={actionLink}>Cancel</button>
  ) : (
    <button onClick={() => void reviewUnused()} style={actionLink}>Clean unused</button>
  );

  const banner = (
    <>
      {error && (
        <div style={{ marginTop: 10, flex: "none" }}>
          <Banner kind="danger">{error}</Banner>
        </div>
      )}
      {note && !error && (
        <div style={{ marginTop: 10, flex: "none", fontSize: 13, color: "var(--fg-3)", textAlign: "center" }}>{note}</div>
      )}
    </>
  );

  const cleanupPanel = cleanup && (
    <div style={{ marginTop: 12, flex: "none" }}>
      <div style={{ fontSize: 14, lineHeight: 1.5, color: "var(--fg-2)" }}>
        {cleanup.length} {cleanup.length === 1 ? "attachment is" : "attachments are"} referenced by no note ({formatBytes(totalUnusedBytes)}). Erasing is a permanent cryptographic delete — there is no trash.
      </div>
      <button
        onClick={() => void eraseUnused()}
        disabled={cleaning}
        style={{ marginTop: 12, width: "100%", height: 48, border: "none", borderRadius: 8, background: "var(--danger)", color: "#fff", fontFamily: "var(--font-sans)", fontSize: 15, fontWeight: 600, cursor: "pointer", opacity: cleaning ? 0.5 : 1 }}
      >
        Erase {cleanup.length} unused {cleanup.length === 1 ? "file" : "files"}
      </button>
    </div>
  );

  const listInner = (
    <>
        {cleanup ? (
          cleanup.map((e) => (
            <div key={e.id} style={{ display: "flex", alignItems: "center", gap: 12, padding: "10px 4px", borderTop: "1px solid var(--line-1)" }}>
              <div style={{ width: 36, height: 36, borderRadius: 8, background: "var(--bg-2)", flexShrink: 0, overflow: "hidden", display: "flex", alignItems: "center", justifyContent: "center" }}>
                {isImage(e.content_type) ? (
                  <img src={attachmentSrc(e.id)} alt="" style={{ width: "100%", height: "100%", objectFit: "cover" }} />
                ) : (
                  <svg width="18" height="18" viewBox="0 0 24 24">
                    <path d="M14 3v5h5M7 3h8l5 5v11a1 1 0 0 1-1 1H7a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1z" fill="none" stroke="var(--fg-3)" strokeWidth="1.6" strokeLinejoin="round" />
                  </svg>
                )}
              </div>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 15, color: "var(--fg-1)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{e.filename}</div>
                <div style={{ fontSize: 12, color: "var(--fg-3)" }}>{formatBytes(e.size)}</div>
              </div>
            </div>
          ))
        ) : entries === null ? (
          <div style={{ display: "flex", justifyContent: "center", padding: 30 }}>
            <Spinner />
          </div>
        ) : entries.length === 0 ? (
          <div style={{ textAlign: "center", padding: "30px 20px", color: "var(--fg-3)", fontSize: 14, lineHeight: 1.55 }}>
            No attachments yet. Use the paperclip in the editor to add an image or PDF.
          </div>
        ) : (
          entries.map((e) => (
            <div key={e.id} style={{ display: "flex", alignItems: "center", gap: 12, padding: "10px 4px", borderTop: "1px solid var(--line-1)" }}>
              <div
                onClick={() => openPreview(e)}
                style={{ width: 44, height: 44, borderRadius: 8, background: "var(--bg-2)", flexShrink: 0, overflow: "hidden", display: "flex", alignItems: "center", justifyContent: "center", cursor: previewKind(e.content_type) ? "pointer" : "default" }}
              >
                {isImage(e.content_type) ? (
                  <img src={attachmentSrc(e.id)} alt="" style={{ width: "100%", height: "100%", objectFit: "cover" }} />
                ) : (
                  <svg width="20" height="20" viewBox="0 0 24 24">
                    <path d="M14 3v5h5M7 3h8l5 5v11a1 1 0 0 1-1 1H7a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1z" fill="none" stroke="var(--fg-3)" strokeWidth="1.6" strokeLinejoin="round" />
                  </svg>
                )}
              </div>
              <div style={{ flex: 1, minWidth: 0 }}>
                {renaming === e.id ? (
                  <input
                    value={renameText}
                    onChange={(ev) => setRenameText(ev.target.value)}
                    onBlur={() => void commitRename(e.id)}
                    onKeyDown={(ev) => ev.key === "Enter" && void commitRename(e.id)}
                    autoFocus
                    style={{ width: "100%", height: 34, border: "1px solid var(--line-2)", borderRadius: 6, background: "var(--bg-1)", padding: "0 10px", fontSize: 15, color: "var(--fg-1)", outline: "none", boxSizing: "border-box" }}
                  />
                ) : (
                  <div onClick={() => openPreview(e)} style={{ cursor: previewKind(e.content_type) ? "pointer" : "default" }}>
                    <div style={{ fontSize: 15, color: "var(--fg-1)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{e.filename}</div>
                    <div style={{ fontSize: 12, color: "var(--fg-3)" }}>{formatBytes(e.size)}</div>
                  </div>
                )}
              </div>
              {renaming !== e.id && (
                <div style={{ display: "flex", gap: 2, flexShrink: 0 }}>
                  {onInsert && <button onClick={() => onInsert(e.id, e.filename)} style={actionBtn("var(--accent)")}>Insert</button>}
                  <button onClick={() => { setRenaming(e.id); setRenameText(e.filename); }} style={actionBtn("var(--fg-2)")}>Rename</button>
                  <button onClick={() => void remove(e.id)} style={actionBtn("var(--danger)")}>Delete</button>
                </div>
              )}
            </div>
          ))
        )}
    </>
  );

  const title = cleanup ? "Clean unused" : variant === "page" ? "Files" : "Attachments";

  if (variant === "page") {
    return (
      <>
        {/* Sits under the shared AppHeader (Files tab), so no safe-area top here. */}
        <div style={{ flex: "none", padding: "8px 20px 0" }}>
          <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", gap: 12 }}>
            <h1 style={{ margin: 0, fontSize: 32, fontWeight: 700, letterSpacing: "-0.025em", color: "var(--fg-display)" }}>{title}</h1>
            {cleanAction}
          </div>
          {banner}
          {cleanupPanel}
        </div>
        <div style={{ overflowY: "auto", flex: 1, minHeight: 0, padding: "12px 20px 0" }}>{listInner}</div>
      </>
    );
  }

  return (
    <Sheet onClose={onClose} style={{ maxHeight: "82%", display: "flex", flexDirection: "column", overflow: "hidden" }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", flex: "none" }}>
        <span style={{ width: 90 }} />
        <span style={{ fontSize: 17, fontWeight: 600, color: "var(--fg-1)" }}>{title}</span>
        <span style={{ width: 90, textAlign: "right" }}>{cleanAction}</span>
      </div>
      {banner}
      {cleanupPanel}
      <div style={{ marginTop: 12, overflowY: "auto", flex: 1, minHeight: 0 }}>{listInner}</div>
    </Sheet>
  );
}

const actionLink: React.CSSProperties = { border: "none", background: "transparent", color: "var(--accent)", fontSize: 14, fontWeight: 600, cursor: "pointer", padding: 0 };

function actionBtn(color: string): React.CSSProperties {
  return { border: "none", background: "transparent", color, fontSize: 13, fontWeight: 600, cursor: "pointer", padding: "6px 7px" };
}
