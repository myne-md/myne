// The selection toggle shared by the table and the board (view-manifests task 10,
// reused by the board's multi-card move in myne-md/myne#922 task 7).
//
// It is a thin adapter over `<Checkbox>` now (myne-md/myne#1099) and no longer a
// second implementation: the primitive is a `button role="checkbox"` too, so the
// saved-view renderers still contain no `<input>` (SYNC-1) and the announced state
// still comes from the same aria attribute as the painted one. What stays here is
// the note id the board's bulk move reads and the click the row must not receive.

import { Checkbox } from "../../components/primitives/Checkbox";

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
    <Checkbox
      checked={checked}
      onChange={onToggle}
      ariaLabel={label}
      testId={testId}
      {...(noteId === undefined ? {} : { "data-note-id": noteId })}
      // Selection must not reach the row's own click. The toggle itself is the
      // primitive's `onChange`, so this handler only stops the bubble.
      onClick={(e) => e.stopPropagation()}
    />
  );
}
