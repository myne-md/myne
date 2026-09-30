// Floating meeting-session bar (myne-md/myne#789).
//
// Deliberately the same posture as `recordingBar.ts` next door: a vanilla-DOM
// surface mounted to `document.body` so it escapes the `.cm-editor` theme
// scope, carrying elapsed time, a live input-level meter, Stop and Cancel. All
// visible text is set via `textContent`, never `innerHTML` (TB2).
//
// What a meeting bar carries that a recording bar does not:
//
// - **Transcript blocks.** The session emits one block per finished clip
//   (roughly every twelve minutes, because transcription is attachment-keyed
//   and clips are cap-sized), and they accumulate here. This is the surface
//   that makes the session's progress visible at all.
// - **A system-audio silence warning.** A denied CoreAudio tap delivers
//   buffers, zeroed, and there is no public API to preflight the permission, so
//   the only answerable question is "is this stream silent while the microphone
//   is not". The backend asks it and this bar shows the result. It is a second,
//   separate warning from the microphone one, because the two mean different
//   things and only one of them is the user's own voice.
// - **A stated platform limitation**, passed in by the caller: on Linux and on
//   macOS below 14.2 there is no system-audio path at all, and saying so before
//   the session starts is the difference between a limitation and a surprise.

import { formatClock } from "@myne/editor/host/components/attachments/format";
import i18n from "@myne/editor/i18n";
import { ensureAttachmentInsertStyles } from "./styles";

const METER_BARS = 12;
const TIMER_TICK_MS = 250;
/** After this long with a near-silent meter, warn the user (silent-denial). */
const SILENCE_GRACE_MS = 2500;
const SILENCE_LEVEL = 0.02;
/** How many transcript blocks stay on screen. The full transcript is in the
 *  note; this is a progress signal, and a bar that grew without bound would
 *  cover the editor it is meant to sit beside. */
const MAX_TRANSCRIPT_BLOCKS = 4;

export interface MeetingBarHandle {
  /** Feed a `[0, 1]` mixed level to the meter. */
  setLevel(level: number): void;
  /** Append a finished clip's transcript block. */
  addTranscript(text: string): void;
  /** Show the system-audio silence warning (idempotent). */
  warnTapSilence(): void;
  /** Report whether this session armed a system-audio source. The platform
   *  notice renders only where the answer is `false`. */
  setSystemAudioAvailable(available: boolean): void;
  /** Show the clip-import-failure warning (idempotent). */
  warnClipFailed(): void;
  /** Switch to the finalizing state (disable controls, "Saving…"). */
  setBusy(): void;
  /** Remove the bar + run teardown callbacks. */
  teardown(): void;
  /** Register a teardown callback (e.g. an event unlisten). */
  onTeardown(fn: () => void): void;
}

export interface MeetingBarOptions {
  onStop: () => void;
  onCancel: () => void;
}

/** Mount the meeting bar and return a handle to drive + tear it down. */
export function mountMeetingBar(opts: MeetingBarOptions): MeetingBarHandle {
  ensureAttachmentInsertStyles();
  const startedAt = Date.now();
  let maxLevel = 0;
  const teardownFns: Array<() => void> = [];

  const bar = document.createElement("div");
  bar.className = "cm-voice-rec cm-meeting-rec";
  bar.setAttribute("role", "dialog");
  bar.setAttribute("aria-label", i18n.t("editor.meeting.barAria"));
  bar.setAttribute("data-testid", "meeting-bar");

  const dot = document.createElement("span");
  dot.className = "cm-voice-rec-dot";
  bar.appendChild(dot);

  const time = document.createElement("span");
  time.className = "cm-voice-rec-time";
  time.setAttribute("data-testid", "meeting.timer");
  time.textContent = "0:00";
  bar.appendChild(time);

  const meter = document.createElement("div");
  meter.className = "cm-voice-rec-meter";
  meter.setAttribute("data-testid", "meeting.meter");
  const bars: HTMLElement[] = [];
  const levels: number[] = new Array(METER_BARS).fill(0);
  for (let i = 0; i < METER_BARS; i++) {
    const b = document.createElement("span");
    b.className = "cm-voice-rec-bar";
    meter.appendChild(b);
    bars.push(b);
  }
  bar.appendChild(meter);

  const warnings = document.createElement("div");
  warnings.className = "cm-meeting-rec-warnings";
  bar.appendChild(warnings);

  // The platform notice is a STANDING line rather than a warning: it stays true
  // for the whole session, so it must not read as something that just went
  // wrong. It starts HIDDEN and is revealed by `setSystemAudioAvailable(false)`,
  // because the backend is the only thing that knows what this session armed:
  // rendering it unconditionally told every macOS 14.2+ user that the other
  // participants would not be in the note while they were being captured.
  const notice = document.createElement("span");
  notice.className = "cm-meeting-rec-notice";
  notice.setAttribute("data-testid", "meeting.system-audio-notice");
  notice.hidden = true;
  warnings.appendChild(notice);

  const micWarning = document.createElement("span");
  micWarning.className = "cm-voice-rec-warning";
  micWarning.setAttribute("data-testid", "meeting.mic-warning");
  micWarning.hidden = true;
  warnings.appendChild(micWarning);

  const tapWarning = document.createElement("span");
  tapWarning.className = "cm-voice-rec-warning";
  tapWarning.setAttribute("data-testid", "meeting.tap-warning");
  tapWarning.hidden = true;
  warnings.appendChild(tapWarning);

  const clipWarning = document.createElement("span");
  clipWarning.className = "cm-voice-rec-warning";
  clipWarning.setAttribute("data-testid", "meeting.clip-warning");
  clipWarning.hidden = true;
  warnings.appendChild(clipWarning);

  const transcript = document.createElement("div");
  transcript.className = "cm-meeting-rec-transcript";
  transcript.setAttribute("data-testid", "meeting.transcript");
  bar.appendChild(transcript);

  const stop = document.createElement("button");
  stop.type = "button";
  stop.className = "cm-voice-rec-stop";
  stop.setAttribute("data-testid", "meeting.stop");
  stop.textContent = i18n.t("editor.meeting.stop");
  stop.addEventListener("click", () => opts.onStop());
  bar.appendChild(stop);

  const cancel = document.createElement("button");
  cancel.type = "button";
  cancel.className = "cm-voice-rec-cancel";
  cancel.setAttribute("data-testid", "meeting.cancel");
  cancel.textContent = i18n.t("editor.meeting.cancel");
  cancel.addEventListener("click", () => opts.onCancel());
  bar.appendChild(cancel);

  document.body.appendChild(bar);

  const tick = window.setInterval(() => {
    const elapsed = Date.now() - startedAt;
    time.textContent = formatClock(elapsed / 1000);
    if (elapsed > SILENCE_GRACE_MS && maxLevel < SILENCE_LEVEL) {
      micWarning.hidden = false;
      // The same warning the voice bar shows, so the same key: a second
      // key holding the same English string is a duplicate the i18n guard
      // rejects, and a second wording would be a second thing to translate.
      micWarning.textContent = i18n.t("editor.attachment.recording.noAudio");
    }
  }, TIMER_TICK_MS);
  teardownFns.push(() => window.clearInterval(tick));

  return {
    setLevel(level: number): void {
      const clamped = Math.min(1, Math.max(0, level));
      if (clamped > maxLevel) maxLevel = clamped;
      levels.shift();
      levels.push(clamped);
      for (let i = 0; i < bars.length; i++) {
        const h = 12 + Math.sqrt(levels[i]) * 88;
        bars[i].style.height = `${h}%`;
      }
    },
    addTranscript(text: string): void {
      const trimmed = text.trim();
      if (trimmed.length === 0) return;
      const block = document.createElement("p");
      block.className = "cm-meeting-rec-block";
      block.setAttribute("data-testid", "meeting.transcript-block");
      block.textContent = trimmed;
      transcript.appendChild(block);
      while (transcript.childElementCount > MAX_TRANSCRIPT_BLOCKS) {
        transcript.removeChild(transcript.firstElementChild as Element);
      }
      transcript.scrollTop = transcript.scrollHeight;
    },
    warnTapSilence(): void {
      tapWarning.hidden = false;
      tapWarning.textContent = i18n.t("editor.meeting.tapSilent");
    },
    setSystemAudioAvailable(available: boolean): void {
      notice.hidden = available;
      if (!available) notice.textContent = i18n.t("editor.meeting.systemAudioUnavailable");
    },
    warnClipFailed(): void {
      clipWarning.hidden = false;
      clipWarning.textContent = i18n.t("editor.meeting.clipFailed");
    },
    setBusy(): void {
      stop.disabled = true;
      cancel.disabled = true;
      stop.textContent = i18n.t("editor.meeting.saving");
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
