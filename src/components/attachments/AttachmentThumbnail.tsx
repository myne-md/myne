// Attachment thumbnail (MYND-170 / MYND-164). Renders:
//   - image/* (raster + SVG) via `<img src={attachmentUrl(id)}>` — the
//     `attachment://` handler decrypts in memory + serves an allowlisted
//     type; no plaintext touches disk (SYNC-4).
//   - application/pdf as the rendered FIRST PAGE via the editor sub-feature's
//     reusable `renderPdfFirstPage()` (SYNC-5), degrading to a generic PDF icon
//     when pdf.js is unavailable / fails / rejects. The render runs fully
//     in-memory off the decrypted `attachment://` bytes; PDF scripting stays
//     disabled (see `editor/attachments/pdf-render.ts`).
//   - audio/* as a styled, inline-playable tile (a centered play/pause button
//     over a hidden `<audio>` fed from `attachment://`, MYND-259).
//   - anything else / a failed image load → a generic file icon.

import {
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type MouseEvent,
} from "react";
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

const AUDIO_WRAP_STYLE: CSSProperties = {
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  width: "100%",
  height: "100%",
  background: "var(--paper-2)",
};

const AUDIO_BTN_STYLE: CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  justifyContent: "center",
  width: "44px",
  height: "44px",
  padding: 0,
  borderRadius: "999px",
  border: "none",
  background: "var(--accent)",
  color: "var(--accent-on, #fff)",
  cursor: "pointer",
};

/**
 * Audio tile: a centered play/pause button over a hidden `<audio>` element fed
 * from `attachment://<id>` (decrypted in-memory, allowlist-fenced as audio/wav,
 * MYND-259). Clicking plays inline in the library — the button stops event
 * propagation so it never triggers the tile's jump/preview affordance.
 */
function AudioThumbnail({ id, filename }: { id: string; filename: string }) {
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const [playing, setPlaying] = useState(false);

  // Pause on unmount (tile scrolled out / library closed) so audio never plays
  // on after its tile is gone.
  useEffect(() => {
    const audio = audioRef.current;
    return () => audio?.pause();
  }, []);

  const toggle = (e: MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
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
    <div style={AUDIO_WRAP_STYLE} aria-label={`Audio: ${filename}`}>
      <audio
        ref={audioRef}
        src={attachmentUrl(id)}
        preload="none"
        onEnded={() => setPlaying(false)}
        style={{ display: "none" }}
      />
      <button
        type="button"
        onClick={toggle}
        aria-label={playing ? "Pause" : "Play"}
        style={AUDIO_BTN_STYLE}
      >
        <Icon name={playing ? "pause" : "play"} size={18} />
      </button>
    </div>
  );
}

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

  if (kind === "audio") {
    return <AudioThumbnail id={id} filename={filename} />;
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
