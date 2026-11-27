// Attachments library sheet (mobile) — lists the vault catalog (MYC1) with a
// decrypt thumbnail per row, and Insert / Rename / Delete actions. Reads through
// the shared `myne-core` attachments plugin; images are served by the in-app
// `attachment://` scheme (decrypt in RAM + re-sniff). Images/PDFs open the shared
// lightbox on tap; voice notes and MP4/WebM video get an inline play/pause tile
// (video shows a first-frame poster; no text-extraction).

import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Sheet, Banner, Spinner, Segmented, LIST_TOP } from "../../components";
import { catalogList, attachmentDelete, attachmentRename, attachmentSetFolders, attachmentUnusedList, attachmentCleanUnused, importFile, ATTACHMENT_ACCEPT, type CatalogEntry } from "../../lib/attachments";
import { attachmentSrc } from "../../lib/attachmentRef";
import { HAS_TAURI } from "../../lib/app-window";
import { formatBytes } from "../../lib/util";
import { usePrefs } from "../../lib/use-prefs";
import { TranscriptSheet } from "./TranscriptSheet";
import { showAttachmentLightbox } from "@myne/editor/attachments/lightbox";
import { renderPdfFirstPage } from "@myne/editor/attachments/pdf-render";
import { tappable } from "../a11y/tappable";
import { folderMatchesScope } from "@myne/attachment-folder-scope";

const isImage = (t: string) => t.startsWith("image/");
/** PDFs render a first-page thumbnail (MYND-477) — parity with the desktop
 *  library — instead of the generic file glyph. */
const isPdf = (t: string) => t === "application/pdf";
/** Voice notes / audio (stored as `audio/wav`): an inline play/pause tile in the
 *  row rather than a lightbox — playback, not a focused visual preview. */
const isAudio = (t: string) => t.startsWith("audio/");
/** Video (MP4/WebM, myne#168): a first-frame poster + inline play/pause tile,
 *  mirroring {@link AudioTile}; the note's inline widget is the primary player,
 *  so no lightbox surface here (kept out of {@link previewKind}). */
const isVideo = (t: string) => t.startsWith("video/");
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
  onInsertText,
  onSavedNote,
  variant = "sheet",
  topInset = false,
}: {
  onClose: () => void;
  /** When provided, each row shows an "Insert" action that embeds the
   *  attachment into the open note. Omitted for the top-level library (browse /
   *  rename / delete only). */
  onInsert?: (id: string, filename: string) => void;
  /** When provided (in-editor context), a finished audio transcript shows an
   *  "Insert transcript into note" action that appends the TEXT to the open note
   *  (MYND-563). Distinct from `onInsert`, which embeds an attachment reference.
   *  Omitted for the top-level Files library, where there is no open note. */
  onInsertText?: (text: string) => void;
  /** When provided, a transcript saved as a note is handed back so the caller
   *  can open it. Present in both entry contexts: saving a transcript is an
   *  action the Files tab offers too, where no note is open. */
  onSavedNote?: (noteId: string) => void;
  /** `"sheet"` = floating modal (in-editor insert picker). `"page"` = full
   *  bottom-tab page (the top-level Files library). */
  variant?: "sheet" | "page";
  /** The page variant pays for the status bar only when NOTHING renders above it.
   *  Under the AppHeader that header already carries the clearance, and a second
   *  inset pushed the Files title a whole header-height down the page (owner,
   *  2026-11-27 round 3: "files gibi bazı yerlerde ... çözülüyor olsun her
   *  sayfada"). */
  topInset?: boolean;
}) {
  const { t } = useTranslation();
  // Transcription visibility is gated on the pref (MYND-563; the backend
  // re-reads it host-side, so this only governs whether the action shows).
  const { prefs } = usePrefs();
  const [entries, setEntries] = useState<CatalogEntry[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [renaming, setRenaming] = useState<string | null>(null);
  // The folder scope, `null` for every folder (myne-md/myne#1075). A SUBTREE:
  // a term folder holds week folders under it, and scoping to the term means
  // the term.
  const [scope, setScope] = useState<string | null>(null);
  // The row whose folder picker is open, or null. The same shape `renaming`
  // takes, so a row shows one inline editor at a time and nothing new has to be
  // invented for a phone.
  const [moving, setMoving] = useState<string | null>(null);
  const [renameText, setRenameText] = useState("");
  // Clean-unused review: the unused entries being confirmed for erase, or null.
  const [cleanup, setCleanup] = useState<CatalogEntry[] | null>(null);
  const [cleaning, setCleaning] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  // Direct upload from the sheet/page (no longer paperclip-only).
  const [uploading, setUploading] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  // The audio attachment whose transcript sheet is open, or null (myne-md/myne#886).
  const [transcriptFor, setTranscriptFor] = useState<CatalogEntry | null>(null);

  async function reviewUnused() {
    setError(null);
    setNote(null);
    if (!HAS_TAURI) {
      setNote(t("attachments.needsApp"));
      return;
    }
    try {
      const unused = await attachmentUnusedList();
      if (unused.length === 0) setNote(t("attachments.noUnused"));
      else setCleanup(unused);
    } catch {
      setError(t("attachments.scanError"));
    }
  }

  async function eraseUnused() {
    if (cleanup === null) return;
    setCleaning(true);
    try {
      const res = await attachmentCleanUnused(cleanup.map((e) => e.id));
      setCleanup(null);
      setNote(t("attachments.erasedToast", { count: res.deleted }));
      load();
    } catch {
      setError(t("attachments.eraseError"));
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
      .catch(() => setError(t("attachments.readError")));
  }, [t]);
  useEffect(() => load(), [load]);

  /** Import a picked file into the vault (MYA1) and refresh the catalog so the
   *  new attachment appears in-place — the user no longer has to go through the
   *  editor paperclip to add a file. */
  async function upload(file: File) {
    if (!HAS_TAURI) {
      setError(t("attachments.needAppPreview"));
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
          ? t("attachments.tooLarge")
          : kind === "UnsupportedType"
            ? t("attachments.unsupported")
            : t("attachments.addError"),
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
      setError(t("attachments.deleteError"));
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
      setError(t("attachments.renameError"));
    }
  }

  async function moveTo(id: string, folder: string) {
    setMoving(null);
    try {
      if (HAS_TAURI) await attachmentSetFolders([{ id, folder }]);
      setEntries((es) => (es ?? []).map((e) => (e.id === id ? { ...e, folder } : e)));
    } catch {
      setError(t("attachments.folderMoveFailed"));
    }
  }

  /** Every folder the catalog already uses, sorted, so the picker names real ones. */
  const folders = [...new Set((entries ?? []).map((e) => e.folder ?? "").filter((f) => f !== ""))].sort();

  const totalUnusedBytes = (cleanup ?? []).reduce((s, e) => s + e.size, 0);

  // Shared bits between the modal (sheet) and the full-page (Files tab) render.
  // `Clean unused` is a text link in the sheet header, a ghost bordered button on
  // the Files page (where it sits beside the primary Upload).
  const cleanBtn = (style: React.CSSProperties) =>
    cleanup ? (
      <button onClick={() => setCleanup(null)} style={style}>{t("common.cancel")}</button>
    ) : (
      <button onClick={() => void reviewUnused()} style={style}>{t("attachments.library.cleanUnused")}</button>
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
        {uploading ? t("sync.join.submitting") : t("attachments.coverPicker.upload")}
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
        {t("attachments.unusedSummary", { count: cleanup.length, size: formatBytes(totalUnusedBytes) })}
      </div>
      <button
        onClick={() => void eraseUnused()}
        disabled={cleaning}
        style={{ marginTop: 12, width: "100%", height: 48, border: "none", borderRadius: 8, background: "var(--danger)", color: "#fff", fontFamily: "var(--font-sans)", fontSize: 15, fontWeight: 600, cursor: "pointer", opacity: cleaning ? 0.5 : 1 }}
      >
        {t("attachments.eraseCta", { count: cleanup.length })}
      </button>
    </div>
  );

  // The folder scope, as the segmented primitive. Only when the catalog actually
  // holds folders: a library where every file sits at the root has nothing to
  // scope by, and a control of one option would be chrome that never changes
  // anything. The value is the folder path itself (`""` for every folder), so a
  // scope and a move name the same thing.
  const scopeChips = !cleanup && folders.length > 0 && (
    <div data-testid="files.folder-scope" style={{ flex: "none", paddingTop: "var(--space-2)" }}>
      <Segmented
        options={[t("attachments.folderAll"), ...folders.map((f) => f.replace(/\/$/, ""))]}
        optionValues={["", ...folders]}
        active={scope === null ? 0 : folders.indexOf(scope) + 1}
        // The primitive reports the INDEX, and `optionValues` is what makes that
        // index addressable in a test; the mapping back to a folder path stays
        // here, where the scope lives.
        onChange={(index) => setScope(index === 0 ? null : (folders[index - 1] ?? null))}
        ariaLabel={t("attachments.folderAll")}
        testIdPrefix="files.folder-scope"
      />
    </div>
  );

  const listInner = (
    <>
        {scopeChips}
        {cleanup ? (
          cleanup.map((e) => (
            <div key={e.id} style={{ display: "flex", alignItems: "center", gap: 12, padding: "10px 4px", borderTop: "1px solid var(--line-1)" }}>
              <div style={{ width: 36, height: 36, borderRadius: 8, background: "var(--bg-2)", flexShrink: 0, overflow: "hidden", display: "flex", alignItems: "center", justifyContent: "center" }}>
                {isImage(e.content_type) ? (
                  <img src={attachmentSrc(e.id)} alt="" style={{ width: "100%", height: "100%", objectFit: "cover" }} />
                ) : isPdf(e.content_type) ? (
                  <PdfThumbnail id={e.id} size={36} glyphSize={18} />
                ) : (
                  <FileGlyph size={18} />
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
            {t("attachments.emptyState")}
          </div>
        ) : (
          entries
            .filter((e) => scope === null || folderMatchesScope(e.folder ?? "", scope))
            .map((e) => {
            // The row's activation depends on what the file IS: an image/PDF
            // opens the shared lightbox, an audio attachment opens its transcript
            // sheet (myne-md/myne#886: the row is the entry point, replacing the
            // permanent per-row Transcribe button), and video is inert (it plays
            // in its tile). An audio row stays tappable even with speech-to-text
            // off: the setting hides the Transcribe ACTION, and reading a
            // transcript that already exists needs no engine (the sheet decides
            // which of the two it is showing, after probing the cache).
            const rowActivate =
              isAudio(e.content_type)
                ? () => setTranscriptFor(e)
                : previewKind(e.content_type)
                  ? () => openPreview(e)
                  : undefined;
            return (
            <div key={e.id} style={{ borderTop: "1px solid var(--line-1)" }}>
            <div style={{ display: "flex", alignItems: "center", gap: 12, padding: "10px 4px" }}>
              <div
                // Conditionally a control (myne#728, task 16): audio and video
                // tiles carry their own transport inside, so the thumbnail is
                // not a preview target for them and must not announce itself
                // as one. `tappable` returns null there and the div stays a
                // plain box.
                //
                // Labelled, unlike every row below, and this is the case the
                // helper's comment warns about in reverse: the tile's contents
                // are an `<img alt="">` or a glyph, so there IS no text to take
                // a name from.
                // Conditionally a control (myne#728, task 16), and only when the
                // lightbox can actually show the file: audio and video carry
                // their own transport inside the tile, and a generic file has no
                // preview at all, so neither may announce itself as one (a
                // "Preview invoice.zip" button that does nothing is worse than
                // no button). `tappable` returns null when `onActivate` is
                // absent, so the div stays a plain box.
                //
                // Labelled, unlike every row below, and this is the case the
                // helper's comment warns about in reverse: the tile's contents
                // are an `<img alt="">` or a glyph, so there IS no text to take
                // a name from.
                {...(tappable({
                  onActivate:
                    previewKind(e.content_type) === null ? undefined : () => openPreview(e),
                  label: t("attachments.library.previewNamed", { name: e.filename }),
                }) ?? {})}
                style={{ width: 44, height: 44, borderRadius: 8, background: "var(--bg-2)", flexShrink: 0, overflow: "hidden", display: "flex", alignItems: "center", justifyContent: "center", cursor: previewKind(e.content_type) ? "pointer" : "default" }}
              >
                {isImage(e.content_type) ? (
                  <img src={attachmentSrc(e.id)} alt="" style={{ width: "100%", height: "100%", objectFit: "cover" }} />
                ) : isAudio(e.content_type) ? (
                  <AudioTile id={e.id} filename={e.filename} />
                ) : isVideo(e.content_type) ? (
                  <VideoTile id={e.id} filename={e.filename} />
                ) : isPdf(e.content_type) ? (
                  <PdfThumbnail id={e.id} size={44} glyphSize={20} />
                ) : (
                  <FileGlyph size={20} />
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
                  <div
                {...(tappable({ onActivate: rowActivate }) ?? {})}
                data-testid="files.row-open"
                data-attachment-id={e.id}
                style={{ cursor: rowActivate ? "pointer" : "default" }}
              >
                    <div style={{ fontSize: 15, color: "var(--fg-1)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{e.filename}</div>
                    <div style={{ fontSize: 12, color: "var(--fg-3)" }}>{formatBytes(e.size)}</div>
                  </div>
                )}
              </div>
              {moving === e.id && (
                <div data-testid="files.row-folder" style={{ flexShrink: 0, maxWidth: "50%" }}>
                  <Segmented
                    options={[t("attachments.folderRoot"), ...folders.map((f) => f.replace(/\/$/, ""))]}
                    optionValues={["", ...folders]}
                    active={folders.indexOf(e.folder ?? "") + 1}
                    onChange={(index) => void moveTo(e.id, index === 0 ? "" : (folders[index - 1] ?? ""))}
                    ariaLabel={t("attachments.folderPickerAria", { name: e.filename })}
                    testIdPrefix={`files.row-folder.${e.id}`}
                  />
                </div>
              )}
              {renaming !== e.id && moving !== e.id && (
                <div
                  data-testid={`files.row-actions.${e.id}`}
                  style={{ display: "flex", gap: 2, flexShrink: 0 }}
                >
                  {onInsert && <button onClick={() => onInsert(e.id, e.filename)} style={actionBtn("var(--accent)")}>{t("attachments.insert")}</button>}
                  {/* A raw button, like the three beside it: the row's actions are
                      ONE visual set rendered through `actionBtn`, and converting
                      only the new one would make the row inconsistent. Converting
                      all four to the primitive is its own change (myne-md/myne#1075). */}
                  <button onClick={() => setMoving(e.id)} style={actionBtn("var(--fg-2)")}>{t("attachments.move")}</button>
                  <button onClick={() => { setRenaming(e.id); setRenameText(e.filename); }} style={actionBtn("var(--fg-2)")}>{t("common.rename")}</button>
                  <button onClick={() => void remove(e.id)} style={actionBtn("var(--danger)")}>{t("attachments.deleteDialog.delete")}</button>
                </div>
              )}
            </div>
            </div>
            );
          })
        )}
    </>
  );

  const title = cleanup ? t("attachments.library.cleanUnused") : variant === "page" ? t("settings.shell.panels.files") : t("attachments.library.title");

  // The transcript reader is mounted in BOTH entry contexts (the full-screen
  // Files page and the in-editor insert sheet). Its own Sheet floats above this
  // one, so it is rendered here once rather than duplicated per branch.
  const transcriptSheet = transcriptFor !== null && (
    <TranscriptSheet
      attachmentId={transcriptFor.id}
      filename={transcriptFor.filename}
      transcriptionEnabled={prefs.transcription_enabled}
      onInsertText={onInsertText}
      onSavedNote={onSavedNote}
      onClose={() => setTranscriptFor(null)}
    />
  );

  if (variant === "page") {
    return (
      <>
        {uploadInput}
        {/* Sits under the shared AppHeader (Files tab), so no safe-area top here. */}
        <div data-testid="files.page" style={{ flex: "none", padding: `${topInset ? LIST_TOP : "8px"} 20px 0` }}>
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
        {transcriptSheet}
      </>
    );
  }

  return (
    <>
    <Sheet onClose={onClose} style={{ maxHeight: "82%", display: "flex", flexDirection: "column", overflow: "hidden" }}>
      {uploadInput}
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8, flex: "none" }}>
        <span style={{ width: 90 }}>{uploadBtn("link")}</span>
        <span style={{ fontSize: 17, fontWeight: 600, color: "var(--fg-1)" }}>{title}</span>
        <span style={{ width: 90, textAlign: "end" }}>{cleanBtn(actionLink)}</span>
      </div>
      {banner}
      {cleanupPanel}
      <div style={{ marginTop: 12, overflowY: "auto", flex: 1, minHeight: 0 }}>{listInner}</div>
    </Sheet>
    {transcriptSheet}
    </>
  );
}

/** Inline play/pause tile for a voice note / audio attachment — the row thumbnail
 *  slot (44×44). Mirrors the desktop library's AudioThumbnail: a hidden `<audio>`
 *  streams the decrypted bytes from the in-app `attachment://` scheme (allowed by
 *  the CSP `media-src`), and playback is paused on unmount so the sound stops —
 *  and the decoded buffer is released — when the row scrolls out or the tab
 *  closes (playback-residue discipline). */
function AudioTile({ id, filename }: { id: string; filename: string }) {
  const { t } = useTranslation();
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
        aria-label={playing ? t("attachments.pauseLabel", { filename }) : t("attachments.playLabel", { filename })}
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

/** First-frame poster + inline play/pause tile for a video attachment (MP4/WebM,
 *  myne#168) — the row thumbnail slot (44×44). Mirrors {@link AudioTile}: a
 *  `<video preload="metadata">` (served by the in-app `attachment://` scheme,
 *  allowed by the CSP `media-src`) paints the first frame as a poster and plays
 *  in place on tap; playback is paused on unmount so the decode buffer is released
 *  when the row scrolls out or the tab closes (playback-residue discipline). The
 *  note's inline widget is the primary player; an undecodable file (e.g. WebM
 *  under iOS WKWebView) simply shows no frame here and degrades to the file card
 *  in the note. */
function VideoTile({ id, filename }: { id: string; filename: string }) {
  const { t } = useTranslation();
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const [playing, setPlaying] = useState(false);

  // Stop playback (release the decode buffer) when the tile unmounts.
  useEffect(() => {
    const video = videoRef.current;
    return () => video?.pause();
  }, []);

  const toggle = (ev: React.MouseEvent) => {
    // Don't let the tap bubble to the row (openPreview / rename) or select text.
    ev.preventDefault();
    ev.stopPropagation();
    const video = videoRef.current;
    if (video === null) return;
    if (video.paused) {
      void video.play();
      setPlaying(true);
    } else {
      video.pause();
      setPlaying(false);
    }
  };

  return (
    <button
      type="button"
      onClick={toggle}
      data-testid="files.video-play"
      data-attachment-id={id}
      aria-label={playing ? t("attachments.pauseLabel", { filename }) : t("attachments.playLabel", { filename })}
      style={{ width: "100%", height: "100%", border: "none", background: "transparent", padding: 0, position: "relative", cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center", overflow: "hidden" }}
    >
      <video
        ref={videoRef}
        src={attachmentSrc(id)}
        preload="metadata"
        playsInline
        onEnded={() => setPlaying(false)}
        style={{ width: "100%", height: "100%", objectFit: "cover" }}
      />
      {!playing && (
        <span
          aria-hidden="true"
          style={{ position: "absolute", inset: 0, display: "flex", alignItems: "center", justifyContent: "center", background: "rgba(0,0,0,0.28)", color: "#fff" }}
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
            <path d="M8 5v14l11-7z" />
          </svg>
        </span>
      )}
    </button>
  );
}

/** The generic document glyph — the always-works fallback for non-image,
 *  non-audio files and for a PDF whose first page can't render. */
function FileGlyph({ size = 20 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden="true">
      <path d="M14 3v5h5M7 3h8l5 5v11a1 1 0 0 1-1 1H7a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1z" fill="none" stroke="var(--fg-3)" strokeWidth="1.6" strokeLinejoin="round" />
    </svg>
  );
}

/** PDF tile: renders the decrypted first page to a canvas via the shared
 *  `renderPdfFirstPage()` (SYNC-5) and paints it as an `<img>` data URL — the
 *  same reusable render path the desktop library uses (MYND-477). Any failure
 *  (pdf.js absent, parse error, unmount abort) falls back to {@link FileGlyph};
 *  `renderPdfFirstPage` rejects rather than throwing, so the catch is the
 *  mandatory fallback. The render is aborted on unmount (row scrolled away). */
function PdfThumbnail({ id, size, glyphSize }: { id: string; size: number; glyphSize: number }) {
  const [src, setSrc] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    const controller = new AbortController();
    let cancelled = false;
    void renderPdfFirstPage({ url: attachmentSrc(id), width: size, signal: controller.signal })
      .then((canvas) => {
        if (!cancelled) setSrc(canvas.toDataURL("image/png"));
      })
      .catch(() => {
        if (!cancelled) setFailed(true);
      });
    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [id, size]);

  // Until the first page resolves (or on any failure), show the generic glyph —
  // it doubles as the loading placeholder and the terminal fallback.
  if (failed || src === null) return <FileGlyph size={glyphSize} />;
  return <img src={src} alt="" style={{ width: "100%", height: "100%", objectFit: "cover" }} />;
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
