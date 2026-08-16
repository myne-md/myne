import { useEffect, useState, type CSSProperties } from "react";
import { useTranslation } from "react-i18next";
import { Sheet } from "../../../../components";
import { catalogList, importFile, type CatalogEntry } from "../../../../lib/attachments";
import { attachmentSrc } from "../../../../lib/attachmentRef";
import type { CoverChoice } from "../../../../lib/setNoteCover";

/** The image content types a cover can be. Mirrors the desktop picker's own
 *  filter rather than the export allowlist: this is about what the WebView can
 *  actually paint in the grid. */
function isImage(entry: CatalogEntry): boolean {
  return entry.content_type.startsWith("image/");
}

const GRID_STYLE: CSSProperties = {
  display: "grid",
  gridTemplateColumns: "repeat(auto-fill, minmax(96px, 1fr))",
  gap: "var(--space-2)",
  maxHeight: "50vh",
  overflowY: "auto",
};

const TILE_STYLE: CSSProperties = {
  aspectRatio: "1",
  width: "100%",
  objectFit: "cover",
  borderRadius: "var(--radius-2)",
  border: "1px solid var(--line-1)",
  cursor: "pointer",
  background: "var(--paper-2)",
};

const ROW_STYLE: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: "var(--space-2)",
  marginBottom: "var(--space-3)",
};

const STATE_STYLE: CSSProperties = {
  padding: "var(--space-5) 0",
  textAlign: "center",
  color: "var(--fg-3)",
  fontSize: "var(--text-base)",
};

/**
 * Cover picker (mobile) — myne-md/myne#410.
 *
 * The phone analogue of the desktop `CoverPicker` modal, deliberately NOT a port
 * of its markup: mobile's surface convention is a bottom `Sheet`, and there is
 * no drag-and-drop. What IS shared is everything that decides bytes — the
 * catalog read, the form-C emitter and the write path — so a cover set here is
 * byte-identical to one set on a desktop.
 *
 * Upload goes through a plain file input rather than a native picker: mobile's
 * WebView hands back a `File`, and `importFile` is the same route
 * voice notes already take.
 */
export function CoverPickerSheet({
  hasCover,
  onClose,
  onPick,
  onRemove,
}: {
  hasCover: boolean;
  onClose: () => void;
  onPick: (choice: CoverChoice) => void;
  onRemove: () => void;
}) {
  const { t } = useTranslation();
  const [entries, setEntries] = useState<CatalogEntry[] | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let alive = true;
    void catalogList()
      .then((rows) => {
        if (alive) setEntries(rows.filter(isImage));
      })
      .catch(() => {
        // A catalog that cannot be read is an empty library for this purpose;
        // the empty state says so rather than showing a broken grid.
        if (alive) setEntries([]);
      });
    return () => {
      alive = false;
    };
  }, []);

  async function handleUpload(file: File): Promise<void> {
    setBusy(true);
    try {
      const imported = await importFile(file);
      onPick({ id: imported.id, filename: imported.filename });
    } catch {
      // Leave the sheet open: the user can pick an existing image instead.
    } finally {
      setBusy(false);
    }
  }

  return (
    <Sheet onClose={onClose}>
      <div style={ROW_STYLE}>
        <label
          data-testid="cover-picker.upload"
          style={{ cursor: busy ? "default" : "pointer", color: "var(--fg-1)" }}
        >
          {t("attachments.coverPicker.upload")}
          <input
            type="file"
            accept="image/*"
            disabled={busy}
            style={{ display: "none" }}
            onChange={(e) => {
              const file = e.target.files?.[0];
              if (file) void handleUpload(file);
            }}
          />
        </label>
        {hasCover && (
          <button
            type="button"
            data-testid="cover-picker.remove"
            onClick={onRemove}
            style={{ marginLeft: "auto", background: "none", border: 0, color: "var(--fg-2)" }}
          >
            {t("attachments.coverPicker.removeCover")}
          </button>
        )}
      </div>

      {entries === null ? (
        <div style={STATE_STYLE}>{t("attachments.coverPicker.loading")}</div>
      ) : entries.length === 0 ? (
        <div style={STATE_STYLE} data-testid="cover-picker.empty">
          {t("editor.cover.emptyLibraryMobile")}
        </div>
      ) : (
        <div style={GRID_STYLE}>
          {entries.map((entry) => (
            <img
              key={entry.id}
              data-testid="cover-picker.image"
              src={attachmentSrc(entry.id)}
              alt={entry.filename}
              style={TILE_STYLE}
              onClick={() => onPick({ id: entry.id, filename: entry.filename })}
            />
          ))}
        </div>
      )}
    </Sheet>
  );
}
