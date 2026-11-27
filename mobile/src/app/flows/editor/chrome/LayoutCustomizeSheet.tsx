import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { Icon, Sheet } from "../../../../components";

/** The "reorder and hide" sheet both device-local layouts share: the expanded
 *  size class's navigation rail (`chrome/NavRibbon.tsx`) and the home screen's
 *  cards (`editor/HomeSurfaceMobile.tsx`).
 *
 *  One component rather than two copies: the rows are the whole editing
 *  affordance (a drag handle the browser cannot drag, two 40pt arrows and a
 *  switch), and a second implementation would drift in exactly the details that
 *  make it usable — the disabled ends, the announced switch state, the label
 *  truncation. The store stays with the caller, so this owns presentation only. */

export interface CustomizeRow {
  id: string;
  label: string;
  icon: ReactNode;
  /** False when the destination cannot appear right now (no open note, AI off).
   *  The row still renders, dimmed, so the set never looks shorter than the
   *  vocabulary. */
  supported: boolean;
  shown: boolean;
}

export function LayoutCustomizeSheet({
  title,
  rows,
  onToggle,
  onMove,
  onReset,
  onClose,
}: {
  title: string;
  rows: readonly CustomizeRow[];
  onToggle: (id: string, hidden: boolean) => void;
  onMove: (id: string, delta: -1 | 1) => void;
  onReset: () => void;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  return (
    <Sheet onClose={onClose}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "4px 0 12px" }}>
        <span style={{ fontSize: 17, fontWeight: 600, color: "var(--fg-1)" }}>{title}</span>
        <button
          type="button"
          onClick={onReset}
          style={{ border: "none", background: "transparent", color: "var(--accent)", fontSize: 14, fontWeight: 600, cursor: "pointer", padding: 0 }}
        >
          {t("common.reset")}
        </button>
      </div>
      <div style={{ maxHeight: "50vh", overflowY: "auto" }}>
        {rows.map((row, i) => (
          <div
            key={row.id}
            style={{
              display: "flex",
              alignItems: "center",
              gap: 8,
              minHeight: 48,
              borderBottom: "1px solid var(--line-1)",
              opacity: row.supported ? 1 : 0.5,
            }}
          >
            <span style={{ display: "flex", color: "var(--fg-2)", flex: "none" }}>{row.icon}</span>
            <span style={{ flex: 1, minWidth: 0, fontSize: 15, color: "var(--fg-1)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
              {row.label}
            </span>
            <button
              type="button"
              aria-label={t("editor.sidebar.moveUp")}
              disabled={i === 0}
              onClick={() => onMove(row.id, -1)}
              style={{ width: 40, height: 40, border: "none", background: "transparent", cursor: "pointer", padding: 0, display: "flex", alignItems: "center", justifyContent: "center" }}
            >
              <Icon name="chevron-up" size={18} color="var(--fg-2)" strokeWidth={2} />
            </button>
            <button
              type="button"
              aria-label={t("editor.sidebar.moveDown")}
              disabled={i === rows.length - 1}
              onClick={() => onMove(row.id, 1)}
              style={{ width: 40, height: 40, border: "none", background: "transparent", cursor: "pointer", padding: 0, display: "flex", alignItems: "center", justifyContent: "center" }}
            >
              <Icon name="chevron-down" size={18} color="var(--fg-2)" strokeWidth={2} />
            </button>
            <button
              type="button"
              role="switch"
              aria-checked={row.shown}
              aria-label={row.label}
              disabled={!row.supported}
              onClick={() => onToggle(row.id, row.shown)}
              style={{
                width: 46,
                height: 28,
                flex: "none",
                borderRadius: 999,
                border: "none",
                background: row.shown ? "var(--accent)" : "var(--line-2)",
                cursor: row.supported ? "pointer" : "default",
                position: "relative",
                padding: 0,
              }}
            >
              <span
                aria-hidden="true"
                style={{
                  position: "absolute",
                  top: 3,
                  insetInlineStart: row.shown ? 21 : 3,
                  width: 22,
                  height: 22,
                  borderRadius: 999,
                  background: "#fff",
                  transition: "inset-inline-start var(--duration-base) var(--ease-standard)",
                }}
              />
            </button>
          </div>
        ))}
      </div>
    </Sheet>
  );
}
