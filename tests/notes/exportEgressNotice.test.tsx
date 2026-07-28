// @vitest-environment jsdom
//
// The download path's egress disclosure (`ExportEgressNotice`,
// phase3-web-client task 98). Thin component — the ordering logic that makes it
// load-bearing is flow-side and pinned in `exportDownloadDisclosure.test.ts`.
// What is pinned here is the rendered contract: the sentence appears EXACTLY as
// the flow handed it over, the refusal path exists and is free, and the testids
// the web E2E lane will drive are present.

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

import { ExportEgressNotice } from "../../src/components/export/ExportEgressNotice";
import {
  EXPORT_PLAIN_HTML_SENTENCE,
  EXPORT_PLAIN_MARKDOWN_SENTENCE,
  EXPORT_PLAIN_TEXT_SENTENCE,
} from "../../src/lib/load-bearing-copy";

afterEach(cleanup);

describe("ExportEgressNotice", () => {
  it("renders nothing when closed", () => {
    render(
      <ExportEgressNotice
        open={false}
        sentence={EXPORT_PLAIN_MARKDOWN_SENTENCE}
        onCancel={vi.fn()}
        onConfirm={vi.fn()}
      />,
    );
    expect(screen.queryByTestId("export.egress-notice")).toBeNull();
  });

  it.each([
    ["markdown", EXPORT_PLAIN_MARKDOWN_SENTENCE],
    ["html", EXPORT_PLAIN_HTML_SENTENCE],
    ["text", EXPORT_PLAIN_TEXT_SENTENCE],
  ])("renders the %s sentence verbatim, character for character", (_name, sentence) => {
    render(
      <ExportEgressNotice
        open
        sentence={sentence}
        onCancel={vi.fn()}
        onConfirm={vi.fn()}
      />,
    );
    // `textContent` equality rather than a text query: this catches a wrapper
    // that appends, prefixes or interpolates — including the specific failure
    // this component invites, someone "fixing" the untranslated paragraph by
    // routing it through `t()`, which would emit the KEY when no catalog is
    // loaded and still satisfy a substring assertion in a locale where the
    // translation happened to start with the same words.
    expect(screen.getByTestId("export.egress-sentence").textContent).toBe(sentence);
  });

  it("offers a refusal, and refusing is one click", () => {
    // The disclosure is only meaningful if declining is as available as
    // accepting. A notice with an acknowledge-only button is a notification.
    const onCancel = vi.fn();
    const onConfirm = vi.fn();
    render(
      <ExportEgressNotice
        open
        sentence={EXPORT_PLAIN_MARKDOWN_SENTENCE}
        onCancel={onCancel}
        onConfirm={onConfirm}
      />,
    );
    fireEvent.click(screen.getByTestId("export.egress-cancel"));
    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it("treats Esc as a refusal", () => {
    const onCancel = vi.fn();
    render(
      <ExportEgressNotice
        open
        sentence={EXPORT_PLAIN_MARKDOWN_SENTENCE}
        onCancel={onCancel}
        onConfirm={vi.fn()}
      />,
    );
    fireEvent.keyDown(window, { key: "Escape" });
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it("confirms only on the confirm control", () => {
    const onConfirm = vi.fn();
    render(
      <ExportEgressNotice
        open
        sentence={EXPORT_PLAIN_MARKDOWN_SENTENCE}
        onCancel={vi.fn()}
        onConfirm={onConfirm}
      />,
    );
    fireEvent.click(screen.getByTestId("export.egress-confirm"));
    expect(onConfirm).toHaveBeenCalledTimes(1);
  });

  it("is a labelled modal dialog", () => {
    render(
      <ExportEgressNotice
        open
        sentence={EXPORT_PLAIN_MARKDOWN_SENTENCE}
        onCancel={vi.fn()}
        onConfirm={vi.fn()}
      />,
    );
    const dialog = screen.getByRole("dialog");
    expect(dialog.getAttribute("aria-modal")).toBe("true");
    expect(dialog.getAttribute("aria-labelledby")).toBe("export-egress-title");
  });
});
