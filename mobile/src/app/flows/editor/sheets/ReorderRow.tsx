import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";

/**
 * Move-up / move-down control pair for a note- or folder-row action sheet
 * (MYND-596) — the action-sheet twin of SettingsSheet's format-bar reorder
 * controls (MYND-555): two square icon buttons, boundary-disabled, i18n
 * aria-labels (`settings.toolbarCustomize.moveUp`/`moveDown`). NOT drag — a
 * long-press-drag inside a dismissable sheet fights the sheet's own gesture,
 * exactly as the format-bar panel documents. Each nudge rewrites ONE container's
 * `item_order` sequence; the boundary rows (first / last) disable the matching
 * button.
 */
export function ReorderRow({
  canUp,
  canDown,
  onUp,
  onDown,
  upTestId,
  downTestId,
}: {
  canUp: boolean;
  canDown: boolean;
  onUp: () => void;
  onDown: () => void;
  upTestId: string;
  downTestId: string;
}) {
  const { t } = useTranslation();
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        justifyContent: "flex-end",
        gap: 8,
        borderTop: "1px solid var(--line-1)",
        padding: "11px 18px",
      }}
    >
      <IconBtn label={t("settings.toolbarCustomize.moveUp")} disabled={!canUp} testId={upTestId} onClick={onUp}>
        <path d="M3 8l5-5 5 5" />
      </IconBtn>
      <IconBtn label={t("settings.toolbarCustomize.moveDown")} disabled={!canDown} testId={downTestId} onClick={onDown}>
        <path d="M3 5l5 5 5-5" />
      </IconBtn>
    </div>
  );
}

/** Small square icon button — mirrors SettingsSheet's `IconBtn` (MYND-555). */
function IconBtn({
  label,
  disabled,
  onClick,
  testId,
  children,
}: {
  label: string;
  disabled: boolean;
  onClick: () => void;
  testId: string;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      disabled={disabled}
      data-testid={testId}
      onClick={onClick}
      style={{
        width: 36,
        height: 36,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        border: "1px solid var(--line-2)",
        borderRadius: 8,
        background: "transparent",
        color: disabled ? "var(--line-2)" : "var(--fg-2)",
        cursor: disabled ? "default" : "pointer",
        flex: "none",
      }}
    >
      <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
        {children}
      </svg>
    </button>
  );
}
