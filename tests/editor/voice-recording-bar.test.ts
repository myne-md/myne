// @vitest-environment jsdom
//
// Floating voice-recording bar (MYND-259): the body-mounted DOM surface with a
// live timer, an input-level meter, a silent-denial warning, Stop / Cancel, and
// a finalizing ("Saving…") state. Fake timers drive the elapsed-time tick + the
// silence-grace warning; the meter's rolling-history paint and the teardown
// (timer clear + DOM removal + registered unlisten) are exercised directly.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mountRecordingBar } from "../../src/editor/attachments/recordingBar";

function bar(): HTMLElement {
  return document.querySelector('[data-testid="voice-record-bar"]') as HTMLElement;
}
function el(testid: string): HTMLElement {
  return document.querySelector(`[data-testid="${testid}"]`) as HTMLElement;
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.runOnlyPendingTimers();
  vi.useRealTimers();
  document.body.innerHTML = "";
});

describe("mountRecordingBar", () => {
  it("mounts to the body with a timer, a 12-bar meter, and Stop / Cancel controls", () => {
    const handle = mountRecordingBar({ onStop: () => {}, onCancel: () => {} });
    expect(bar()).not.toBeNull();
    expect(bar().parentElement).toBe(document.body);
    expect(el("voice-record.timer").textContent).toBe("0:00");
    expect(bar().querySelectorAll(".cm-voice-rec-bar")).toHaveLength(12);
    expect(el("voice-record.stop").textContent).toBe("Stop");
    expect(el("voice-record.cancel").textContent).toBe("Cancel");
    // The silent-denial warning starts hidden.
    expect((el("voice-record.warning") as HTMLElement).hidden).toBe(true);
    handle.teardown();
  });

  it("fires onStop / onCancel when the buttons are clicked", () => {
    const onStop = vi.fn();
    const onCancel = vi.fn();
    const handle = mountRecordingBar({ onStop, onCancel });
    (el("voice-record.stop") as HTMLButtonElement).click();
    expect(onStop).toHaveBeenCalledOnce();
    (el("voice-record.cancel") as HTMLButtonElement).click();
    expect(onCancel).toHaveBeenCalledOnce();
    handle.teardown();
  });

  it("advances the elapsed-time readout as the timer ticks", () => {
    const handle = mountRecordingBar({ onStop: () => {}, onCancel: () => {} });
    vi.advanceTimersByTime(3000); // 3s elapsed
    expect(el("voice-record.timer").textContent).toBe("0:03");
    handle.teardown();
  });

  it("raises the silent-denial warning after the grace window with a flat meter", () => {
    const handle = mountRecordingBar({ onStop: () => {}, onCancel: () => {} });
    // No setLevel calls → maxLevel stays 0; past the 2.5s grace the warning shows.
    vi.advanceTimersByTime(3000);
    const warning = el("voice-record.warning") as HTMLElement;
    expect(warning.hidden).toBe(false);
    expect(warning.textContent).toBe("No audio detected. Check your microphone.");
    handle.teardown();
  });

  it("does NOT warn when the meter has seen real input above the silence floor", () => {
    const handle = mountRecordingBar({ onStop: () => {}, onCancel: () => {} });
    handle.setLevel(0.5); // well above the 0.02 silence floor
    vi.advanceTimersByTime(3000);
    expect((el("voice-record.warning") as HTMLElement).hidden).toBe(true);
    handle.teardown();
  });

  it("clears the silent-denial warning once real input arrives after it appeared", () => {
    const handle = mountRecordingBar({ onStop: () => {}, onCancel: () => {} });
    vi.advanceTimersByTime(3000);
    const warning = el("voice-record.warning") as HTMLElement;
    expect(warning.hidden).toBe(false);
    // The warning means "no input has been seen"; real input makes it false.
    handle.setLevel(0.5);
    expect(warning.hidden).toBe(true);
    handle.teardown();
  });

  it("setLevel paints the newest sample into the right-most meter bar", () => {
    const handle = mountRecordingBar({ onStop: () => {}, onCancel: () => {} });
    handle.setLevel(1); // max input → tallest bar height (12 + sqrt(1)*88 = 100%)
    const bars = bar().querySelectorAll(".cm-voice-rec-bar");
    const last = bars[bars.length - 1] as HTMLElement;
    expect(last.style.height).toBe("100%");
    // The oldest bar (shifted in as 0) sits at the floor height (12%).
    expect((bars[0] as HTMLElement).style.height).toBe("12%");
    handle.teardown();
  });

  it("clamps out-of-range levels into [0, 1] before painting", () => {
    const handle = mountRecordingBar({ onStop: () => {}, onCancel: () => {} });
    handle.setLevel(5); // clamps to 1 → 100%
    const bars = bar().querySelectorAll(".cm-voice-rec-bar");
    expect((bars[bars.length - 1] as HTMLElement).style.height).toBe("100%");
    handle.setLevel(-3); // clamps to 0 → 12% floor
    expect((bars[bars.length - 1] as HTMLElement).style.height).toBe("12%");
    handle.teardown();
  });

  it("setBusy disables the controls and switches Stop to 'Saving…'", () => {
    const handle = mountRecordingBar({ onStop: () => {}, onCancel: () => {} });
    handle.setBusy();
    const stop = el("voice-record.stop") as HTMLButtonElement;
    const cancel = el("voice-record.cancel") as HTMLButtonElement;
    expect(stop.disabled).toBe(true);
    expect(cancel.disabled).toBe(true);
    expect(stop.textContent).toBe("Saving…");
    handle.teardown();
  });

  it("teardown removes the bar, stops the timer, and runs registered unlisten fns", () => {
    const handle = mountRecordingBar({ onStop: () => {}, onCancel: () => {} });
    const unlisten = vi.fn();
    handle.onTeardown(unlisten);
    handle.teardown();
    expect(bar()).toBeNull();
    expect(unlisten).toHaveBeenCalledOnce();
    // After teardown the timer is cleared — a further advance must not re-show
    // the warning or otherwise touch the removed DOM.
    expect(() => vi.advanceTimersByTime(5000)).not.toThrow();
  });
});
