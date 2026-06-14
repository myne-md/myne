// @vitest-environment jsdom
//
// MYND-255 task 5: the PDF pre-export exclusion notice
// (`src/components/export/NotePdfExportNotice.tsx`). The component is
// deliberately thin (all decision logic is flow-side and pinned in
// exportPdfFlow.test.ts) — these tests pin the rendered contract the
// E2E scenario (task 6) drives: the two load-bearing sentences rendered
// VERBATIM from `load-bearing-copy.ts`, the excluded-filename list, the
// testids, and the cancel/confirm wiring (no toggle — exclusions aren't
// optional).

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

import { NotePdfExportNotice } from "../../src/components/export/NotePdfExportNotice";
import {
  EXPORT_PDF_EXCLUSION_SENTENCE,
  EXPORT_PDF_PLAIN_SENTENCE,
} from "../../src/lib/load-bearing-copy";

afterEach(cleanup);

const EXCLUDED = [
  { id: "a".repeat(64), filename: "report.pdf" },
  { id: "b".repeat(64), filename: "archive.pdf" },
];

describe("NotePdfExportNotice", () => {
  it("renders nothing when closed", () => {
    render(
      <NotePdfExportNotice
        open={false}
        excludedAttachments={EXCLUDED}
        onCancel={vi.fn()}
        onConfirm={vi.fn()}
      />,
    );
    expect(screen.queryByTestId("export.pdf-notice")).toBeNull();
  });

  it("renders both load-bearing sentences verbatim + the excluded filenames", () => {
    render(
      <NotePdfExportNotice
        open
        excludedAttachments={EXCLUDED}
        onCancel={vi.fn()}
        onConfirm={vi.fn()}
      />,
    );
    // Full-literal equality with the shared constants (SYNC-8 discipline).
    expect(screen.getByText(EXPORT_PDF_PLAIN_SENTENCE)).toBeTruthy();
    expect(screen.getByText(EXPORT_PDF_EXCLUSION_SENTENCE)).toBeTruthy();
    expect(screen.getByText("report.pdf")).toBeTruthy();
    expect(screen.getByText("archive.pdf")).toBeTruthy();
    expect(screen.getByTestId("export.pdf-notice")).toBeTruthy();
    expect(screen.getByTestId("export.pdf-confirm")).toBeTruthy();
    expect(screen.getByTestId("export.pdf-cancel")).toBeTruthy();
  });

  it("carries no toggle — exclusions aren't optional", () => {
    render(
      <NotePdfExportNotice
        open
        excludedAttachments={EXCLUDED}
        onCancel={vi.fn()}
        onConfirm={vi.fn()}
      />,
    );
    expect(
      screen
        .getByTestId("export.pdf-notice")
        .querySelectorAll('input[type="checkbox"]').length,
    ).toBe(0);
  });

  it("Continue… fires onConfirm", () => {
    const onConfirm = vi.fn();
    render(
      <NotePdfExportNotice
        open
        excludedAttachments={EXCLUDED}
        onCancel={vi.fn()}
        onConfirm={onConfirm}
      />,
    );
    fireEvent.click(screen.getByTestId("export.pdf-confirm"));
    expect(onConfirm).toHaveBeenCalledTimes(1);
  });

  it("Cancel button and Esc both fire onCancel (free exit)", () => {
    const onCancel = vi.fn();
    render(
      <NotePdfExportNotice
        open
        excludedAttachments={EXCLUDED}
        onCancel={onCancel}
        onConfirm={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByTestId("export.pdf-cancel"));
    fireEvent.keyDown(window, { key: "Escape" });
    expect(onCancel).toHaveBeenCalledTimes(2);
  });
});
