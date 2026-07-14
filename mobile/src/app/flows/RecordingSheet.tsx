// Voice-note recording sheet (mobile) — the UI half of the WebView voice-capture
// feature. Drives the headless `lib/voiceRecord` handle: on mount it requests the
// mic and starts capturing; a live red waveform + running timer + Stop mirror the
// ED-05 `VoiceRecording` design mock. On Stop it hands the encoded `audio/wav`
// File back to the editor (which imports it via the existing attachment path and
// embeds `![[att:<id>|Voice note ….wav]]`). A permission denial renders the SYS-02
// "Microphone access is off" state inside the sheet.

import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Sheet, Spinner } from "../../components";
import { Button } from "../../components/Button";
import { startVoiceCapture, type VoiceCaptureHandle, type VoiceCaptureErrorKind, VoiceCaptureError } from "../../lib/voiceRecord";

/** Number of waveform bars in the live meter (matches the ED-05 REC_BARS feel). */
const BAR_COUNT = 28;

function mmss(totalMs: number): string {
  const s = Math.floor(totalMs / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

export function RecordingSheet({
  onRecorded,
  onClose,
}: {
  /** Called with the finished WAV File when the user stops (editor imports +
   *  embeds it). May be async; the sheet stays in "saving" until it resolves. */
  onRecorded: (file: File) => void | Promise<void>;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const [phase, setPhase] = useState<"starting" | "recording" | "saving" | "error">("starting");
  const [errorKind, setErrorKind] = useState<VoiceCaptureErrorKind>("generic");
  const [elapsedMs, setElapsedMs] = useState(0);
  const [bars, setBars] = useState<number[]>(() => new Array(BAR_COUNT).fill(0.06));

  const handleRef = useRef<VoiceCaptureHandle | null>(null);
  const startedAtRef = useRef(0);
  const doneRef = useRef(false); // guards double-stop / stop-after-cancel

  // Start capture on mount. A failure (permission / no-device / unsupported)
  // lands in the "error" phase; the SYS-02 copy handles permission specifically.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const handle = await startVoiceCapture();
        if (cancelled) {
          handle.cancel();
          return;
        }
        handleRef.current = handle;
        startedAtRef.current = performance.now();
        handle.onLevel((level) => {
          setBars((prev) => [...prev.slice(1), Math.max(0.06, level)]);
        });
        setPhase("recording");
      } catch (err) {
        if (cancelled) return;
        setErrorKind(err instanceof VoiceCaptureError ? err.kind : "generic");
        setPhase("error");
      }
    })();
    return () => {
      cancelled = true;
      // Unmounted mid-recording (e.g. sheet dismissed) → release the mic.
      if (!doneRef.current) handleRef.current?.cancel();
    };
  }, []);

  // Running timer while recording.
  useEffect(() => {
    if (phase !== "recording") return;
    const id = window.setInterval(() => setElapsedMs(performance.now() - startedAtRef.current), 200);
    return () => window.clearInterval(id);
  }, [phase]);

  const stop = async () => {
    const handle = handleRef.current;
    if (!handle || doneRef.current) return;
    doneRef.current = true;
    setPhase("saving");
    try {
      const file = await handle.stop();
      await onRecorded(file);
      onClose();
    } catch (err) {
      doneRef.current = false;
      setErrorKind(err instanceof VoiceCaptureError ? err.kind : "generic");
      setPhase("error");
    }
  };

  const closeCancel = () => {
    if (!doneRef.current) handleRef.current?.cancel();
    onClose();
  };

  // ── Permission-denied / error state (mirrors SYS-02) ─────────────────────────
  if (phase === "error") {
    const denied = errorKind === "permissionDenied" || errorKind === "unsupported";
    const heading = denied ? t("recording.deniedTitle") : t("recording.errorTitle");
    const body = denied
      ? t("recording.deniedBody")
      : errorKind === "noInputDevice"
        ? t("recording.noDeviceBody")
        : errorKind === "empty"
          ? t("recording.emptyBody")
          : t("recording.genericBody");
    return (
      <Sheet onClose={closeCancel}>
        <div data-testid="voice-record.denied" style={{ padding: "8px 6px 4px", textAlign: "center" }}>
          <svg width="46" height="46" viewBox="0 0 46 46" fill="none" style={{ margin: "6px auto 0", display: "block" }}>
            <path d="M23 9a6 6 0 0 1 6 6v6M17 15v6c0 4-2 6-4 8h20" stroke="var(--fg-3)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
            <circle cx="23" cy="34" r="2" fill="var(--fg-3)" />
            <path d="M6 6l34 34" stroke="var(--fg-3)" strokeWidth="2" strokeLinecap="round" />
          </svg>
          <h2 style={{ margin: "18px 0 0", fontSize: 20, fontWeight: 600, color: "var(--fg-display)", letterSpacing: "-0.02em" }}>{heading}</h2>
          <p style={{ margin: "10px auto 20px", fontSize: 15, lineHeight: 1.6, color: "var(--fg-2)", maxWidth: 300 }}>{body}</p>
          <Button variant="ghost" onClick={closeCancel} style={{ color: "var(--fg-3)", fontWeight: 600 }}>
            {t("notes.import.offer.notNow")}
          </Button>
        </div>
      </Sheet>
    );
  }

  // ── Recording / starting / saving state (mirrors ED-05 record bar) ───────────
  return (
    <Sheet grabber={!(phase === "saving")} onClose={phase === "saving" ? undefined : closeCancel}>
      <div data-testid="voice-record-bar" style={{ display: "flex", alignItems: "center", gap: 14, padding: "6px 4px" }}>
        <span
          style={{
            width: 11,
            height: 11,
            flex: "none",
            borderRadius: "50%",
            background: "var(--danger)",
            opacity: phase === "recording" ? 1 : 0.4,
            animation: phase === "recording" ? "myne-rec-pulse 1.2s ease-in-out infinite" : undefined,
          }}
        />
        <span style={{ fontFamily: "var(--font-mono)", fontSize: 16, color: "var(--fg-1)", minWidth: 46 }}>{mmss(elapsedMs)}</span>
        <div style={{ flex: 1, display: "flex", alignItems: "center", gap: 2, height: 26, minWidth: 0, overflow: "hidden" }}>
          {bars.map((h, i) => (
            <span
              key={i}
              style={{
                flex: 1,
                minWidth: 2,
                height: `${Math.round(h * 100)}%`,
                borderRadius: 1.5,
                background: "var(--danger)",
                opacity: 0.35 + h * 0.65,
              }}
            />
          ))}
        </div>
        {phase === "saving" ? (
          <div style={{ display: "flex", alignItems: "center", gap: 8, height: 38, padding: "0 12px", color: "var(--fg-2)", fontSize: 14 }}>
            <Spinner size={16} /> {t("editor.attachment.recording.saving")}
          </div>
        ) : (
          <button
            data-testid="voice-record.stop"
            onClick={() => void stop()}
            disabled={phase !== "recording"}
            aria-label={t("recording.stopAria")}
            style={{
              flex: "none",
              height: 38,
              padding: "0 18px",
              border: "none",
              borderRadius: 8,
              background: "var(--ink-1)",
              color: "var(--paper)",
              fontFamily: "var(--font-sans)",
              fontSize: 14,
              fontWeight: 600,
              cursor: "pointer",
              opacity: phase === "recording" ? 1 : 0.6,
            }}
          >
            {t("editor.attachment.recording.stop")}
          </button>
        )}
      </div>
      <style>{"@keyframes myne-rec-pulse{0%,100%{opacity:1}50%{opacity:0.35}}"}</style>
    </Sheet>
  );
}
