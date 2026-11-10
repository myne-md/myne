import { Icon, type IconName } from "../../../../components";

/**
 * One row of an action sheet: a glyph, then the label.
 *
 * **The glyph column is the desktop's** (myne-md/myne#1042). Every item in the
 * desktop `ContextMenu` carries an `icon` and the menu draws it before the label,
 * so the same action is the same picture on both clients — the note tree's sheets
 * here were the last label-only menus in the product, one tap from a desktop menu
 * that had the icons all along. Where both clients have the glyph its name is the
 * desktop's (`file-plus`, `folder-plus`, `palette`, `archive`, `trash`).
 *
 * The row is shared by the three sheets that need it (`FolderActionsSheet`,
 * `NoteRowActionsSheet`, `NoteActionsSheet`) because it used to be a copy in each:
 * `scripts/duplication-groups.json` records that trio, and adding an icon column
 * to three copies is how a control ends up looking different in one of them.
 */
export function ActionRow({
  icon,
  label,
  onClick,
  danger = false,
  groupTop = false,
  testId,
  disabled = false,
}: {
  icon: IconName;
  label: string;
  onClick: () => void;
  /** A destructive action: label and glyph both take `--danger`. */
  danger?: boolean;
  /** Drops the top hairline when a heavier separator already precedes the row. */
  groupTop?: boolean;
  testId?: string;
  /** Dims the row and stops it acting (a sheet mid-write). */
  disabled?: boolean;
}) {
  // A raw <button>, deliberately and in ONE place: this is a sheet MENU row, not a
  // button. `<Button>`'s geometry is centered and its variants are actions; a menu
  // row is full-width, left-aligned, 52px tall with an icon column, a hairline on
  // top and a heavier rule between groups. `ListRow` is the other candidate and is
  // the wrong shape too — it draws a card row with a value column and its own
  // separators, which is a different surface (a settings list). Recorded in
  // `scripts/primitives-baseline.json` by `--record`, and this is the comment the
  // guard asks for at the call site.
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      data-testid={testId}
      style={{
        display: "flex",
        alignItems: "center",
        gap: 12,
        width: "100%",
        minHeight: 52,
        border: "none",
        borderTop: groupTop ? "none" : "1px solid var(--line-1)",
        background: "transparent",
        padding: "15px 18px",
        cursor: disabled ? "default" : "pointer",
        opacity: disabled ? 0.6 : 1,
        fontFamily: "var(--font-sans)",
        fontSize: 16,
        textAlign: "start",
        color: danger ? "var(--danger)" : "var(--fg-1)",
      }}
    >
      {/* The glyph carries the row's weight, not its colour: a destructive row is
          red in both, a normal one is quiet here and full-strength in the label. */}
      <Icon name={icon} size={18} color={danger ? "var(--danger)" : "var(--fg-3)"} />
      <span style={{ flex: 1, minWidth: 0 }}>{label}</span>
    </button>
  );
}

/** The heavier rule BETWEEN logical groups (create / organise / destructive) —
 *  the mobile twin of the desktop `ContextMenu`'s `group` dividers. */
export function ActionRowSeparator() {
  return <div aria-hidden style={{ height: 1, background: "var(--line-2)", margin: "7px 0" }} />;
}
