// @vitest-environment jsdom
//
// Integration proof for the ModalShell ← useFocusTrap wiring (MYND-93, task 3).
// ModalShell is the shared chrome for the desktop modal carve-out, so trapping
// focus here transitively covers every modal that renders through it
// (TemplatesManager, NewNoteFromTemplateModal, the export/backup/attachment
// dialogs, the saved-view panels, …). Asserts the three guarantees end-to-end:
// focus enters on open, Tab wraps within, focus restores to the trigger on close.

import { afterEach, describe, expect, it } from "vitest";
import { render, cleanup, fireEvent } from "@testing-library/react";
import { useState } from "react";
import { ModalShell } from "../../src/components/primitives/ModalShell";

afterEach(() => cleanup());

function Harness() {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button data-testid="trigger" onClick={() => setOpen(true)}>
        open
      </button>
      <ModalShell
        open={open}
        title="Test dialog"
        labelId="test-dialog-title"
        onClose={() => setOpen(false)}
      >
        <button data-testid="a">a</button>
        <button data-testid="b">b</button>
      </ModalShell>
    </>
  );
}

describe("ModalShell focus trap", () => {
  it("moves focus into the dialog when opened and restores it on close", () => {
    const { getByTestId, getByRole } = render(<Harness />);
    const trigger = getByTestId("trigger");
    trigger.focus();
    expect(document.activeElement).toBe(trigger);

    fireEvent.click(trigger); // open
    // First focusable inside the shell is the header close button.
    const closeBtn = getByRole("button", { name: "Close" });
    expect(document.activeElement).toBe(closeBtn);

    fireEvent.keyDown(closeBtn, { key: "Escape" }); // window Esc → onClose → unmount
    expect(document.activeElement).toBe(trigger);
  });

  it("wraps Tab from the last focusable back to the first", () => {
    const { getByTestId, getByRole } = render(<Harness />);
    fireEvent.click(getByTestId("trigger"));

    const last = getByTestId("b");
    last.focus();
    fireEvent.keyDown(last, { key: "Tab" });
    // Wraps to the first focusable — the close button.
    expect(document.activeElement).toBe(getByRole("button", { name: "Close" }));
  });
});
