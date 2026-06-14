// @vitest-environment jsdom
//
// MYND-171: the "Clean unused attachments" review dialog
// (src/components/attachments/CleanUnusedAttachmentsDialog.tsx). Pins the
// rendered contract the E2E scenario drives — the kill-list rows, the
// confirm/cancel wiring (confirm passes the exact id set + surfaces the
// CleanResult summary; cancel deletes nothing), and the fail-path error
// banner — at the component level so a UI-wiring regression fails fast in
// Vitest even when the heavy tauri-driver E2E isn't run.

import { afterEach, describe, expect, it, vi } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";

import { CleanUnusedAttachmentsDialog } from "../../src/components/attachments/CleanUnusedAttachmentsDialog";
import type { CatalogEntry } from "../../src/lib/attachments";

afterEach(cleanup);

const UNUSED: CatalogEntry[] = [
  {
    id: "a".repeat(64),
    content_type: "image/png",
    created_at: 1,
    filename: "orphan.png",
    size: 2048,
  },
  {
    id: "b".repeat(64),
    content_type: "image/png",
    created_at: 2,
    filename: "never-inserted.png",
    size: 1024,
  },
];

describe("CleanUnusedAttachmentsDialog", () => {
  it("renders a row per unused attachment with the confirm/cancel controls", () => {
    render(
      <CleanUnusedAttachmentsDialog
        attachments={UNUSED}
        onConfirm={vi.fn()}
        onClose={vi.fn()}
      />,
    );
    expect(screen.getAllByTestId("clean-unused.row")).toHaveLength(2);
    expect(screen.getByText("orphan.png")).toBeTruthy();
    expect(screen.getByText("never-inserted.png")).toBeTruthy();
    expect(screen.getByTestId("clean-unused.confirm")).toBeTruthy();
    expect(screen.getByTestId("clean-unused.cancel")).toBeTruthy();
  });

  it("cancel closes without deleting anything", () => {
    const onConfirm = vi.fn();
    const onClose = vi.fn();
    render(
      <CleanUnusedAttachmentsDialog
        attachments={UNUSED}
        onConfirm={onConfirm}
        onClose={onClose}
      />,
    );
    fireEvent.click(screen.getByTestId("clean-unused.cancel"));
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it("confirm passes the exact id set and then shows the result summary", async () => {
    const onConfirm = vi
      .fn()
      .mockResolvedValue({ deleted: 2, skipped: 0, bytes_reclaimed: 3072 });
    render(
      <CleanUnusedAttachmentsDialog
        attachments={UNUSED}
        onConfirm={onConfirm}
        onClose={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByTestId("clean-unused.confirm"));

    expect(onConfirm).toHaveBeenCalledTimes(1);
    expect(onConfirm).toHaveBeenCalledWith([UNUSED[0].id, UNUSED[1].id]);

    const summary = await screen.findByTestId("clean-unused.summary");
    expect(summary.textContent).toContain("Removed 2 attachments");
    // The review controls are gone once the erase completed.
    expect(screen.queryByTestId("clean-unused.confirm")).toBeNull();
  });

  it("surfaces an error and stays on the review phase when the erase fails", async () => {
    const onConfirm = vi.fn().mockRejectedValue({ kind: "NoteScanFailed" });
    const onClose = vi.fn();
    render(
      <CleanUnusedAttachmentsDialog
        attachments={UNUSED}
        onConfirm={onConfirm}
        onClose={onClose}
      />,
    );
    fireEvent.click(screen.getByTestId("clean-unused.confirm"));

    await waitFor(() =>
      expect(screen.getByText(/nothing was deleted/i)).toBeTruthy(),
    );
    // No summary, dialog stays open (onClose not called).
    expect(screen.queryByTestId("clean-unused.summary")).toBeNull();
    expect(onClose).not.toHaveBeenCalled();
  });
});
