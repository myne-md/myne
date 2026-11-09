// @vitest-environment jsdom
//
// The attachment OCR switch on mobile, and the task-marker row that is
// deliberately NOT here (myne-md/myne#880 task 11).
//
// # Two different remedies, in one file because they are one task
//
// The OCR switch is a control: `attachment_ocr_enabled` is DEVICE-LOCAL and OCR
// runs in-process on the phone, so the device paying the compute cost could not
// turn it off. The row fixes that, and the property that makes it more than a
// stored flag is that the import path reads the pref to select the extractor
// (`mobile/src-tauri/src/plugins/attachments/import_mobile.rs`, whose own tests
// assert the selection).
//
// The task marker is the opposite: `show_task_marker` is SHARED and the mobile
// note list renders no marker at all, so a toggle here would be the exact inert
// control this feature exists to remove. Its remedy is the rendering feature,
// not a row, and the choice is recorded rather than left silent. The second
// describe below is what makes that choice checkable instead of a claim in a
// commit message.

import { readFileSync } from "node:fs";
import { join } from "node:path";

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const invoke = vi.fn();

vi.mock("../../src/platform/core", () => ({
  invoke: (...args: unknown[]) => invoke(...args),
}));

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

import { AttachmentOcrBlock } from "../../src/components/AttachmentOcrBlock";

function writes(cmd: string): unknown[] {
  return invoke.mock.calls
    .filter((c) => (c as [string])[0] === cmd)
    .map((c) => (c as [string, Record<string, unknown>])[1]);
}

beforeEach(() => {
  invoke.mockReset();
  invoke.mockImplementation(async () => undefined);
});

afterEach(cleanup);

describe("the mobile attachment OCR switch", () => {
  it("writes the pref through the chokepoint when toggled off", async () => {
    render(<AttachmentOcrBlock enabled />);
    // `Switch` takes no testId, so the hook is on the wrapper; the switch itself
    // is the role=switch inside it.
    fireEvent.click(screen.getByTestId("settings.attachmentOcr.toggle").firstElementChild!);

    await waitFor(() =>
      expect(writes("plugin:prefs|set_attachment_ocr_enabled")).toHaveLength(1),
    );
    // The DEVICE-LOCAL shape: the payload is the boolean, and the command is the
    // one the import path reads.
    expect(writes("plugin:prefs|set_attachment_ocr_enabled")[0]).toEqual({ enabled: false });
  });

  it("toggles back on, and sends the value the switch now shows", async () => {
    render(<AttachmentOcrBlock enabled={false} />);
    fireEvent.click(screen.getByTestId("settings.attachmentOcr.toggle").firstElementChild!);

    await waitFor(() =>
      expect(writes("plugin:prefs|set_attachment_ocr_enabled")).toHaveLength(1),
    );
    expect(writes("plugin:prefs|set_attachment_ocr_enabled")[0]).toEqual({ enabled: true });
  });

  it("rolls the switch back when the write is rejected", async () => {
    // A control that keeps showing a value the vault does not hold is the failure
    // the whole feature is about, so the rollback is asserted rather than assumed.
    invoke.mockRejectedValueOnce(new Error("locked"));
    render(<AttachmentOcrBlock enabled />);
    fireEvent.click(screen.getByTestId("settings.attachmentOcr.toggle").firstElementChild!);

    await waitFor(() =>
      expect(screen.getByTestId("settings.attachmentOcr.toggle").dataset.on).toBe("true"),
    );
  });

  it("prints the desktop's one helper line and nothing else", () => {
    render(<AttachmentOcrBlock enabled />);
    // The per-device line and the draft paragraph were removed on 2026-11-08
    // (owner: "delete that, make it identical to desktop"), so the row is the
    // label and the shared `helper` — the same two strings
    // `AttachmentOcrSettings.tsx` renders. Asserted as an ABSENCE pair as well as
    // a presence, because a filter that removed the helper too would pass a
    // presence-only check on the wrong string.
    expect(screen.getByTestId("settings.attachmentOcr.helper").textContent).toContain(
      "settings.attachmentOcr.helper",
    );
    expect(screen.queryByTestId("settings.attachmentOcr.scope")).toBeNull();
    expect(screen.queryByTestId("settings.attachmentOcr.draft-use")).toBeNull();
  });
});

describe("the task marker is recorded as deliberately absent, not shipped inert", () => {
  it("carries a reason in the parity record that says why no row exists", () => {
    // The record is the durable home of the decision: a hidden control with no
    // stated reason is indistinguishable from an oversight, which is why this
    // task's outcome is a reason rather than a row.
    const raw: string = readFileSync(
      join(process.cwd(), "..", "scripts", "prefs-parity.json"),
      "utf8",
    );
    const record = JSON.parse(raw) as { oneSided: Record<string, unknown> };
    const entry = record.oneSided["set_show_task_marker"];
    const reason = typeof entry === "string" ? entry : (entry as { reason?: string })?.reason ?? "";
    expect(reason).toMatch(/render|marker/i);
    // It must not read as an open question any more: the choice is made.
    expect(reason).not.toMatch(/either by adding the row|resolves it in task 11/i);
  });
});
