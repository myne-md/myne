// @vitest-environment jsdom
//
// Floating meeting-session bar (myne-md/myne#789): the body-mounted DOM
// surface with a live timer, an input-level meter, the arriving per-clip
// transcript blocks, the two distinct warnings (microphone silent vs
// system-audio silent) and the standing platform notice, Stop / Cancel, and a
// finalizing state.

import { afterEach, describe, expect, it, vi } from "vitest";
import { mountMeetingBar } from "../../src/editor/attachments/meetingBar";

const tid = (id: string) => document.querySelector(`[data-testid="${id}"]`);

afterEach(() => {
  document.body.innerHTML = "";
});

describe("mountMeetingBar", () => {
  it("renders the bar with a timer, a meter and both controls", () => {
    const bar = mountMeetingBar({ onStop: () => {}, onCancel: () => {} });
    expect(tid("meeting-bar")).not.toBeNull();
    expect(tid("meeting.timer")?.textContent).toBe("0:00");
    expect(tid("meeting.meter")).not.toBeNull();
    expect(tid("meeting.stop")).not.toBeNull();
    expect(tid("meeting.cancel")).not.toBeNull();
    bar.teardown();
  });

  it("drives the meter from the level it is given", () => {
    const bar = mountMeetingBar({ onStop: () => {}, onCancel: () => {} });
    const before = Array.from(
      document.querySelectorAll<HTMLElement>(".cm-voice-rec-bar"),
    ).map((b) => b.style.height);
    bar.setLevel(1);
    const after = Array.from(
      document.querySelectorAll<HTMLElement>(".cm-voice-rec-bar"),
    ).map((b) => b.style.height);
    expect(after).not.toEqual(before);
    bar.teardown();
  });

  it("appends transcript blocks in the order they arrive", () => {
    const bar = mountMeetingBar({ onStop: () => {}, onCancel: () => {} });
    bar.addTranscript("first");
    bar.addTranscript("second");
    const blocks = Array.from(
      document.querySelectorAll('[data-testid="meeting.transcript-block"]'),
    ).map((b) => b.textContent);
    expect(blocks).toEqual(["first", "second"]);
    bar.teardown();
  });

  it("ignores an empty or whitespace-only transcript block", () => {
    const bar = mountMeetingBar({ onStop: () => {}, onCancel: () => {} });
    bar.addTranscript("   \n ");
    expect(
      document.querySelectorAll('[data-testid="meeting.transcript-block"]'),
    ).toHaveLength(0);
    bar.teardown();
  });

  it("caps the visible transcript so the bar cannot cover the editor", () => {
    const bar = mountMeetingBar({ onStop: () => {}, onCancel: () => {} });
    for (let i = 0; i < 10; i++) bar.addTranscript(`block ${i}`);
    const blocks = document.querySelectorAll(
      '[data-testid="meeting.transcript-block"]',
    );
    // The full transcript is in the note; this surface is a progress signal.
    expect(blocks.length).toBeLessThanOrEqual(4);
    expect(blocks[blocks.length - 1].textContent).toBe("block 9");
    bar.teardown();
  });

  it("clears the microphone warning once the meter sees real input", () => {
    vi.useFakeTimers();
    try {
      const bar = mountMeetingBar({ onStop: () => {}, onCancel: () => {} });
      const warning = tid("meeting.mic-warning") as HTMLElement;
      // A quiet start past the grace window raises the warning...
      vi.advanceTimersByTime(3000);
      expect(warning.hidden).toBe(false);
      // ...and the first above-floor level clears it, because the microphone
      // is demonstrably working. Without the clear the warning latched for the
      // rest of the session (the tap's aggregate-device build can start the
      // level stream after the grace window elapses).
      bar.setLevel(0.5);
      expect(warning.hidden).toBe(true);
      bar.teardown();
    } finally {
      vi.useRealTimers();
    }
  });

  it("shows the system-audio warning only when told to", () => {
    const bar = mountMeetingBar({ onStop: () => {}, onCancel: () => {} });
    const warning = tid("meeting.tap-warning") as HTMLElement;
    expect(warning.hidden).toBe(true);
    bar.warnTapSilence();
    expect(warning.hidden).toBe(false);
    expect(warning.textContent).not.toBe("");
    bar.teardown();
  });

  it("shows the clip-failure warning only when told to", () => {
    const bar = mountMeetingBar({ onStop: () => {}, onCancel: () => {} });
    const warning = tid("meeting.clip-warning") as HTMLElement;
    expect(warning.hidden).toBe(true);
    bar.warnClipFailed();
    expect(warning.hidden).toBe(false);
    bar.teardown();
  });

  it("keeps the platform notice hidden until the backend says otherwise", () => {
    // The bar must NOT claim the other participants are missing before it
    // knows. Rendering that unconditionally told every macOS 14.2+ user that
    // they were absent while they were being captured, which is a false
    // statement about a recording of other people's speech.
    const bar = mountMeetingBar({ onStop: () => {}, onCancel: () => {} });
    const notice = tid("meeting.system-audio-notice") as HTMLElement;
    expect(notice.hidden).toBe(true);
    bar.setSystemAudioAvailable(true);
    expect(notice.hidden).toBe(true);
    bar.setSystemAudioAvailable(false);
    expect(notice.hidden).toBe(false);
    expect(notice.textContent).not.toBe("");
    bar.teardown();
  });

  it("does not confuse the platform notice with the tap-silence warning", () => {
    const bar = mountMeetingBar({ onStop: () => {}, onCancel: () => {} });
    bar.setSystemAudioAvailable(false);
    bar.warnTapSilence();
    expect((tid("meeting.system-audio-notice") as HTMLElement).hidden).toBe(false);
    expect((tid("meeting.tap-warning") as HTMLElement).hidden).toBe(false);
    bar.teardown();
  });

  it("calls onStop and onCancel from their buttons", () => {
    const onStop = vi.fn();
    const onCancel = vi.fn();
    const bar = mountMeetingBar({ onStop, onCancel });
    (tid("meeting.stop") as HTMLButtonElement).click();
    expect(onStop).toHaveBeenCalledOnce();
    (tid("meeting.cancel") as HTMLButtonElement).click();
    expect(onCancel).toHaveBeenCalledOnce();
    bar.teardown();
  });

  it("teardown removes the surface and runs every registered callback", () => {
    const bar = mountMeetingBar({ onStop: () => {}, onCancel: () => {} });
    const onTeardown = vi.fn();
    bar.onTeardown(onTeardown);
    bar.teardown();
    expect(onTeardown).toHaveBeenCalledOnce();
    expect(tid("meeting-bar")).toBeNull();
  });

  it("setBusy disables both controls", () => {
    const bar = mountMeetingBar({ onStop: () => {}, onCancel: () => {} });
    bar.setBusy();
    expect((tid("meeting.stop") as HTMLButtonElement).disabled).toBe(true);
    expect((tid("meeting.cancel") as HTMLButtonElement).disabled).toBe(true);
    bar.teardown();
  });
});
