// Attachment thumbnail (MYND-170 / MYND-164). Renders:
//   - image/* (raster + SVG) via `<img src={attachmentUrl(id)}>` — the
//     `attachment://` handler decrypts in memory + serves an allowlisted
//     type; no plaintext touches disk (SYNC-4).
//   - application/pdf as the rendered FIRST PAGE via the editor sub-feature's
//     reusable `renderPdfFirstPage()` (SYNC-5), degrading to a generic PDF icon
//     when pdf.js is unavailable / fails / rejects. The render runs fully
//     in-memory off the decrypted `attachment://` bytes; PDF scripting stays
//     disabled (see `editor/attachments/pdf-render.ts`).
//   - anything else / a failed image load → a generic file icon.

import { useEffect, useRef, useState, type CSSProperties } from "react";
import { Icon } from "../primitives/Icon";
import { attachmentUrl } from "../../notes/attachmentRef";
import { renderPdfFirstPage } from "../../editor/attachments/pdf-render";
import { kindOf } from "./format";

interface AttachmentThumbnailProps {
  id: string;
  contentType: string;
  filename: string;
  /** Square edge length in px. */
  size: number;
}

const ICON_WRAP_STYLE: CSSProperties = {
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  width: "100%",
  height: "100%",
  color: "var(--fg-3)",
  background: "var(--paper-2)",
};

const IMG_STYLE: CSSProperties = {
  width: "100%",
  height: "100%",
  objectFit: "contain",
  display: "block",
  background: "var(--paper-2)",
};

/** Generic PDF / file icon — the always-works fallback (SYNC-5). */
function FileIcon({ size, label }: { size: number; label: string }) {
  return (
    <div style={ICON_WRAP_STYLE} aria-label={label}>
      <Icon name="file-text" size={Math.round(size * 0.42)} />
    </div>
  );
}

/**
 * PDF tile: renders the decrypted first page to a canvas via the editor
 * sub-feature's reusable `renderPdfFirstPage()` (SYNC-5), then paints it as an
 * `<img>` data URL. Any failure (pdf.js absent, parse error, abort) falls back
 * to the generic PDF icon — `renderPdfFirstPage` rejects rather than throwing,
 * so the catch is the mandatory fallback path. The render is aborted on unmount
 * (e.g., the tile scrolls out of a long grid) via the AbortController.
 */
function PdfThumbnail({ id, size }: { id: string; size: number }) {
  const [src, setSrc] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  // Keep the resolved width stable per mount; the grid box is square-ish but a
  // crisp first-page raster is enough for a thumbnail.
  const widthRef = useRef(size);

  useEffect(() => {
    const controller = new AbortController();
    let cancelled = false;
    void renderPdfFirstPage({
      url: attachmentUrl(id),
      width: widthRef.current,
      signal: controller.signal,
    })
      .then((canvas) => {
        if (cancelled) return;
        setSrc(canvas.toDataURL("image/png"));
      })
      .catch(() => {
        if (!cancelled) setFailed(true);
      });
    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [id]);

  // Until the first page resolves (`src === null`) OR on any failure, show the
  // generic PDF icon — it's both the rendering placeholder (replaced in place
  // the moment the page rasterizes) and the terminal failure fallback.
  if (failed || src === null) return <FileIcon size={size} label="PDF document" />;
  return <img src={src} alt="PDF first page" style={IMG_STYLE} />;
}

export function AttachmentThumbnail({
  id,
  contentType,
  filename,
  size,
}: AttachmentThumbnailProps) {
  const kind = kindOf(contentType);
  const [imageFailed, setImageFailed] = useState(false);

  if (kind === "pdf") {
    return <PdfThumbnail id={id} size={size} />;
  }

  if (kind === "image" && !imageFailed) {
    return (
      <img
        src={attachmentUrl(id)}
        alt={filename}
        onError={() => setImageFailed(true)}
        style={IMG_STYLE}
      />
    );
  }

  // Non-image / image that failed to load → generic file icon.
  return <FileIcon size={size} label="File" />;
}
