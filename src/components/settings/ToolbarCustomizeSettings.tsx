// Settings → Editor: floating-toolbar customization (MYND-336). A reorder +
// show/hide list over the FROZEN toolbar command vocabulary (no custom buttons).
// Self-contained like its sibling controls (LineNumbersSettings): local state
// loaded on mount, disk-first persist via the vault.prefs setters. The resolved
// order/hidden is what the editor's toolbar plugin renders (the plugin wiring is
// a follow-up; this owns the config surface + persistence).
//
// **The row itself is `CustomizeRow`** (myne-md/myne#773). This list was the third
// to answer "reorder and show/hide a strip of commands" and the only one that had
// hand-rolled the drag bookkeeping: a private `dragId`/`dropAt` pair, its own
// `onDragOver`/`onDrop`, and a `.myne-drop-row` indicator — while the ribbon and
// the bottom bar already shared `useDragReorder` + `CustomizeRow`. None of those
// three differences was a design decision; the two shared components came second
// and this file was never revisited. What arrives with the adoption, and what was
// genuinely missing here: Alt+↑/↓ keyboard reorder, `role="listitem"`, `tabIndex`
// and a positional `aria-label`. What goes: the duplicate drag code, and
// `.myne-drop-row` from the shared sheet, which nothing else used.
//
// Two things deliberately do NOT unify, each for a reason worth reading before
// "finishing" the job:
//
//   * **The show/hide control stays a checkbox**, not the bar's `Switch`
//     primitive. `e2e/toolbar-customize.e2e.ts`'s tc1 reads `.checked` off this
//     element by testid — a `<button role="switch">` answers `undefined` there,
//     so switching primitives reddens a shipped scenario that is currently the
//     only automated proof this toggle persists. That scenario changes in the
//     same change or this one does not move.
//   * **The ↑/↓ buttons stay.** They are the whole subject of tc2
//     (myne-md/myne#557): the roster row asked a human to reorder by DRAGGING,
//     and the buttons are why that row could be retired — a WebDriver seat cannot
//     start a native HTML5 drag session. The ribbon and the bar have drag +
//     Alt+arrows and no buttons; deleting these would re-open a manual row.
//
// The toolbar's vocabulary carries no icons, so `icon` is omitted here (the
// shared row renders the label without one); the bar and the ribbon both pass one.

import { useEffect, useState, type CSSProperties } from "react";
import { useTranslation } from "react-i18next";
import { ControlBlock } from "./ControlBlock";
import { ERROR_STYLE } from "./panel-styles";
import { CustomizeRow, CUSTOMIZE_LIST_STYLE, useDragReorder } from "./CustomizeList";
import { Checkbox } from "../primitives/Checkbox";
import { HOVER_TRANSITION } from "../primitives/hoverSurface";
import { interactiveSurface } from "../primitives/interactiveSurface";
import { prefsRead, setEditorToolbarHidden, setEditorToolbarOrder } from "../../lib/prefs";
import { resolveBarOrder } from "../../notes/barItemsOrder";
import {
  EDITOR_TOOLBAR_DEFAULT_ORDER,
  resolveToolbarHidden,
  toolbarItemLabelKey,
} from "../../notes/toolbarItems";

// `CUSTOMIZE_LIST_STYLE` is the shared column; this list is a fixed-width
// control inside a settings block, so it keeps the width it shipped with.
const LIST_STYLE: CSSProperties = { ...CUSTOMIZE_LIST_STYLE, minWidth: 240 };

// The hint on the row that may not be switched off (issue #970): dimmed like a
// disabled control, because that is what its checkbox is.
const LAST_SHOWN_HINT_STYLE: CSSProperties = {
  fontSize: "var(--text-xs)",
  color: "var(--fg-3)",
  flexShrink: 0,
};
const ARROWS_STYLE: CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  flexShrink: 0,
};
const ARROW_STYLE: CSSProperties = {
  background: "transparent",
  border: 0,
  color: "var(--fg-2)",
  cursor: "pointer",
  padding: "0 4px",
  fontSize: "var(--text-base)",
  lineHeight: 1,
  borderRadius: "var(--radius-1)",
  transition: HOVER_TRANSITION,
};
const ARROW_DISABLED_STYLE: CSSProperties = {
  ...ARROW_STYLE,
  color: "var(--fg-3)",
  opacity: 0.35,
  cursor: "default",
};
export function ToolbarCustomizeSettings() {
  const { t } = useTranslation();
  const [order, setOrder] = useState<string[]>([...EDITOR_TOOLBAR_DEFAULT_ORDER]);
  const [hidden, setHidden] = useState<string[]>(resolveToolbarHidden([]));
  const [error, setError] = useState<string | null>(null);
  // Whether `hidden` holds what is on disk. A failed `prefsRead` leaves the
  // defaults in state, and those defaults are NOT the user's layout: persisting
  // them would write a layout over one that was never read, silently and with
  // no undo. So a write is refused until a read has actually succeeded, and the
  // rows say why rather than looking live (myne-md/myne#970 review, D8).
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void prefsRead()
      .then((p) => {
        if (cancelled) return;
        setOrder(
          p.editor_toolbar_order.length > 0
            ? p.editor_toolbar_order
            : [...EDITOR_TOOLBAR_DEFAULT_ORDER],
        );
        setHidden(resolveToolbarHidden(p.editor_toolbar_hidden));
        setLoaded(true);
      })
      .catch(() => {
        /* locked / no vault — leave defaults, and refuse to write over them */
        if (cancelled) return;
        setLoaded(false);
        setError(t("settings.toolbarCustomize.errorLoad"));
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // Completed order (all vocabulary ids, self-healed against the canonical set).
  const fullOrder = resolveBarOrder(order, EDITOR_TOOLBAR_DEFAULT_ORDER);
  const hiddenSet = new Set(hidden);

  // Optimistic persist with rollback: the list updates immediately, but an IPC
  // failure restores the on-disk state so the UI never shows a layout that
  // didn't save.
  async function persistOrder(next: string[]) {
    const prev = order;
    setOrder(next);
    try {
      await setEditorToolbarOrder(next);
      setError(null);
    } catch {
      setOrder(prev);
      setError(t("settings.toolbarCustomize.errorSave"));
    }
  }
  async function persistHidden(next: string[]) {
    const prev = hidden;
    setHidden(next);
    try {
      await setEditorToolbarHidden(next);
      setError(null);
    } catch {
      setHidden(prev);
      setError(t("settings.toolbarCustomize.errorSave"));
    }
  }
  // Every vocabulary id renders now (issue #970), so the only remaining guard is
  // the one that keeps `resolveToolbarHidden` unambiguous: the last VISIBLE
  // control cannot be hidden, because "hide everything" would persist `[]`, which
  // reads back as "never customized". A formatting toolbar with no formatting is
  // also not a state worth a schema change to support.
  const shownCount = fullOrder.filter((id) => !hiddenSet.has(id)).length;
  function toggleShown(id: string) {
    if (!loaded) return;
    const shown = !hiddenSet.has(id);
    if (shown && shownCount <= 1) return;
    const next = shown ? [...hidden, id] : hidden.filter((h) => h !== id);
    // Un-hiding the LAST hidden control would persist `[]`, and `[]` reads back
    // as "never customized" (`resolveToolbarHidden`), so the stored layout would
    // silently revert to the default set on the next read (myne-md/myne#972
    // review, D8). The hidden set therefore always keeps one id: hide is bounded
    // by `shownCount` above, un-hide by this line.
    if (next.length === 0) return;
    void persistHidden(next);
  }
  function move(id: string, delta: number) {
    if (!loaded) return;
    const idx = fullOrder.indexOf(id);
    const to = idx + delta;
    if (to < 0 || to >= fullOrder.length) return;
    const next = [...fullOrder];
    [next[idx], next[to]] = [next[to]!, next[idx]!];
    void persistOrder(next);
  }

  // Drag, drop indication and the Alt+↑/↓ fallback all live in the shared hook.
  // `fullOrder` rather than `order`: the roster is self-healed before it is
  // reordered, so a drop writes the complete vocabulary.
  const reorder = useDragReorder(fullOrder, (next) => {
    if (loaded) void persistOrder(next);
  });

  return (
    <>
      <ControlBlock
        label={t("settings.toolbarCustomize.label")}
        helper={t("settings.toolbarCustomize.helper")}
        control={
          <div data-testid="settings.toolbar-customize" style={LIST_STYLE} role="list">
            {fullOrder.map((id, i) => {
              // The row's own label, reused for the checkbox below: the two
              // lists either side of this one name their trailing show/hide
              // control with the item's label too (`BarCustomizeSettings`'s
              // `Switch ariaLabel`), and a list of twelve boxes whose names are
              // all "Show" is a list of twelve identical controls.
              const label = t(toolbarItemLabelKey(id) ?? id);
              // The one row that may not be switched off: see `toggleShown`.
              const isLastShown = !hiddenSet.has(id) && shownCount <= 1;
              const isLastHidden = hiddenSet.has(id) && hiddenSet.size <= 1;
              return (
                <CustomizeRow
                  key={id}
                  id={id}
                  label={label}
                  index={i}
                  total={fullOrder.length}
                  reorder={reorder}
                  testId={`settings.toolbar-customize.row.${id}`}
                  note={
                    isLastShown ? (
                      <span style={LAST_SHOWN_HINT_STYLE}>
                        {t("settings.toolbarCustomize.lastShownHint")}
                      </span>
                    ) : isLastHidden ? (
                      <span style={LAST_SHOWN_HINT_STYLE}>
                        {t("settings.toolbarCustomize.lastHiddenHint")}
                      </span>
                    ) : undefined
                  }
                  trailing={
                    <>
                      {/* `role="list"` above and this name are the two things axe
                          reported as critical on this story: a `role="listitem"`
                          whose parent is a plain div, and a form element with no
                          accessible name. */}
                      <Checkbox
                        checked={!hiddenSet.has(id)}
                        onChange={() => toggleShown(id)}
                        disabled={isLastShown || !loaded}
                        ariaLabel={label}
                        testId="settings.toolbar-customize.toggle"
                        data-item-id={id}
                      />
                      <span style={ARROWS_STYLE}>
                        <button
                          type="button"
                          aria-label={t("settings.toolbarCustomize.moveUp")}
                          disabled={i === 0 || !loaded}
                          onClick={() => move(id, -1)}
                          {...interactiveSurface({ disabled: i === 0 })}
                          style={i === 0 ? ARROW_DISABLED_STYLE : ARROW_STYLE}
                          data-testid="settings.toolbar-customize.move-up"
                          data-item-id={id}
                        >
                          ↑
                        </button>
                        <button
                          type="button"
                          aria-label={t("settings.toolbarCustomize.moveDown")}
                          disabled={i === fullOrder.length - 1 || !loaded}
                          onClick={() => move(id, 1)}
                          {...interactiveSurface({ disabled: i === fullOrder.length - 1 })}
                          style={
                            i === fullOrder.length - 1 ? ARROW_DISABLED_STYLE : ARROW_STYLE
                          }
                          data-testid="settings.toolbar-customize.move-down"
                          data-item-id={id}
                        >
                          ↓
                        </button>
                      </span>
                    </>
                  }
                />
              );
            })}
          </div>
        }
      />
      {error !== null && <p style={ERROR_STYLE}>{error}</p>}
    </>
  );
}
