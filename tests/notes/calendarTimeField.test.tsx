// @vitest-environment jsdom
//
// The calendar's time field (myne-md/myne#1037).
//
// It is two of the app's own dropdowns now, and the claim that needs holding is
// the composition: an hour keeps the minute it was not asked about, and the value
// written is the STORED 24-hour form even when the labels read on a 12-hour clock.
// A field that wrote whatever it displayed would put `9:00 AM` in a note whose
// grammar says `09:00`.
//
// The display format is forced to 24h so the assertions can name exact strings: on
// `system` the labels come from the platform locale and the test would be asserting
// ICU's data rather than this field's behaviour.

import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { act } from "react";
import { createRoot } from "react-dom/client";
import {
  setDateTimeDisplay,
  __resetDateTimeDisplayForTest,
  DEFAULT_DISPLAY,
} from "@myne/editor/host/lib/datetimeFormat";

import { TimeField } from "../../src/notes/calendar/fields";

async function render(node: React.ReactNode): Promise<{ host: HTMLElement; cleanup: () => void }> {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  await act(async () => {
    root.render(node);
  });
  return {
    host,
    cleanup: () => {
      act(() => root.unmount());
      host.remove();
    },
  };
}

/** The option labelled `label` in the menu a `Select` opens into the body. */
function option(label: string): HTMLElement {
  const found = [...document.querySelectorAll('[role="option"]')].find(
    (el) => el.textContent?.trim() === label,
  );
  if (found === undefined || found === null) throw new Error(`no option ${label}`);
  return found as HTMLElement;
}

beforeEach(() => {
  setDateTimeDisplay({ ...DEFAULT_DISPLAY, timeFormat: "24h", locale: "en" });
});
afterEach(() => {
  __resetDateTimeDisplayForTest();
});

describe("the time field", () => {
  it("keeps the minute when the hour changes, and writes the stored form", async () => {
    const onChange = vi.fn();
    const { host, cleanup } = await render(
      <TimeField label="Start time" value="09:30" onChange={onChange} testId="t" />,
    );
    await act(async () => {
      (host.querySelector('[data-testid="t-hour"]') as HTMLElement).click();
    });
    expect(option("14")).not.toBeNull();
    await act(async () => {
      option("14").click();
    });
    expect(onChange).toHaveBeenCalledWith("14:30");
    cleanup();
  });

  it("keeps the hour when the minute changes", async () => {
    const onChange = vi.fn();
    const { host, cleanup } = await render(
      <TimeField label="Start time" value="09:30" onChange={onChange} testId="t" />,
    );
    await act(async () => {
      (host.querySelector('[data-testid="t-minute"]') as HTMLElement).click();
    });
    await act(async () => {
      option("45").click();
    });
    expect(onChange).toHaveBeenCalledWith("09:45");
    cleanup();
  });

  it("offers the minute the value already carries, so a hand-written 09:07 survives", async () => {
    const { host, cleanup } = await render(
      <TimeField label="Start time" value="09:07" onChange={() => undefined} testId="t" />,
    );
    await act(async () => {
      (host.querySelector('[data-testid="t-minute"]') as HTMLElement).click();
    });
    expect(option("07")).not.toBeNull();
    cleanup();
  });
});
