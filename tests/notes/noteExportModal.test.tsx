// @vitest-environment jsdom
//
// MYND-116 task 3: the pre-flight "Include attachments" mini-modal
// (`src/components/export/NoteExportModal.tsx`). The component is
// deliberately thin (all decision logic is flow-side and pinned in
// exportFlow.test.ts) — these tests pin the rendered contract the E2E
// scenario (task 5) will drive: the load-bearing egress copy rendered
// VERBATIM from `load-bearing-copy.ts`, the attachment count, the
// testids, and the cancel/confirm wiring (incl. the opt-in default:
// toggle starts OFF).

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

import { NoteExportModal } from "../../src/components/export/NoteExportModal";
import {
  EXPORT_ATTACHMENTS_PLACEMENT_SUBLABEL,
  EXPORT_PLAIN_MARKDOWN_SENTENCE,
} from "../../src/lib/load-bearing-copy";

afterEach(cleanup);

describe("NoteExportModal", () => {
  it("renders nothing when closed", () => {
    render(
      <NoteExportModal
        open={false}
        attachmentCount={2}
        onCancel={vi.fn()}
        onConfirm={vi.fn()}
      />,
    );
    expect(screen.queryByTestId("export.modal")).toBeNull();
  });

  it("renders the load-bearing copy verbatim + the attachment count", () => {
    render(
      <NoteExportModal
        open
        attachmentCount={3}
        onCancel={vi.fn()}
        onConfirm={vi.fn()}
      />,
    );
    // Full-literal equality with the shared constants (SYNC-8 discipline).
    expect(screen.getByText(EXPORT_PLAIN_MARKDOWN_SENTENCE)).toBeTruthy();
    expect(screen.getByText(EXPORT_ATTACHMENTS_PLACEMENT_SUBLABEL)).toBeTruthy();
    expect(screen.getByText("Include 3 attachments")).toBeTruthy();
    expect(screen.getByTestId("export.modal")).toBeTruthy();
    expect(screen.getByTestId("export.include-attachments-toggle")).toBeTruthy();
    expect(screen.getByTestId("export.confirm")).toBeTruthy();
    expect(screen.getByTestId("export.cancel")).toBeTruthy();
  });

  it("singular count reads 'Include 1 attachment'", () => {
    render(
      <NoteExportModal
        open
        attachmentCount={1}
        onCancel={vi.fn()}
        onConfirm={vi.fn()}
      />,
    );
    expect(screen.getByText("Include 1 attachment")).toBeTruthy();
  });

  it("confirm with the default (OFF) toggle reports includeAttachments=false", () => {
    const onConfirm = vi.fn();
    render(
      <NoteExportModal
        open
        attachmentCount={2}
        onCancel={vi.fn()}
        onConfirm={onConfirm}
      />,
    );
    fireEvent.click(screen.getByTestId("export.confirm"));
    expect(onConfirm).toHaveBeenCalledWith(false);
  });

  it("toggling on then confirming reports includeAttachments=true", () => {
    const onConfirm = vi.fn();
    render(
      <NoteExportModal
        open
        attachmentCount={2}
        onCancel={vi.fn()}
        onConfirm={onConfirm}
      />,
    );
    fireEvent.click(screen.getByTestId("export.include-attachments-toggle"));
    fireEvent.click(screen.getByTestId("export.confirm"));
    expect(onConfirm).toHaveBeenCalledWith(true);
  });

  it("Cancel button and Esc both fire onCancel (free exit)", () => {
    const onCancel = vi.fn();
    render(
      <NoteExportModal
        open
        attachmentCount={2}
        onCancel={onCancel}
        onConfirm={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByTestId("export.cancel"));
    fireEvent.keyDown(window, { key: "Escape" });
    expect(onCancel).toHaveBeenCalledTimes(2);
  });
});
