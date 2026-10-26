// The selection toggle shared by the table and the board (view-manifests task 10,
// reused by the board's multi-card move in myne-md/myne#922 task 7).
//
// Built from `Button` rather than an `<input>`, and that is a promise rather than
// a preference: the saved-view renderers are READ-ONLY projections (SYNC-1) and
// their specs assert that no `<input>` appears in them. Selection is not cell
// editing, so the control is a `role="checkbox"` button (the `Switch` precedent):
// the announced state and the painted state come from the same ARIA attribute,
// and the invariant keeps its letter.
//
// It lives here because the board moves cards in bulk too, and two copies of "a
// checkbox that is a button" is how one of them ends up as an `<input>`.

import type { CSSProperties } from "react";
import { Button } from "../../components/primitives/Button";
import { Icon } from "../../components/primitives/Icon";

const TOGGLE_STYLE: CSSProperties = {
  width: "var(--target-min)",
  height: "var(--target-min)",
  padding: 0,
  border: 0,
  background: "transparent",
  display: "inline-flex",
  alignItems: "center",
  justifyContent: "center",
  flex: "0 0 auto",
};

const TOGGLE_BOX_STYLE: CSSProperties = {
  width: 16,
  height: 16,
  display: "inline-flex",
  alignItems: "center",
  justifyContent: "center",
  border: "1px solid var(--line-2)",
  borderRadius: "var(--radius-1)",
  color: "var(--fg-1)",
};

/** A `role="checkbox"` button: keyboard-operable, announceable, and not an
 *  `<input>`. `onToggle` runs with the row's own click stopped, so selecting a
 *  card never opens its note. */
export function SelectToggle({
  checked,
  label,
  onToggle,
  testId,
  noteId,
}: {
  checked: boolean;
  label: string;
  onToggle: () => void;
  testId: string;
  noteId?: string;
}) {
  return (
    <Button
      variant="ghost"
      role="checkbox"
      aria-checked={checked}
      aria-label={label}
      data-testid={testId}
      {...(noteId === undefined ? {} : { "data-note-id": noteId })}
      onClick={(e) => {
        e.stopPropagation();
        onToggle();
      }}
      style={TOGGLE_STYLE}
    >
      <span style={TOGGLE_BOX_STYLE} aria-hidden="true">
        {checked ? <Icon name="check" size={12} /> : null}
      </span>
    </Button>
  );
}
