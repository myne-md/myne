// `<CoverPicker>` — pick a cover image for a cards-view note (Saved Views
// follow-on). A desktop modal carve-out (ModalShell, same as TemplatesManager)
// with THREE entry paths in one surface:
//   1. an image grid of the vault's existing attachments (`catalogList`, filtered
//      to `image/*`) — click a tile to choose it;
//   2. "Upload" — the native file picker → `attachment_import` → choose;
//   3. drag-drop a file anywhere on the modal body → import → choose.
//
// The component is presentation + import only: it hands the chosen attachment
// `{ id, filename }` to `onPick`; the caller (PaneView's ViewHost) writes the
// note's frontmatter via `setNoteCover`. `onRemove` (when a cover already exists)
// clears it.
//
// Reuses the attachment epic's pieces verbatim: `AttachmentThumbnail` for the
// image render (`attachment://` decrypt), `importMany` for the import IPC,
// `kindOf` for the image filter. No new capability, no new IPC.

import {
  useCallback,
  useEffect,
  useState,
  type CSSProperties,
  type DragEvent,
} from "react";
import { useTranslation } from "react-i18next";
import { pickFiles } from "../../platform/filePicker";
import { ModalShell } from "../primitives/ModalShell";
import { Button } from "../primitives/Button";
import { AttachmentThumbnail } from "./AttachmentThumbnail";
import { kindOf } from "./format";
import { catalogList, type CatalogEntry } from "../../lib/attachments";
import { importMany, type ImportSource } from "../../editor/attachments/insert";

/** The minimal attachment shape the caller needs to write a cover reference. */
export interface CoverChoice {
  id: string;
  filename: string;
}

export interface CoverPickerProps {
  open: boolean;
  /** Whether the note already has a cover (enables the "Remove cover" action). */
  hasCover: boolean;
  onClose: () => void;
  /** Chosen attachment → caller writes the note's cover frontmatter. */
  onPick: (choice: CoverChoice) => void;
  /** Clear the note's cover (only meaningful when `hasCover`). */
  onRemove: () => void;
}

const TOOLBAR_STYLE: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: "var(--space-3)",
  padding: "var(--space-3) var(--space-5)",
  borderBottom: "1px solid var(--line-1)",
  flex: "0 0 auto",
};

const BODY_STYLE: CSSProperties = {
  flex: 1,
  minHeight: 0,
  overflowY: "auto",
  padding: "var(--space-4) var(--space-5)",
};

const GRID_STYLE: CSSProperties = {
  display: "grid",
  gridTemplateColumns: "repeat(auto-fill, minmax(120px, 1fr))",
  gap: "var(--space-3)",
};

const TILE_STYLE: CSSProperties = {
  display: "block",
  width: "100%",
  aspectRatio: "1 / 1",
  padding: 0,
  border: "1px solid var(--line-2)",
  borderRadius: "var(--radius-2)",
  overflow: "hidden",
  background: "var(--paper-2)",
  cursor: "pointer",
};

const STATE_STYLE: CSSProperties = {
  textAlign: "center",
  color: "var(--fg-3)",
  fontSize: 13,
  lineHeight: 1.6,
  padding: "12vh var(--space-5) 0",
};

const DROP_HINT_STYLE: CSSProperties = {
  ...STATE_STYLE,
  border: "1px dashed var(--accent)",
  borderRadius: "var(--radius-2)",
  padding: "var(--space-5)",
  margin: "var(--space-4)",
  color: "var(--accent)",
};

/** Read a dropped/selected File into the `{kind:"bytes"}` import source. */
async function fileToSource(file: File): Promise<ImportSource> {
  const buf = new Uint8Array(await file.arrayBuffer());
  return { kind: "bytes", bytes: Array.from(buf), filename: file.name || null };
}

function firstOk(
  outcomes: Awaited<ReturnType<typeof importMany>>,
): CoverChoice | null {
  for (const o of outcomes) {
    if (o.ok) return { id: o.attachment.id, filename: o.attachment.filename };
  }
  return null;
}

export function CoverPicker({
  open,
  hasCover,
  onClose,
  onPick,
  onRemove,
}: CoverPickerProps) {
  const { t } = useTranslation();
  // `null` = loading; `[]` = loaded-but-empty.
  const [images, setImages] = useState<CatalogEntry[] | null>(null);
  const [dragging, setDragging] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!open) return;
    setImages(null);
    void catalogList()
      .then((entries) =>
        setImages(entries.filter((e) => kindOf(e.content_type) === "image")),
      )
      .catch(() => setImages([]));
  }, [open]);

  const handleUpload = useCallback(async () => {
    setBusy(true);
    try {
      // Through the picker seam, not `dialog.open` (phase3-web-client task 76):
      // the result is an opaque handle rather than a path, so this compiles for
      // a browser instead of handing a filename to something expecting a path.
      const selected = await pickFiles({ multiple: false });
      if (selected === null || selected.length === 0) return; // cancelled
      const sources: ImportSource[] = selected.map((file) => ({ kind: "picked", file }));
      const choice = firstOk(await importMany(sources));
      if (choice !== null) onPick(choice);
    } catch {
      /* picker / import failure surfaces via backend tracing */
    } finally {
      setBusy(false);
    }
  }, [onPick]);

  const handleDrop = useCallback(
    async (e: DragEvent<HTMLDivElement>) => {
      e.preventDefault();
      setDragging(false);
      const files = Array.from(e.dataTransfer.files ?? []);
      if (files.length === 0) return;
      setBusy(true);
      try {
        const sources = await Promise.all(files.map(fileToSource));
        const choice = firstOk(await importMany(sources));
        if (choice !== null) onPick(choice);
      } catch {
        /* import failure surfaces via backend tracing */
      } finally {
        setBusy(false);
      }
    },
    [onPick],
  );

  return (
    <ModalShell
      open={open}
      title={t("attachments.coverPicker.title")}
      onClose={onClose}
      labelId="cover-picker-title"
      width={560}
      height={560}
      closeLabel={t("attachments.coverPicker.close")}
    >
      <div style={TOOLBAR_STYLE}>
        <Button
          variant="primary"
          icon="file-plus"
          data-testid="cover-picker.upload"
          disabled={busy}
          onClick={() => void handleUpload()}
        >
          {t("attachments.coverPicker.upload")}
        </Button>
        {hasCover && (
          <Button
            variant="ghost"
            data-testid="cover-picker.remove"
            onClick={onRemove}
          >
            {t("attachments.coverPicker.removeCover")}
          </Button>
        )}
      </div>

      <div
        data-testid="cover-picker.modal"
        style={BODY_STYLE}
        onDragOver={(e) => {
          e.preventDefault();
          setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={(e) => void handleDrop(e)}
      >
        {dragging ? (
          <div style={DROP_HINT_STYLE}>{t("attachments.coverPicker.dropHint")}</div>
        ) : images === null ? (
          <div style={STATE_STYLE}>{t("attachments.coverPicker.loading")}</div>
        ) : images.length === 0 ? (
          <div style={STATE_STYLE} data-testid="cover-picker.empty">
            {t("attachments.coverPicker.empty")}
          </div>
        ) : (
          <div style={GRID_STYLE}>
            {images.map((img) => (
              <button
                key={img.id}
                type="button"
                data-testid="cover-picker.image"
                data-att-id={img.id}
                title={img.filename}
                style={TILE_STYLE}
                disabled={busy}
                onClick={() => onPick({ id: img.id, filename: img.filename })}
              >
                <AttachmentThumbnail
                  id={img.id}
                  contentType={img.content_type}
                  filename={img.filename}
                  size={120}
                />
              </button>
            ))}
          </div>
        )}
      </div>
    </ModalShell>
  );
}
