// @vitest-environment jsdom
//
// myne-md/myne#628: the destructive confirm modal's keyboard contract.
//
// Before #628 the ring sat on Cancel while the accent-filled primary button was
// Delete, and Enter was a deliberate no-op: `preventDefault()` and nothing else.
// So the key that normally activates a primary action did nothing, on a dialog
// whose two buttons disagreed about which one was primary.
//
// `docs/decisions/ui/0541` records the reversal. The rule it settles on is that
// **Enter follows the focus ring**: focus starts on the destructive button, so
// the reflex press confirms, and a user who deliberately Tabs to Cancel gets an
// Enter that cancels. #397's failure, a close indistinguishable from a
// successful delete, cannot recur under it, because that failure was the ring
// and the key disagreeing.
//
// The Tab case is the one most worth a test: flipping the default alone would
// have made Enter delete with the ring visibly on Cancel, which is a defect the
// fix would have introduced.

import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render } from "@testing-library/react";
import { useRef } from "react";
import { DeleteConfirmModal } from "../../src/notes/components/DeleteConfirmModal";
import { useFocusTrap } from "../../src/hooks/useFocusTrap";

afterEach(() => cleanup());

/**
 * Let the dialog arm.
 *
 * Enter is ignored for one frame after mount, which is guard 2 in the component:
 * a human cannot answer a dialog within the frame it appeared in, so an Enter
 * arriving there is not an answer to it. Every test that means to press Enter
 * deliberately has to cross that frame first, and the two that do NOT call this
 * are the ones asserting the guard.
 */
async function armed(): Promise<void> {
  await act(async () => {
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
  });
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
    await armed();
    fireEvent.keyDown(document, { key: "Enter" });
    expect(onConfirm).toHaveBeenCalledTimes(1);
    expect(onCancel).not.toHaveBeenCalled();
  });

  it("Enter CANCELS once the user has moved the ring to Cancel", async () => {
    const { getByTestId, onConfirm, onCancel } = mount();
    await armed();
    getByTestId("delete-confirm.cancel").focus();
    fireEvent.keyDown(document, { key: "Enter" });
    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(onConfirm).not.toHaveBeenCalled();
  });

  // The three guards, each asserted against the sequence it exists for. Two of
  // this modal's call sites are the cryptographic erase of decisions/storage
  // 0105, so each of these is a path from a keypress to an unrecoverable delete.
  describe("cannot confirm without having been read", () => {
    it("ignores an auto-repeat, so a HELD Enter cannot purge the trash", async () => {
      // Both openers of the permanent purge fire on Enter keydown. The opening
      // press is dispatched before this listener exists; what reaches it is the
      // repeat, and every repeat after the first carries `repeat: true`.
      const { onConfirm, onCancel } = mount();
      await armed();
      fireEvent.keyDown(document, { key: "Enter", repeat: true });
      expect(onConfirm).not.toHaveBeenCalled();
      expect(onCancel).not.toHaveBeenCalled();
    });

    it("ignores an Enter that arrives in the frame the dialog appeared in", () => {
      const { onConfirm, onCancel } = mount(); // deliberately not armed
      fireEvent.keyDown(document, { key: "Enter" });
      expect(onConfirm).not.toHaveBeenCalled();
      expect(onCancel).not.toHaveBeenCalled();
    });

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
      await armed();
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

    it("arms on elapsed time when the frame callback never arrives", async () => {
      // WebKitGTK under the E2E harness does not reliably deliver the
      // `requestAnimationFrame` callback for a dialog that has just mounted. An
      // instrumented run of `nc5` captured `armed=false repeat=false
      // contains=true active=delete-confirm.confirm` on a dialog the same
      // failure's screenshot shows on screen, so Enter stayed inert for the full
      // 45 s budget three attempts over: a gate that can be shut forever is the
      // #397 behaviour wearing a guard's name.
      //
      // Stubbing rAF to never call back IS that WebView, and the wall clock is
      // what has to answer instead.
      const raf = vi.spyOn(window, "requestAnimationFrame").mockReturnValue(0);
      try {
        const { onConfirm, onCancel } = mount();
        await act(async () => {
          await new Promise<void>((resolve) => setTimeout(resolve, 40));
        });
        fireEvent.keyDown(document, { key: "Enter" });
        expect(onConfirm).toHaveBeenCalledTimes(1);
        expect(onCancel).not.toHaveBeenCalled();
      } finally {
        raf.mockRestore();
      }
    });

    it("refuses a held Enter that opened the dialog, whatever `repeat` reports", async () => {
      // Guard 2 cannot do this and an earlier revision of the component claimed
      // it could. OS typematic delay before the first auto-repeat is 250 ms to
      // 660 ms, so both the paint and the 16 ms clock have long armed the dialog
      // by the time a held key's first repeat arrives. If the WebView reports
      // `repeat: false` for that repeat, guard 1 admits it too.
      //
      // Guard 4 keys off the input instead of off a flag or a clock: a HELD key
      // emits repeats and never a keyup, so a caller that says "a key opened
      // this" gets an Enter that refuses until an Enter keyup has been seen. The
      // press below carries `repeat: false` deliberately, which is the exact
      // case the other two guards cannot tell from a fresh press.
      const { onConfirm, onCancel } = mount({ openedByKey: true });
      await armed();
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
      await armed();
      fireEvent.keyDown(document, { key: "Enter" });
      expect(onConfirm).toHaveBeenCalledTimes(1);
    });

    it("stays armed when the parent re-renders with fresh callbacks", async () => {
      // The arming guard has to mean "one frame since the DIALOG appeared". The
      // obvious spelling, `[onCancel, onConfirm]` as the listener effect's deps,
      // makes it mean "one frame since the parent last re-rendered" instead,
      // and `NoteList`'s keyboard soft-trash hands down an `onConfirm` that
      // closes over the state opening the dialog, so it is a new identity on
      // every render of a list that re-renders on save settles and sync ticks.
      //
      // This is not a hypothetical. It shipped for one E2E run: `nc5` timed out
      // three times over with the focus ring visibly on the confirm button and
      // Enter doing nothing, because the dialog was disarmed again after the
      // frame that armed it. Re-rendering here WITHOUT crossing another frame is
      // that state exactly.
      const { onConfirm, onCancel, rerender } = mount();
      await armed();
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
      await armed();
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
      await armed();
      fireEvent.keyDown(document, { key: "Enter" });
      expect(onCancel).toHaveBeenCalledTimes(1);
      expect(onConfirm).not.toHaveBeenCalled();
    });
  });
});
