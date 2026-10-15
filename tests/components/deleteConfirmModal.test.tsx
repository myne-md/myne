// @vitest-environment jsdom
//
// myne-md/myne#628: the destructive confirm modal's keyboard contract.
//
// Before #628 the ring sat on Cancel while the accent-filled primary button was
// Delete, and Enter was a deliberate no-op: `preventDefault()` and nothing else.
// So the key that normally activates a primary action did nothing, on a dialog
// whose two buttons disagreed about which one was primary.
//
// `design-notes/ui/0564` records the reversal, and `design-notes/ui/0685`
// records what #683 changed about it. The rule it settles on is that
// **Enter follows the focus ring**: focus starts on the destructive button, so
// the reflex press confirms, and a user who deliberately Tabs to Cancel gets an
// Enter that cancels. #397's failure, a close indistinguishable from a
// successful delete, cannot recur under it, because that failure was the ring
// and the key disagreeing.
//
// The Tab case is the one most worth a test: flipping the default alone would
// have made Enter delete with the ring visibly on Cancel, which is a defect the
// fix would have introduced.
//
// myne-md/myne#683 changed ONE guard's mechanism without changing what any of
// them protect. Guard 2 used to be a 16 ms window measured from the effect that
// armed it, so it refused any Enter inside that window whichever instant the
// window happened to open in; it now compares the key event's own timestamp
// against the moment the dialog entered the document. The consequence for these
// tests is that `fireEvent`'s own (fresh) timestamp passes the guard, so each
// refusal below is attributable to the guard its test is about, and the two
// cases that matter are asserted directly: a key older than the dialog is
// refused, and a key newer than it confirms with no frame or timer crossed.

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render } from "@testing-library/react";
import { useRef } from "react";
import { DeleteConfirmModal } from "../../src/notes/components/DeleteConfirmModal";
import { useFocusTrap } from "../../src/hooks/useFocusTrap";

afterEach(() => cleanup());

/** The event clock's current reading, which is what a synthetic event is stamped with.
 *
 * Guard 2 compares a key's own `timeStamp` against the instant the dialog mounted, and
 * that instant is an event stamp too (see the component), so both sides of the comparison
 * are readings of THIS clock. The refusal direction needs a key that predates the mount,
 * which no naturally-dispatched event in this test can carry, so that value is stated:
 * one second before now is before this dialog existed, by a margin no clock skew covers.
 * The permissive direction states its value for a related reason, one millisecond past
 * now, so it asserts the ORDERING rather than whatever resolution this environment's
 * clock happens to have. Measured here: this reading and `fireEvent`'s own stamp are both
 * `Date.now()`-based (`1792079020813` against `performance.now()`'s `1783.55`), which is
 * why the mount instant is not taken from `performance.now()`. (The plain `fireEvent`
 * path is covered by the tests above, which want only "a fresh press confirms".) */
function eventNow(): number {
  return new Event("dc683:now").timeStamp;
}

/** Dispatch an Enter keydown carrying an explicit `timeStamp`. */
function enterAt(timeStamp: number): void {
  const ev = new KeyboardEvent("keydown", {
    key: "Enter",
    bubbles: true,
    cancelable: true,
  });
  Object.defineProperty(ev, "timeStamp", { value: timeStamp });
  document.dispatchEvent(ev);
}

/** A second trapped dialog, the shape an OS deep link can open over this one. */
function StackedDialog() {
  const ref = useRef<HTMLDivElement>(null);
  useFocusTrap(ref, { enabled: true });
  return (
    <div ref={ref} role="dialog">
      <button data-testid="stacked.button" type="button">
        stacked
      </button>
    </div>
  );
}

function mount(props?: { initialFocus?: "cancel" | "confirm"; openedByKey?: boolean }) {
  const onConfirm = vi.fn();
  const onCancel = vi.fn();
  const r = render(
    <DeleteConfirmModal
      title="Delete this folder?"
      body="“Notes” and its 9 notes"
      confirmLabel="Delete folder"
      onCancel={onCancel}
      onConfirm={onConfirm}
      {...props}
    />,
  );
  return { ...r, onConfirm, onCancel };
}

describe("DeleteConfirmModal keyboard contract", () => {
  it("focuses the destructive button by default, so the ring names what Enter does", () => {
    const { getByTestId } = mount();
    expect(document.activeElement).toBe(getByTestId("delete-confirm.confirm"));
  });

  it("Enter confirms from the default focus", async () => {
    const { onConfirm, onCancel } = mount();
    fireEvent.keyDown(document, { key: "Enter" });
    expect(onConfirm).toHaveBeenCalledTimes(1);
    expect(onCancel).not.toHaveBeenCalled();
  });

  it("Enter CANCELS once the user has moved the ring to Cancel", async () => {
    const { getByTestId, onConfirm, onCancel } = mount();
    getByTestId("delete-confirm.cancel").focus();
    fireEvent.keyDown(document, { key: "Enter" });
    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(onConfirm).not.toHaveBeenCalled();
  });

  // The four guards, each asserted against the sequence it exists for. Two of
  // this modal's call sites are the cryptographic erase of decisions/storage
  // 0105, so each of these is a path from a keypress to an unrecoverable delete.
  describe("cannot confirm without having been read", () => {
    it("ignores an auto-repeat, so a HELD Enter cannot purge the trash", async () => {
      // Both openers of the permanent purge fire on Enter keydown. The opening
      // press is dispatched before this listener exists; what reaches it is the
      // repeat, and every repeat after the first carries `repeat: true`.
      const { onConfirm, onCancel } = mount();
      fireEvent.keyDown(document, { key: "Enter", repeat: true });
      expect(onConfirm).not.toHaveBeenCalled();
      expect(onCancel).not.toHaveBeenCalled();
    });

    it("ignores an Enter whose own timestamp predates the dialog", () => {
      // Guard 2's real subject: a key already in flight when the dialog appeared
      // is not an answer to it. The key carries the instant it was created, and
      // the mount instant is a reading of that same clock, so the test states a
      // value one second before now: before this dialog existed by a margin no
      // clock skew covers.
      const { onConfirm, onCancel } = mount();
      enterAt(eventNow() - 1_000);
      expect(onConfirm).not.toHaveBeenCalled();
      expect(onCancel).not.toHaveBeenCalled();
    });

    it("confirms an Enter pressed after the dialog appeared, with no frame or timer crossed", () => {
      // The myne-md/myne#683 regression, and the injection that pins the fix is
      // reverting it. The guard used to be a 16 ms window measured from when the
      // arming effect ran, so a press arriving immediately after mount was
      // refused on a dialog whose ring was on the confirm button: `sinceMount`
      // of 14 ms refused it, and the same press 8 s later confirmed. Nothing is
      // waited for here, deliberately: a press created after the dialog appeared
      // is an answer to it, whether or not a frame has been painted and whether
      // or not any timer has fired. One millisecond past now states that
      // ordering, rather than relying on two clocks disagreeing by an epoch.
      const { onConfirm, onCancel } = mount();
      enterAt(eventNow() + 1);
      expect(onConfirm).toHaveBeenCalledTimes(1);
      expect(onCancel).not.toHaveBeenCalled();
    });

    // There is deliberately NO unit test here for the other half of #683, the
    // registration moving from a passive effect to a commit-phase one. jsdom
    // cannot hold the state that distinguishes them: every way of committing a
    // mount (act, RTL's render, flushSync) also flushes the passive effects, so a
    // keyup dispatched after any of them finds the listener either way, and the
    // test this replaced passed against the defect when it was written.
    //
    // The guard-4 RULE is pinned below ("refuses a held Enter that opened the
    // dialog"), so what is unexercised is the timing, not the rule. And no E2E
    // scenario carries it either: `openedByKey === true` is reachable only
    // through the palette's Enter keydown (`CommandPalette`'s row `runRow(row,
    // true)`) or a keyboard-activated trash button, and `et1` and `nc5` do
    // neither (et1 clicks the palette row, so the dialog mounts with
    // `viaKey: false`, and nc5 opens from the Delete key and passes no
    // `openedByKey`). Said out loud because an earlier version of this comment
    // claimed those two scenarios covered it, which they do not.

    it("ignores an Enter pressed inside a dialog stacked over this one", async () => {
      // `ThemeInstallDialog` opens from an OS deep link, which can arrive over a
      // modal already open. Focus is then inside THAT dialog, which reads as
      // "not Cancel" and would otherwise confirm the one behind it.
      //
      // The stacked dialog brings its OWN focus trap, because that is what makes
      // the scenario reachable: `imperative-focus-trap` enforces containment from
      // the INNERMOST live trap only, so without a second trap this modal's own
      // would pull focus straight back and the test would be asserting against a
      // state the app never reaches.
      const { onConfirm, onCancel } = mount();
      const { getByTestId: getStacked } = render(<StackedDialog />);
      getStacked("stacked.button").focus();
      expect(document.activeElement).toBe(getStacked("stacked.button"));

      fireEvent.keyDown(document, { key: "Enter" });
      expect(onConfirm).not.toHaveBeenCalled();
      expect(onCancel).not.toHaveBeenCalled();

      // Escape too. Closing the dialog behind is benign next to confirming it,
      // which is why Enter's containment came first, but a stacked dialog whose
      // dismissal silently takes the delete confirmation with it is still wrong.
      fireEvent.keyDown(document, { key: "Escape" });
      expect(onCancel).not.toHaveBeenCalled();
    });

    it("refuses a held Enter that opened the dialog, whatever `repeat` reports", async () => {
      // Guard 2 cannot do this and an earlier revision of the component claimed
      // it could. OS typematic delay before the first auto-repeat is 250 ms to
      // 660 ms, so the dialog is far older than any key still in flight by the
      // time a held key's first repeat arrives. If the WebView reports
      // `repeat: false` for that repeat, guard 1 admits it too.
      //
      // Guard 4 keys off the input instead of off a flag or a clock: a HELD key
      // emits repeats and never a keyup, so a caller that says "a key opened
      // this" gets an Enter that refuses until an Enter keyup has been seen. The
      // press below carries `repeat: false` deliberately, which is the exact
      // case the other two guards cannot tell from a fresh press.
      const { onConfirm, onCancel } = mount({ openedByKey: true });
      fireEvent.keyDown(document, { key: "Enter", repeat: false });
      expect(onConfirm).not.toHaveBeenCalled();
      expect(onCancel).not.toHaveBeenCalled();

      // Releasing is what a person does and a held key cannot.
      fireEvent.keyUp(document, { key: "Enter" });
      fireEvent.keyDown(document, { key: "Enter" });
      expect(onConfirm).toHaveBeenCalledTimes(1);
    });

    it("costs a pointer-opened dialog nothing", async () => {
      // The other direction, and the reason the guard is opt-in. Demanding a
      // release from someone who never pressed the key that opened the dialog
      // would eat their first Enter, which is the #397 inertness this whole
      // entry set out to remove, narrowed to one dialog.
      const { onConfirm } = mount();
      fireEvent.keyDown(document, { key: "Enter" });
      expect(onConfirm).toHaveBeenCalledTimes(1);
    });

    it("stays armed when the parent re-renders with fresh callbacks", async () => {
      // The guard has to mean "since the DIALOG appeared". The obvious spelling,
      // `[onCancel, onConfirm]` as the listener effect's deps, makes it mean
      // "since the parent last re-rendered" instead, and `NoteList`'s keyboard
      // soft-trash hands down an `onConfirm` that closes over the state opening
      // the dialog, so it is a new identity on every render of a list that
      // re-renders on save settles and sync ticks.
      //
      // This is not hypothetical: it was one of the two ways `nc5` was timed out
      // three times over with the focus ring visibly on the confirm button and
      // Enter doing nothing, found while hunting the other one (#683). A
      // re-render that resets the mount instant puts the dialog's age back to
      // zero, so the guard refuses a press on a dialog that has been up for
      // seconds.
      const { onConfirm, onCancel, rerender } = mount();
      rerender(
        <DeleteConfirmModal
          title="Delete this folder?"
          body="“Notes” and its 9 notes"
          confirmLabel="Delete folder"
          onCancel={() => onCancel()}
          onConfirm={() => onConfirm()}
        />,
      );

      fireEvent.keyDown(document, { key: "Enter" });
      expect(onConfirm).toHaveBeenCalledTimes(1);
      expect(onCancel).not.toHaveBeenCalled();
    });

    it("answers with the LATEST callbacks, not the ones it mounted with", async () => {
      // The other direction of the same fix: reading the callbacks through a ref
      // is only correct if the ref is current. A listener installed once that
      // kept its mount-time closure would confirm a stale victim, which on the
      // keyboard soft-trash path means trashing whichever note was selected when
      // the dialog opened rather than the one the parent has since re-staged.
      const { onConfirm, rerender } = mount();
      const later = vi.fn();
      rerender(
        <DeleteConfirmModal
          title="Delete this folder?"
          body="“Notes” and its 9 notes"
          confirmLabel="Delete folder"
          onCancel={() => undefined}
          onConfirm={later}
        />,
      );

      fireEvent.keyDown(document, { key: "Enter" });
      expect(later).toHaveBeenCalledTimes(1);
      expect(onConfirm).not.toHaveBeenCalled();
    });
  });

  it("Escape cancels, never confirms", () => {
    const { onConfirm, onCancel } = mount();
    fireEvent.keyDown(document, { key: "Escape" });
    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it("a key that is neither Enter nor Escape does nothing", () => {
    const { onConfirm, onCancel } = mount();
    fireEvent.keyDown(document, { key: "a" });
    fireEvent.keyDown(document, { key: " " });
    expect(onConfirm).not.toHaveBeenCalled();
    expect(onCancel).not.toHaveBeenCalled();
  });

  // The retained value, and it has a caller: `src/components/sync/RecoveredNotes.tsx`
  // pins it for the quarantine delete, which destroys the last copy of a note
  // anywhere, since `quarantine/` is not inside the `.myne-backup` container.
  // Saying so matters here, because an earlier revision of this comment claimed
  // nothing used it, which invites the next reader to delete the prop and with it
  // that dialog's only protection against a reflex Enter. Keying Enter off focus
  // is what makes the value meaningful rather than vestigial: a caller that
  // starts the ring on Cancel gets an Enter that cancels.
  describe('initialFocus="cancel"', () => {
    it("focuses Cancel", () => {
      const { getByTestId } = mount({ initialFocus: "cancel" });
      expect(document.activeElement).toBe(getByTestId("delete-confirm.cancel"));
    });

    it("Enter cancels from there, and never confirms", async () => {
      const { onConfirm, onCancel } = mount({ initialFocus: "cancel" });
      fireEvent.keyDown(document, { key: "Enter" });
      expect(onCancel).toHaveBeenCalledTimes(1);
      expect(onConfirm).not.toHaveBeenCalled();
    });
  });
});
