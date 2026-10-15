// The audio-transcript reader (mobile, myne-md/myne#886).
//
// The mobile counterpart of the desktop `TranscriptionModal`. Deliberately not
// an inventory twin pair: the two answer "show me what was said" with different
// affordance sets, because the desktop modal is read-only by SYNC-17 while a
// phone has no second surface to reach Copy, Save-as-note or Insert from. What
// they DO share is the answer rather than the layout, and it is shared by
// construction: the same verbatim `AI_TRANSCRIPT_HONESTY_NOTE` from `@myne/copy`
// beside the text, and the same read-before-run rule.
//
// This surface exists because the row widget it replaced could not do the job: a
// transcript is READ, it is often long, and that widget dumped the whole text
// under the file row (pushing the list down, with no scroll), offered no way to
// copy it, and lost it the moment the sheet closed. The device-local `MYE1`
// cache held it and nothing read it back.
//
// It owns the whole lifecycle (`idle → running → done → error`) and the actions
// that belong with a transcript: Copy, Save-as-note (works from the Files tab,
// where no note is open), and, in the in-editor sheet only, Insert into the open
// note.
//
// # Reading before running (parity with desktop, deliberately)
//
// On open it probes the cache (`readTranscript`). A transcript that already
// exists is shown directly, never re-derived. Only a miss offers Transcribe.
// Desktop splits this into "Transcribe" and "View transcription"; mobile reaches
// the same two states through one sheet rather than two affordances, which is a
// presentation difference and not a behavioural one.
//
// The two are gated differently, and that split is the desktop rule: reading
// needs no engine, so a cached transcript stays readable with speech-to-text
// OFF. Only the Transcribe action is behind `transcriptionEnabled`.
//
// # Plaintext
//
// The transcript is note-class (AS1) plaintext derived from the audio. It is
// read from the sealed `MYE1` cache, held in this component's state while the
// sheet is open (closing the sheet drops the reference), written into a note by
// Save and to the OS pasteboard by Copy. Rendered, never logged.

import { useCallback, useEffect, useRef, useState, type CSSProperties } from "react";
import { useTranslation } from "react-i18next";
import { Sheet, Spinner, Button } from "../../components";
import { showToast } from "../../components/ToastHost";
import { copyText } from "@myne/clipboard";
import { writeText as clipboardWriteText } from "../../lib/clipboardTransport";
import {
  readTranscript,
  startTranscription,
  type TranscribeError,
} from "../../lib/transcribe";
import { buildMeetingNote, type MeetingNoteCopy } from "@myne/meeting-note";
import { AI_TRANSCRIPT_HONESTY_NOTE } from "../../lib/load-bearing-copy";
import { createTitledNote } from "../../lib/notes";

/** `loading` is the cache probe; the other four are the transcription lifecycle. */
type Phase = "loading" | "idle" | "running" | "done" | "error";

/** Join streamed segments as paragraphs. The model emits a segment per phrase,
 *  and the backend's own `full` string is their plain concatenation (its engine
 *  asserts `segments.concat() == full`), so a long clip would otherwise render
 *  as one run-on block. */
function joinSegments(segments: readonly string[]): string {
  return segments
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
    .join("\n\n");
}

export function TranscriptSheet({
  attachmentId,
  filename,
  transcriptionEnabled,
  onInsertText,
  onSavedNote,
  onClose,
}: {
  attachmentId: string;
  /** The audio attachment's display filename. It is the sheet's own heading and
   *  the seed for a saved note's title. */
  filename: string;
  /** Whether the speech-to-text pref is on. It gates the Transcribe ACTION only:
   *  a cached transcript is readable either way, because reading needs no
   *  engine (the desktop rule, which this surface follows). */
  transcriptionEnabled: boolean;
  /** When provided (the in-editor attachments sheet), a finished transcript
   *  shows "Insert transcript into note", appending its TEXT to the open note.
   *  Omitted on the Files tab, where there is no open note. */
  onInsertText?: (text: string) => void;
  /** When provided, a note saved from the transcript is opened by the caller
   *  rather than merely reported. */
  onSavedNote?: (noteId: string) => void;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const [phase, setPhase] = useState<Phase>("loading");
  const [text, setText] = useState("");
  const [errKind, setErrKind] = useState<TranscribeError["kind"] | null>(null);
  const [saving, setSaving] = useState(false);
  // A run resolves after the sheet may have closed; every state write is gated
  // on this so an abandoned run cannot resurrect an unmounted surface.
  const mountedRef = useRef(true);
  // The streamed segments as they arrive, so the transcript can be joined at
  // phrase boundaries rather than concatenated into one run-on block.
  const segmentsRef = useRef<string[]>([]);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  // Probe the cache once (desktop's "View transcription" state). A cached
  // transcript is shown as-is; no cache means the idle Transcribe affordance.
  useEffect(() => {
    let cancelled = false;
    void readTranscript(attachmentId).then((cached) => {
      if (cancelled) return;
      if (cached !== null && cached.trim().length > 0) {
        setText(cached);
        setPhase("done");
      } else {
        setPhase("idle");
      }
    });
    return () => {
      cancelled = true;
    };
  }, [attachmentId]);

  const run = useCallback(() => {
    setPhase("running");
    setText("");
    setErrKind(null);
    segmentsRef.current = [];
    const { done } = startTranscription(attachmentId, (seg) => {
      segmentsRef.current.push(seg);
      setText(joinSegments(segmentsRef.current));
    });
    done
      .then((full) => {
        if (!mountedRef.current) return;
        // Prefer the phrase-joined form so the preview and the finished text
        // agree; `full` is the fallback for a run that streamed nothing.
        const joined = joinSegments(segmentsRef.current);
        setText(joined.length > 0 ? joined : full);
        setPhase("done");
      })
      .catch((e: TranscribeError) => {
        if (!mountedRef.current) return;
        setErrKind(e.kind);
        setPhase("error");
      });
  }, [attachmentId]);

  const onCopy = useCallback(() => {
    void copyText(clipboardWriteText, text, {
      onSuccess: {
        kind: "toast",
        run: () => showToast(t("attachments.library.transcriptCopied")),
      },
      onFailure: {
        // Ordinary content rather than a once-only secret, so a transient toast:
        // the sheet may already be closing, and re-reading the text is one tap
        // away regardless.
        kind: "toast",
        run: () => showToast(t("attachments.library.transcriptCopyFailed")),
      },
    });
  }, [t, text]);

  const onSaveNote = useCallback(async () => {
    setSaving(true);
    try {
      // The meeting-note pattern, so a saved transcript carries its own audio:
      // the attachment embed first, then the transcript under a heading with the
      // machine-transcript notice above it. Reusing the shared builder keeps the
      // two "transcript became a note" paths identical.
      const copy: MeetingNoteCopy = {
        transcriptHeading: t("editor.meeting.transcriptHeading"),
        machineNotice: t("editor.meeting.machineNotice"),
      };
      const body = buildMeetingNote([{ attachmentId }], text, copy);
      const name = t("attachments.library.transcriptNoteTitle", { name: filename });
      // Shared with the meeting drain, so a saved transcript and a meeting note
      // stamp their `title:` the same way.
      const noteId = await createTitledNote(body, name);
      showToast(t("attachments.library.transcriptSaved"));
      onSavedNote?.(noteId);
      onClose();
    } catch {
      showToast(t("attachments.library.transcriptSaveFailed"));
    } finally {
      if (mountedRef.current) setSaving(false);
    }
  }, [attachmentId, filename, onClose, onSavedNote, t, text]);

  const hasText = text.trim().length > 0;

  return (
    <Sheet
      onClose={onClose}
      style={{ maxHeight: "92%", display: "flex", flexDirection: "column", overflow: "hidden" }}
    >
      <div
        data-testid="files.transcript-sheet"
        data-attachment-id={attachmentId}
        style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: "var(--space-2)", flex: "none" }}
      >
        <span
          style={{ fontSize: "var(--text-lg)", fontWeight: "var(--weight-semibold)", color: "var(--fg-1)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}
          title={filename}
        >
          {filename}
        </span>
        {/* Desktop keeps Transcribe available beside View transcription, so a
            model swap can re-derive an existing transcript. Same here: the run
            action stays reachable from the done state (and only there when the
            pref is on, since it needs the engine). */}
        {phase === "done" && transcriptionEnabled && (
          <Button
            variant="ghost"
            full={false}
            onClick={run}
            data-testid="files.transcript-retranscribe"
            style={{ flexShrink: 0, height: 36, padding: "0 12px", fontSize: "var(--text-sm)" }}
          >
            {t("attachments.library.menuTranscribe")}
          </Button>
        )}
      </div>

      <div style={{ marginTop: "var(--space-3)", flex: 1, minHeight: 0, overflowY: "auto" }}>
        {phase === "loading" && (
          <div style={{ display: "flex", justifyContent: "center", padding: "var(--space-6)" }}>
            <Spinner />
          </div>
        )}

        {phase === "idle" &&
          (transcriptionEnabled ? (
            <Button onClick={run} data-testid="files.transcript-start">
              {t("attachments.library.menuTranscribe")}
            </Button>
          ) : (
            // No cached transcript and the engine is off, so there is nothing to
            // show and nothing to run. Say which of the two it is rather than
            // leaving an empty sheet.
            <p style={DISCLAIMER} data-testid="files.transcript-off">
              {t("editor.attachment.widget.transcribe.cause.featureOff")}
            </p>
          ))}

        {phase === "running" && (
          <div data-testid="files.transcript-running">
            <div style={{ display: "flex", alignItems: "center", gap: "var(--space-2)", color: "var(--fg-3)", marginBottom: "var(--space-1)" }}>
              <Spinner />
              <span style={{ fontSize: "var(--text-sm)" }}>
                {t("attachments.library.transcribeStarted")}
              </span>
            </div>
            {hasText && <div style={TRANSCRIPT_TEXT}>{text}</div>}
          </div>
        )}

        {phase === "done" && (
          <div data-testid="files.transcript-done">
            {/* Load-bearing honesty note, rendered VERBATIM and never i18n'd
                (SYNC-8). Same literal as the desktop modal, from `@myne/copy`. */}
            <p style={DISCLAIMER} data-testid="files.transcript-disclaimer">
              {AI_TRANSCRIPT_HONESTY_NOTE}
            </p>
            {hasText ? (
              <div style={TRANSCRIPT_TEXT} data-testid="files.transcript-text">
                {text}
              </div>
            ) : (
              // Silence is an accepted backend outcome. Reporting it is honest;
              // offering Copy/Save here would persist a note with no transcript.
              <p style={DISCLAIMER} data-testid="files.transcript-empty">
                {t("attachments.library.transcriptEmpty")}
              </p>
            )}
          </div>
        )}

        {phase === "error" && (
          <div data-testid="files.transcript-error">
            <div style={{ fontSize: "var(--text-sm)", color: "var(--danger)" }}>
              {errKind === "not_ready"
                ? t("attachments.library.transcribeNoModel")
                : errKind === "too_long"
                  ? t("editor.attachment.widget.transcribe.cause.tooLong")
                  : t("attachments.library.transcribeFailed")}
            </div>
            {/* No retry for "too_long": the same clip is refused every time, so
                offering the button would be advice that cannot work (myne#485). */}
            {errKind !== "too_long" && (
              <div style={{ marginTop: "var(--space-3)" }}>
                <Button variant="ghost" onClick={run}>
                  {t("attachments.library.menuTranscribe")}
                </Button>
              </div>
            )}
          </div>
        )}
      </div>

      {phase === "done" && hasText && (
        <div style={{ flex: "none", display: "flex", flexDirection: "column", gap: "var(--space-2)", marginTop: "var(--space-3)" }}>
          {onInsertText && (
            <Button onClick={() => onInsertText(text)} data-testid="files.transcript-insert">
              {t("editor.attachment.widget.transcribe.insert")}
            </Button>
          )}
          <div style={{ display: "flex", gap: "var(--space-2)" }}>
            <Button
              variant="secondary"
              full={false}
              onClick={onCopy}
              data-testid="files.transcript-copy"
              style={{ flex: 1 }}
            >
              {t("attachments.library.transcriptCopy")}
            </Button>
            <Button
              variant="secondary"
              full={false}
              onClick={() => void onSaveNote()}
              disabled={saving}
              data-testid="files.transcript-save"
              style={{ flex: 1 }}
            >
              {t("attachments.library.transcriptSave")}
            </Button>
          </div>
        </div>
      )}
    </Sheet>
  );
}

const DISCLAIMER: CSSProperties = {
  margin: "0 0 var(--space-2)",
  fontSize: "var(--text-sm)",
  lineHeight: 1.5,
  color: "var(--fg-3)",
};

/** Comfortable reading measure for a long transcript: sans, generous leading,
 *  wrapping, selectable. A mono face (the desktop modal's choice) suits a
 *  transcript less on a phone, where the line wraps every few words. */
const TRANSCRIPT_TEXT: CSSProperties = {
  fontSize: "var(--text-base)",
  lineHeight: 1.6,
  color: "var(--fg-1)",
  whiteSpace: "pre-wrap",
  wordBreak: "break-word",
  userSelect: "text",
};
