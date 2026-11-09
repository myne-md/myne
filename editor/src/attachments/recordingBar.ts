// Floating recording bar for voice notes (MYND-259).
//
// A vanilla-DOM surface mounted to `document.body` (same posture as the toast /
// overflow menu — it escapes the `.cm-editor` theme scope). Shows the elapsed
// time, a live input-level meter, and Stop / Cancel. The meter doubles as the
// "is it working" signal: on macOS a denied mic surfaces as silence (a flat
// meter), which after a grace window raises a "no audio detected" warning.
//
// All visible text is set via `textContent` (never `innerHTML`) per TB2.

import { formatClock } from "@myne/editor/host/components/attachments/format";
import i18n from "@myne/editor/i18n";
import { ensureAttachmentInsertStyles } from "./styles";

const METER_BARS = 12;
const TIMER_TICK_MS = 250;
/** After this long with a near-silent meter, warn the user (silent-denial). */
const SILENCE_GRACE_MS = 2500;
const SILENCE_LEVEL = 0.02;

export interface RecordingBarHandle {
  /** Feed a `[0, 1]` input level to the meter (drives the VU + silence check). */
  setLevel(level: number): void;
  /** Switch to the finalizing state (disable controls, "Saving…"). */
  setBusy(): void;
  /** Remove the bar + run teardown callbacks (timers, event unlisten). */
  teardown(): void;
  /** Register a teardown callback (e.g. the level-event unlisten). */
  onTeardown(fn: () => void): void;
}

export interface RecordingBarOptions {
  onStop: () => void;
  onCancel: () => void;
}

/** Mount the recording bar and return a handle to drive + tear it down. */
export function mountRecordingBar(opts: RecordingBarOptions): RecordingBarHandle {
  ensureAttachmentInsertStyles();
  const startedAt = Date.now();
  let maxLevel = 0;
  const teardownFns: Array<() => void> = [];

  const bar = document.createElement("div");
  bar.className = "cm-voice-rec";
  bar.setAttribute("role", "dialog");
  bar.setAttribute("aria-label", i18n.t("editor.attachment.recording.barAria"));
  bar.setAttribute("data-testid", "voice-record-bar");

  const dot = document.createElement("span");
  dot.className = "cm-voice-rec-dot";
  bar.appendChild(dot);

  const time = document.createElement("span");
  time.className = "cm-voice-rec-time";
  time.setAttribute("data-testid", "voice-record.timer");
  time.textContent = "0:00";
  bar.appendChild(time);

  const meter = document.createElement("div");
  meter.className = "cm-voice-rec-meter";
  meter.setAttribute("data-testid", "voice-record.meter");
  const bars: HTMLElement[] = [];
  // A rolling history of recent input levels — one per bar — so the meter reads
  // as a live waveform that scrolls left as you talk, not a left-to-right fill.
  const levels: number[] = new Array(METER_BARS).fill(0);
  for (let i = 0; i < METER_BARS; i++) {
    const b = document.createElement("span");
    b.className = "cm-voice-rec-bar";
    meter.appendChild(b);
    bars.push(b);
  }
  bar.appendChild(meter);

  const warning = document.createElement("span");
  warning.className = "cm-voice-rec-warning";
  warning.setAttribute("data-testid", "voice-record.warning");
  warning.hidden = true;
  bar.appendChild(warning);

  const stop = document.createElement("button");
  stop.type = "button";
  stop.className = "cm-voice-rec-stop";
  stop.setAttribute("data-testid", "voice-record.stop");
  stop.textContent = i18n.t("editor.attachment.recording.stop");
  stop.addEventListener("click", () => opts.onStop());
  bar.appendChild(stop);

  const cancel = document.createElement("button");
  cancel.type = "button";
  cancel.className = "cm-voice-rec-cancel";
  cancel.setAttribute("data-testid", "voice-record.cancel");
  cancel.textContent = i18n.t("common.cancel");
  cancel.addEventListener("click", () => opts.onCancel());
  bar.appendChild(cancel);

  document.body.appendChild(bar);

  const tick = window.setInterval(() => {
    const elapsed = Date.now() - startedAt;
    time.textContent = formatClock(elapsed / 1000);
    if (elapsed > SILENCE_GRACE_MS && maxLevel < SILENCE_LEVEL) {
      warning.hidden = false;
      warning.textContent = i18n.t("editor.attachment.recording.noAudio");
    }
  }, TIMER_TICK_MS);
  teardownFns.push(() => window.clearInterval(tick));

  return {
    setLevel(level: number): void {
      const clamped = Math.min(1, Math.max(0, level));
      if (clamped > maxLevel) maxLevel = clamped;
      // The warning means "no input has been seen", so real input clears it.
      // Without this it latched: a quiet start kept "No audio detected" on a
      // recording whose microphone was working, with no path back to hidden.
      if (clamped >= SILENCE_LEVEL) warning.hidden = true;
      // Scroll the rolling history one step (oldest out, newest in) and paint
      // each bar's height from its stored level — a moving waveform of the
      // recent input. A modest curve (sqrt) makes quiet speech still visible.
      levels.shift();
      levels.push(clamped);
      for (let i = 0; i < bars.length; i++) {
        const h = 12 + Math.sqrt(levels[i]) * 88;
        // `scaleY` of a full-height box, NOT `height` (myne-md/myne#773). The
        // geometry is identical because the meter centres its children, but this
        // loop runs at audio rate over every bar and a height write lays out the
        // whole row each time; a transform write does not.
        bars[i].style.transform = `scaleY(${(h / 100).toFixed(4)})`;
      }
    },
    setBusy(): void {
      stop.disabled = true;
      cancel.disabled = true;
      stop.textContent = i18n.t("editor.attachment.recording.saving");
    },
    teardown(): void {
      for (const fn of teardownFns) fn();
      bar.remove();
    },
    onTeardown(fn: () => void): void {
      teardownFns.push(fn);
    },
  };
}
