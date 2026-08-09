// `<NoteActionsMenu>` — the editor-chrome "…" (more) menu (Obsidian-style).
//
// A single "…" button in the editor's top-right chrome (beside the right-
// sidebar toggle) that drops a menu of note-scoped actions — Rename, Move to
// folder, Duplicate, Version history, Export, Move to trash. Every item is fed
// a handler by the mounting host (`Editor.tsx`'s `CommandPaletteHost`), which
// wires them to the SAME `CommandContext` handlers the command palette uses —
// so there is no second IPC path here, only a second surface onto the existing
// one.
//
// The component owns only presentation + dismissal: the anchored dropdown
// (modeled on `WorkspaceSwitcherControl`), Esc / outside-click close (the
// `ContextMenu` discipline), and keyboard menu navigation. Token-only inline
// styling, no Tailwind (src/CLAUDE.md).

import {
  Fragment,
  useEffect,
  useRef,
  useState,
  type CSSProperties,
} from "react";
import { Icon } from "../../components/primitives/Icon";
import type { IconName } from "../../lib/icons";
import {
  hoverSurface,
  HOVER_TRANSITION,
} from "../../components/primitives/hoverSurface";

/** One row of the menu: an actionable item or a section divider. */
export type NoteActionMenuItem =
  | { kind: "divider" }
  | {
      kind: "action";
      /** Stable discriminator surfaced as `data-action` (E2E + React key). */
      action: string;
      label: string;
      /** Optional leading glyph. */
      icon?: IconName;
      /** Destructive styling (red) — e.g. Move to trash. */
      destructive?: boolean;
      onSelect: () => void;
    };

// The "…" button matches the neighbouring `TitleBarToggle` (same footprint +
// hover ramp) so the top-right cluster reads as one control group.
const BUTTON_STYLE: CSSProperties = {
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  width: 30,
  height: 26,
  flexShrink: 0,
  border: 0,
  borderRadius: "var(--radius-1)",
  background: "transparent",
  color: "var(--fg-3)",
  cursor: "pointer",
  transition: HOVER_TRANSITION,
};

const MENU_STYLE: CSSProperties = {
  position: "absolute",
  top: "calc(100% + 4px)",
  insetInlineEnd: 0,
  minWidth: 208,
  background: "var(--paper)",
  border: "1px solid var(--line-2)",
  borderRadius: "var(--radius-2)",
  boxShadow: "0 4px 12px rgba(0, 0, 0, 0.12)",
  padding: "var(--space-1)",
  zIndex: 60,
  fontFamily: "var(--font-sans)",
  fontSize: "var(--text-sm)",
};

const ITEM_STYLE: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: "var(--space-2)",
  width: "100%",
  textAlign: "start",
  padding: "6px 10px",
  background: "transparent",
  border: 0,
  borderRadius: 4,
  cursor: "pointer",
  color: "var(--fg-1)",
  fontFamily: "inherit",
  fontSize: "inherit",
  transition: HOVER_TRANSITION,
};

const DIVIDER_STYLE: CSSProperties = {
  height: 1,
  background: "var(--line-1)",
  margin: "4px 6px",
  border: 0,
};

export function NoteActionsMenu({
  label,
  items,
}: {
  /** aria-label + tooltip for the "…" button. */
  label: string;
  items: NoteActionMenuItem[];
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement | null>(null);

  // Esc + outside-click dismissal, and focus the first item on open so the
  // `role="menu"` is keyboard-operable from the start (ContextMenu discipline).
  useEffect(() => {
    if (!open) return;
    const onDown = (e: globalThis.MouseEvent) => {
      if (ref.current !== null && !ref.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    ref.current
      ?.querySelector<HTMLButtonElement>('[role="menuitem"]')
      ?.focus();
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  return (
    <div
      ref={ref}
      data-editor-chrome
      style={{ position: "relative", display: "flex", alignItems: "center" }}
    >
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={label}
        title={label}
        data-testid="editor.note-actions-menu"
        {...hoverSurface()}
        style={BUTTON_STYLE}
      >
        <Icon name="more-horizontal" size={16} />
      </button>
      {open && (
        <div
          role="menu"
          aria-label={label}
          onKeyDown={(e) => {
            const node = ref.current;
            if (node === null) return;
            const its = Array.from(
              node.querySelectorAll<HTMLButtonElement>('[role="menuitem"]'),
            );
            if (its.length === 0) return;
            const cur = its.findIndex((el) => el === document.activeElement);
            let next: number;
            if (e.key === "ArrowDown") next = cur < 0 ? 0 : (cur + 1) % its.length;
            else if (e.key === "ArrowUp")
              next = cur < 0 ? its.length - 1 : (cur - 1 + its.length) % its.length;
            else if (e.key === "Home") next = 0;
            else if (e.key === "End") next = its.length - 1;
            else return;
            e.preventDefault();
            its[next]?.focus();
          }}
          style={MENU_STYLE}
        >
          {items.map((item, i) =>
            item.kind === "divider" ? (
              <div key={`divider-${i}`} role="separator" style={DIVIDER_STYLE} />
            ) : (
              <Fragment key={item.action}>
                <button
                  type="button"
                  role="menuitem"
                  data-testid="editor.note-actions-menu-item"
                  data-action={item.action}
                  onClick={() => {
                    item.onSelect();
                    setOpen(false);
                  }}
                  {...hoverSurface({
                    hoverBg: item.destructive
                      ? "var(--warning-soft)"
                      : "var(--paper-3)",
                  })}
                  style={{
                    ...ITEM_STYLE,
                    color: item.destructive ? "var(--warning)" : "var(--fg-1)",
                  }}
                >
                  <span
                    aria-hidden="true"
                    style={{
                      width: 16,
                      flexShrink: 0,
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "center",
                      color: item.destructive ? "var(--warning)" : "var(--fg-3)",
                    }}
                  >
                    {item.icon !== undefined ? (
                      <Icon name={item.icon} size={14} />
                    ) : null}
                  </span>
                  <span
                    style={{
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                      whiteSpace: "nowrap",
                    }}
                  >
                    {item.label}
                  </span>
                </button>
              </Fragment>
            ),
          )}
        </div>
      )}
    </div>
  );
}
