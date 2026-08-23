import { type ReactNode, useMemo, useState } from "react";
import {
  embedAccessibleName,
  embedWidthCss,
  type EmbedLayout,
} from "@myne/dialect/embedLayout";
import { useTranslation } from "react-i18next";
import { showAttachmentLightbox } from "@myne/editor/attachments/lightbox";
import { parseBlocks, type Block, type Inline } from "../lib/markdown";
import { attachmentSrc } from "../lib/attachmentRef";

/** Audio filename extensions rendered as an inline `<audio>` player (voice notes
 *  are `.wav`; the others are forward-safe if a compressed path is ever added). */
const AUDIO_EXTENSIONS = [".wav", ".m4a", ".mp3", ".ogg", ".oga", ".aac", ".webm"];
export const isAudioLabel = (label: string): boolean => {
  const lower = label.toLowerCase();
  return AUDIO_EXTENSIONS.some((ext) => lower.endsWith(ext));
};

/** Inline attachment embed served from the in-app `attachment://` decrypt scheme:
 *  an `<audio controls>` player for a voice note / audio file, an `<img>` for an
 *  image, falling back to a file chip when the bytes aren't renderable (e.g. a
 *  PDF) or fail to load. */
function AttachmentInline({
  id,
  label,
  layout,
}: {
  id: string;
  label: string;
  layout: EmbedLayout;
}) {
  const { t } = useTranslation();
  const [failed, setFailed] = useState(false);
  if (failed) {
    return (
      <span style={{ display: "inline-flex", alignItems: "center", gap: 6, border: "1px solid var(--line-2)", borderRadius: 8, background: "var(--bg-2)", padding: "3px 10px", fontSize: 14, color: "var(--fg-2)", verticalAlign: "middle" }}>
        <svg width="14" height="14" viewBox="0 0 24 24" style={{ flexShrink: 0 }}>
          <path d="M14 3v5h5M7 3h8l5 5v11a1 1 0 0 1-1 1H7a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1z" fill="none" stroke="var(--fg-3)" strokeWidth="1.6" strokeLinejoin="round" />
        </svg>
        {label || t("markdown.attachmentFallback")}
      </span>
    );
  }
  if (isAudioLabel(label)) {
    return (
      <audio
        data-testid="attachment-audio"
        controls
        src={attachmentSrc(id)}
        onError={() => setFailed(true)}
        style={{ display: "block", width: "100%", maxWidth: 360, margin: "8px 0" }}
      />
    );
  }
  // Tap opens the shared @myne/editor lightbox (zoom/pan, MYND-594). Before this
  // there was no handler at all — an image could not be inspected on a phone.
  const src = attachmentSrc(id);
  // `docs/spec/wikilink.md` §5.1 has two clauses and the shared resolver owns
  // both, because this surface had only the first: an authored alt is the
  // accessible name, AND an authored EMPTY alt marks the media decorative,
  // which must not fall back to reading the filename out loud.
  //
  // What it does NOT carry is a dropped-segment report, and neither does the
  // token. §5.1's persistent report belongs to the surface that can FIX the
  // segment, which is the desktop editor's embed overflow menu; mobile has no
  // embed-layout authoring path, so a marker here would tell the reader about
  // something they cannot act on from this device.
  const { name, decorative } = embedAccessibleName(layout, label);
  // The author's width and alignment, applied the way `applyEmbedLayout` does in
  // the editor (myne-md/myne#518): a length or a percentage with `max-width` at
  // its side, and alignment as auto margins on a block image. A note laid out on
  // desktop rendered at default size here, which `dialect/src/index.ts` says is
  // exactly what the shared module exists to prevent. The width itself comes
  // from `embedWidthCss` so the value and its `max-width` cap are decided once
  // for all three renderers rather than re-derived here.
  const width = embedWidthCss(layout) ?? undefined;
  return (
    <img
      src={src}
      alt={name}
      role={decorative ? "presentation" : undefined}
      data-testid="markdown.image"
      onError={() => setFailed(true)}
      onClick={() => showAttachmentLightbox({ url: src, alt: name, id })}
      style={{
        display: "block",
        maxWidth: "100%",
        borderRadius: 8,
        margin: "8px 0",
        cursor: "zoom-in",
        ...(width === undefined ? {} : { width }),
        ...(layout.heightPx === null ? {} : { height: `${layout.heightPx}px` }),
        ...(layout.align === "left"
          ? { marginLeft: 0, marginRight: "auto" }
          : layout.align === "right"
            ? { marginLeft: "auto", marginRight: 0 }
            : layout.align === "center"
              ? { marginLeft: "auto", marginRight: "auto" }
              : {}),
      }}
    />
  );
}

function renderInline(tokens: Inline[], onOpenWikilink: (target: string) => void): ReactNode[] {
  return tokens.map((t, i) => {
    switch (t.kind) {
      case "bold":
        return (
          <strong key={i} style={{ fontWeight: 700 }}>
            {t.text}
          </strong>
        );
      case "italic":
        return (
          <em key={i} style={{ fontStyle: "italic" }}>
            {t.text}
          </em>
        );
      case "code":
        // Isolate the neutral code run so an LTR snippet can't reorder the RTL
        // line around it (mirror of the desktop `.cm-inline-code`).
        return (
          <code key={i} style={{ fontFamily: "var(--font-mono)", fontSize: "0.9em", background: "var(--bg-2)", borderRadius: 4, padding: "1px 5px", unicodeBidi: "isolate" }}>
            {t.text}
          </code>
        );
      case "link":
        return (
          <span key={i} style={{ color: "var(--accent)", unicodeBidi: "isolate" }}>
            {t.text}
          </span>
        );
      case "wikilink":
        return (
          <span
            key={i}
            onClick={() => onOpenWikilink(t.target)}
            style={{ color: "var(--accent)", cursor: "pointer", textDecoration: "underline", textUnderlineOffset: 2, unicodeBidi: "isolate" }}
          >
            {t.label}
          </span>
        );
      case "attachment":
        return (
          <AttachmentInline key={i} id={t.id} label={t.label} layout={t.layout} />
        );
      default:
        return <span key={i}>{t.text}</span>;
    }
  });
}

function renderBlock(b: Block, key: number, base: number, onOpenWikilink: (target: string) => void): ReactNode {
  switch (b.kind) {
    case "heading": {
      const scale = [1.6, 1.4, 1.2, 1.08, 1, 0.95][b.level - 1] ?? 1;
      // `dir="auto"` on every block container so each block resolves its own
      // direction from its first strong character — an RTL heading right-aligns,
      // an LTR one left-aligns, in the same note.
      return (
        <div key={key} dir="auto" style={{ fontSize: Math.round(base * scale), fontWeight: 700, lineHeight: 1.3, color: "var(--fg-display)", margin: b.level <= 2 ? "18px 0 8px" : "14px 0 6px" }}>
          {renderInline(b.content, onOpenWikilink)}
        </div>
      );
    }
    case "paragraph":
      return (
        <p key={key} dir="auto" style={{ margin: "0 0 12px", lineHeight: 1.65 }}>
          {renderInline(b.content, onOpenWikilink)}
        </p>
      );
    case "code":
      return (
        <pre key={key} dir="auto" style={{ margin: "0 0 12px", background: "var(--bg-2)", border: "1px solid var(--line-1)", borderRadius: 8, padding: "12px 14px", overflowX: "auto", fontFamily: "var(--font-mono)", fontSize: Math.round(base * 0.9), lineHeight: 1.5 }}>
          {b.text}
        </pre>
      );
    case "quote":
      // Logical inset (padding + border both on the inline-start) so the quote
      // bar sits on the right under RTL, matching the text side.
      return (
        <div key={key} dir="auto" style={{ margin: "0 0 12px", borderInlineStart: "3px solid var(--line-2)", paddingBlock: "2px", paddingInlineStart: 14, color: "var(--fg-2)", lineHeight: 1.6 }}>
          {renderInline(b.content, onOpenWikilink)}
        </div>
      );
    case "list": {
      const Tag = b.ordered ? "ol" : "ul";
      return (
        <Tag key={key} dir="auto" style={{ margin: "0 0 12px", paddingInlineStart: 22, lineHeight: 1.65 }}>
          {b.items.map((it, j) => (
            <li key={j} dir="auto" style={{ marginBottom: 4 }}>
              {renderInline(it, onOpenWikilink)}
            </li>
          ))}
        </Tag>
      );
    }
    case "hr":
      return <div key={key} style={{ height: 1, background: "var(--line-1)", margin: "18px 0" }} />;
    default:
      return null;
  }
}

/**
 * Read-only Markdown render for the editor's Reading mode. Renders a React token
 * tree (never raw HTML) so untrusted note content carries no XSS. Wikilinks are
 * tappable via `onOpenWikilink`.
 */
export function MarkdownView({
  text,
  onOpenWikilink,
  fontFamily = "var(--font-sans)",
  fontSize = 16,
}: {
  text: string;
  onOpenWikilink: (target: string) => void;
  fontFamily?: string;
  fontSize?: number;
}) {
  const { t } = useTranslation();
  const blocks = useMemo(() => parseBlocks(text), [text]);
  return (
    <div style={{ flex: 1, minHeight: 0, overflowY: "auto", padding: "18px 22px", color: "var(--fg-1)", fontFamily, fontSize, boxSizing: "border-box" }}>
      {blocks.length === 0 ? (
        <div style={{ color: "var(--fg-3)" }}>{t("markdown.nothingToPreview")}</div>
      ) : (
        blocks.map((b, i) => renderBlock(b, i, fontSize, onOpenWikilink))
      )}
    </div>
  );
}
