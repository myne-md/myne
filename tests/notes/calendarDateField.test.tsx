// @vitest-environment jsdom
//
// The calendar's date picker (myne-md/myne#1037).
//
// The first claim is the one that shipped broken: the day cells rendered with no
// children at all, so the picker drew an empty month and the only visible marks
// were the selection's fill and today's ring. Nothing else catches that - the
// cells exist, carry `data-date`, and answer a click - which is why this asserts
// the TEXT of a cell rather than its presence.
//
// The second claim is the value: a pick writes the canonical `YYYY-MM-DD`, never
// what the trigger prints, because the trigger follows the user's date format and
// the note does not.

import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { act } from "react";
import { createRoot } from "react-dom/client";
import {
  setDateTimeDisplay,
  __resetDateTimeDisplayForTest,
  DEFAULT_DISPLAY,
} from "@myne/editor/host/lib/datetimeFormat";

import { DateField } from "../../src/notes/calendar/fields";

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

beforeEach(() => {
  setDateTimeDisplay({ ...DEFAULT_DISPLAY, dateFormat: "iso", timeFormat: "24h", locale: "en" });
});
afterEach(() => {
  __resetDateTimeDisplayForTest();
});

describe("the date picker", () => {
  it("draws a number in every day cell of the open month", async () => {
    const { host, cleanup } = await render(
      <DateField label="Start date" value="2026-11-05" onChange={() => undefined} testId="d" />,
    );
    await act(async () => {
      (host.querySelector('[data-testid="d"]') as HTMLElement).click();
    });

    // The panel is a PORTAL into the body, so it is not inside `host`.
    const cell = document.querySelector('[data-date="2026-11-12"]') as HTMLElement;
    expect(cell).not.toBeNull();
    // The number, not the date: a cell printing `2026-11-12` would be a different
    // bug, and a cell printing nothing is the one that shipped.
    expect(cell.textContent?.trim()).toBe("12");
    // Padding days belong to the month drawn around them, so 30 October is a cell
    // too - and it still says which day it is.
    expect((document.querySelector('[data-date="2026-10-30"]') as HTMLElement).textContent?.trim()).toBe("30");
    cleanup();
  });

  it("writes the canonical date, not the printed one", async () => {
    const picked: (string | null)[] = [];
    const { host, cleanup } = await render(
      <DateField label="Start date" value={null} onChange={(next) => picked.push(next)} testId="d" />,
    );
    await act(async () => {
      (host.querySelector('[data-testid="d"]') as HTMLElement).click();
    });
    await act(async () => {
      (document.querySelector('[data-date="2026-11-12"]') as HTMLElement).click();
    });
    expect(picked).toEqual(["2026-11-12"]);
    cleanup();
  });
});
