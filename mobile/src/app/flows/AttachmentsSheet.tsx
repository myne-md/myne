// Attachments library sheet (mobile) — lists the vault catalog (MYC1) with a
// decrypt thumbnail per row, and Insert / Rename / Delete actions. Reads through
// the shared `myne-core` attachments plugin; images are served by the in-app
// `attachment://` scheme (decrypt in RAM + re-sniff). Images/PDFs open the shared
// lightbox on tap; voice notes get an inline play/pause tile (no text-extraction).

import { useCallback, useEffect, useRef, useState } from "react";
import { Sheet, Banner, Spinner } from "../../components";
import { catalogList, attachmentDelete, attachmentRename, attachmentUnusedList, attachmentCleanUnused, importFile, ATTACHMENT_ACCEPT, type CatalogEntry } from "../../lib/attachments";
import { attachmentSrc } from "../../lib/attachmentRef";
import { HAS_TAURI } from "../../lib/app-window";
import { formatBytes } from "../../lib/util";
import { showAttachmentLightbox } from "@myne/editor/attachments/lightbox";

const isImage = (t: string) => t.startsWith("image/");
/** Voice notes / audio (stored as `audio/wav`): an inline play/pause tile in the
 *  row rather than a lightbox — playback, not a focused visual preview. */
const isAudio = (t: string) => t.startsWith("audio/");
/** Which preview the shared lightbox can show for a content-type (else null).
 *  Audio is deliberately excluded here — it is handled by {@link AudioTile}. */
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
  // Direct upload from the sheet/page (no longer paperclip-only).
  const [uploading, setUploading] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

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

  /** Import a picked file into the vault (MYA1) and refresh the catalog so the
   *  new attachment appears in-place — the user no longer has to go through the
   *  editor paperclip to add a file. */
  async function upload(file: File) {
    if (!HAS_TAURI) {
      setError("Attachments need the app (not the browser preview).");
      return;
    }
    setError(null);
    setNote(null);
    setUploading(true);
    try {
      await importFile(file);
      load();
    } catch (e) {
      const kind = (e as { kind?: string })?.kind;
      setError(
        kind === "Oversize"
          ? "That file is too large (max 64 MB)."
          : kind === "UnsupportedType"
            ? "Only images and PDFs can be attached."
            : "Couldn't add that file.",
      );
    } finally {
      setUploading(false);
    }
  }

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
  // `Clean unused` is a text link in the sheet header, a ghost bordered button on
  // the Files page (where it sits beside the primary Upload).
  const cleanBtn = (style: React.CSSProperties) =>
    cleanup ? (
      <button onClick={() => setCleanup(null)} style={style}>Cancel</button>
    ) : (
      <button onClick={() => void reviewUnused()} style={style}>Clean unused</button>
    );

  const uploadInput = (
    <input
      ref={fileRef}
      type="file"
      accept={ATTACHMENT_ACCEPT}
      style={{ display: "none" }}
      onChange={(e) => {
        const f = e.target.files?.[0];
        if (f) void upload(f);
        e.target.value = "";
      }}
    />
  );

  // Upload affordance — a text link in the sheet header, a filled primary button
  // on the Files page. Hidden during the clean-unused review (nothing to upload).
  const uploadBtn = (kind: "link" | "primary") =>
    cleanup ? null : (
      <button
        onClick={() => fileRef.current?.click()}
        disabled={uploading}
        style={
          kind === "primary"
            ? { ...uploadPrimaryStyle, opacity: uploading ? 0.6 : 1 }
            : { ...actionLink, opacity: uploading ? 0.5 : 1 }
        }
      >
        {kind === "primary" && (
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" style={{ flexShrink: 0 }}>
            <path d="M12 16V4M7 9l5-5 5 5M5 20h14" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        )}
        {uploading ? "Adding…" : "Upload"}
      </button>
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
            No attachments yet. Tap Upload to add an image or PDF.
          </div>
        ) : (
          entries.map((e) => (
            <div key={e.id} style={{ display: "flex", alignItems: "center", gap: 12, padding: "10px 4px", borderTop: "1px solid var(--line-1)" }}>
              <div
                onClick={isAudio(e.content_type) ? undefined : () => openPreview(e)}
                style={{ width: 44, height: 44, borderRadius: 8, background: "var(--bg-2)", flexShrink: 0, overflow: "hidden", display: "flex", alignItems: "center", justifyContent: "center", cursor: previewKind(e.content_type) ? "pointer" : "default" }}
              >
                {isImage(e.content_type) ? (
                  <img src={attachmentSrc(e.id)} alt="" style={{ width: "100%", height: "100%", objectFit: "cover" }} />
                ) : isAudio(e.content_type) ? (
                  <AudioTile id={e.id} filename={e.filename} />
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
        {uploadInput}
        {/* Sits under the shared AppHeader (Files tab), so no safe-area top here. */}
        <div style={{ flex: "none", padding: "8px 20px 0" }}>
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12 }}>
            <h1 style={{ margin: 0, fontSize: 32, fontWeight: 700, letterSpacing: "-0.025em", color: "var(--fg-display)" }}>{title}</h1>
            <div style={{ display: "flex", alignItems: "center", gap: 8, flexShrink: 0 }}>
              {cleanBtn(ghostBtnStyle)}
              {uploadBtn("primary")}
            </div>
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
      {uploadInput}
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8, flex: "none" }}>
        <span style={{ width: 90 }}>{uploadBtn("link")}</span>
        <span style={{ fontSize: 17, fontWeight: 600, color: "var(--fg-1)" }}>{title}</span>
        <span style={{ width: 90, textAlign: "right" }}>{cleanBtn(actionLink)}</span>
      </div>
      {banner}
      {cleanupPanel}
      <div style={{ marginTop: 12, overflowY: "auto", flex: 1, minHeight: 0 }}>{listInner}</div>
    </Sheet>
  );
}

/** Inline play/pause tile for a voice note / audio attachment — the row thumbnail
 *  slot (44×44). Mirrors the desktop library's AudioThumbnail: a hidden `<audio>`
 *  streams the decrypted bytes from the in-app `attachment://` scheme (allowed by
 *  the CSP `media-src`), and playback is paused on unmount so the sound stops —
 *  and the decoded buffer is released — when the row scrolls out or the tab
 *  closes (playback-residue discipline). */
function AudioTile({ id, filename }: { id: string; filename: string }) {
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const [playing, setPlaying] = useState(false);

  // Stop playback when the tile unmounts (row scrolled away / Files tab closed).
  useEffect(() => {
    const audio = audioRef.current;
    return () => audio?.pause();
  }, []);

  const toggle = (ev: React.MouseEvent) => {
    // Don't let the tap bubble to the row (openPreview / rename) or select text.
    ev.preventDefault();
    ev.stopPropagation();
    const audio = audioRef.current;
    if (audio === null) return;
    if (audio.paused) {
      void audio.play();
      setPlaying(true);
    } else {
      audio.pause();
      setPlaying(false);
    }
  };

  return (
    <>
      <audio
        ref={audioRef}
        src={attachmentSrc(id)}
        preload="none"
        onEnded={() => setPlaying(false)}
        style={{ display: "none" }}
      />
      <button
        type="button"
        onClick={toggle}
        data-testid="files.audio-play"
        data-attachment-id={id}
        aria-label={`${playing ? "Pause" : "Play"} ${filename}`}
        style={{ width: "100%", height: "100%", border: "none", background: "transparent", display: "flex", alignItems: "center", justifyContent: "center", cursor: "pointer", padding: 0, color: "var(--accent)" }}
      >
        {playing ? (
          <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
            <rect x="6" y="5" width="4" height="14" rx="1" />
            <rect x="14" y="5" width="4" height="14" rx="1" />
          </svg>
        ) : (
          <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
            <path d="M8 5v14l11-7z" />
          </svg>
        )}
      </button>
    </>
  );
}

const actionLink: React.CSSProperties = { border: "none", background: "transparent", color: "var(--accent)", fontSize: 14, fontWeight: 600, cursor: "pointer", padding: 0 };

// Files-page primary Upload button (filled accent) + ghost bordered Clean-unused.
const uploadPrimaryStyle: React.CSSProperties = {
  display: "flex", alignItems: "center", gap: 6, height: 36, border: "none", borderRadius: 10,
  background: "var(--accent)", color: "var(--accent-on)", padding: "0 14px",
  fontFamily: "var(--font-sans)", fontSize: 14, fontWeight: 600, cursor: "pointer",
};
const ghostBtnStyle: React.CSSProperties = {
  display: "flex", alignItems: "center", height: 36, border: "1px solid var(--line-2)",
  borderRadius: 10, background: "transparent", color: "var(--fg-2)", padding: "0 14px",
  fontFamily: "var(--font-sans)", fontSize: 14, fontWeight: 600, cursor: "pointer",
};

function actionBtn(color: string): React.CSSProperties {
  return { border: "none", background: "transparent", color, fontSize: 13, fontWeight: 600, cursor: "pointer", padding: "6px 7px" };
}
