// Meeting AI dialog (meeting-ai task 4).
//
// The opt-in pass, from the offer to the write: pick the sections, run the
// map-reduce (with progress and a stop), review the result, and insert it. It
// is mounted once in the Editor and driven by the offer store, so the meeting
// session (not React) can raise it.
//
// Coded against the design canon: `ModalShell` for the chrome, `SettingRow` for
// the section toggles, `Switch` and `Button` for the controls. No inline
// literals, so every value is a token and the surface is themable.

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactElement,
} from "react";
import { useTranslation } from "react-i18next";
import type { TFunction } from "i18next";

import i18n from "../../i18n";
import { Button } from "../primitives/Button";
import { ModalShell } from "../primitives/ModalShell";
import { Switch } from "../primitives/Switch";
import { SettingRow } from "../settings/SettingRow";
import { loadModelPath } from "../../lib/ai-model-store";
import { prefsRead } from "../../lib/prefs";
import { runInferBatch } from "../../lib/meeting-ai";
import { startMeetingAi, type MeetingRun } from "../../notes/ai/meetingRun";
import {
  MEETING_SECTION_HEADINGS,
  MEETING_SECTION_IDS,
  type MeetingSectionId,
  type MeetingSections,
} from "../../notes/ai/meetingSections";
import { writeMeetingSectionsToNote } from "../../notes/ai/meetingWriteToNote";
import type { FrontmatterSettleTarget } from "../../notes/settleFrontmatterWrite";
import {
  clearMeetingAiOffer,
  getMeetingAiOffer,
  subscribeMeetingAi,
} from "./meetingAiStore";

type Phase = "pick" | "running" | "review" | "error" | "cancelled";

/** The label for one section. Explicit `t()` literals, so the i18n guard sees
 *  every key (a template literal would be invisible to it). */
function sectionLabel(id: MeetingSectionId, t: TFunction): string {
  switch (id) {
    case "summary":
      return t("editor.meeting.ai.section.summary");
    case "actionItems":
      return t("editor.meeting.ai.section.actionItems");
    case "decisions":
      return t("editor.meeting.ai.section.decisions");
    case "openQuestions":
      return t("editor.meeting.ai.section.openQuestions");
  }
}

/** Mounted once in the Editor; renders nothing until an offer exists. */
export function MeetingAiDialog({
  onOpenAiSettings,
  settle,
}: {
  /** Opens Settings -> AI (the generation-model download surface). */
  onOpenAiSettings?: () => void;
  /** Reloads the open pane after the insert writes the note to disk. */
  settle?: FrontmatterSettleTarget;
} = {}): ReactElement | null {
  const offer = useSyncExternalStore(
    subscribeMeetingAi,
    getMeetingAiOffer,
    getMeetingAiOffer,
  );
  if (offer === null) return null;
  // `key` resets the inner state when a new offer replaces an old one.
  return (
    <MeetingAiDialogInner
      key={offer.noteId}
      noteId={offer.noteId}
      transcript={offer.transcript}
      onOpenAiSettings={onOpenAiSettings}
      settle={settle}
    />
  );
}

function MeetingAiDialogInner({
  noteId,
  transcript,
  onOpenAiSettings,
  settle,
}: {
  noteId: string;
  transcript: string;
  onOpenAiSettings?: () => void;
  settle?: FrontmatterSettleTarget;
}): ReactElement {
  const { t } = useTranslation();
  const [phase, setPhase] = useState<Phase>("pick");
  const [selected, setSelected] = useState<Record<MeetingSectionId, boolean>>(
    () =>
      Object.fromEntries(
        MEETING_SECTION_IDS.map((id) => [id, true]),
      ) as Record<MeetingSectionId, boolean>,
  );
  const [sections, setSections] = useState<MeetingSections>({});
  const [progress, setProgress] = useState<[number, number]>([0, 0]);
  const [noModel, setNoModel] = useState(false);
  const runRef = useRef<MeetingRun | null>(null);
  // Set by Stop/close and checked after the async prefs read, so a Stop pressed
  // before the run is created (the `prefsRead` await window) is not lost.
  const stoppedRef = useRef(false);

  // The generation model is the AI output's prerequisite (the meeting feature's
  // Whisper model is a DIFFERENT role). Checked once on mount, and only at the
  // START: the gate is visibility-only, so a model removed mid-run does not stop
  // a running pass.
  useEffect(() => {
    let cancelled = false;
    void loadModelPath("generation")
      .then((path) => {
        if (!cancelled) setNoModel(path === null);
      })
      .catch(() => {
        // A failed probe is not proof of absence; leave the pass available and
        // let the run surface its own error.
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const close = useCallback((): void => {
    stoppedRef.current = true;
    runRef.current?.stop();
    clearMeetingAiOffer();
  }, []);

  const generate = useCallback((): void => {
    void (async () => {
      stoppedRef.current = false;
      const chosen = MEETING_SECTION_IDS.filter((id) => selected[id]);
      setPhase("running");
      setProgress([0, 0]);
      // The custom prompt, read at run start: a blank or absent value uses the
      // built-in default instruction.
      const prefs = await prefsRead().catch(() => null);
      // A Stop pressed during the prefs read must not be lost: without this the
      // run started anyway and the UI flipped back to the review phase.
      if (stoppedRef.current) {
        setPhase("cancelled");
        return;
      }
      const run = startMeetingAi({
        transcript,
        sections: chosen,
        customInstruction: prefs?.meeting_ai_prompt ?? null,
        runBatch: runInferBatch,
        onProgress: (done, total) => setProgress([done, total]),
      });
      runRef.current = run;
      try {
        const result = await run.result;
        if (result.cancelled) {
          setPhase("cancelled");
          return;
        }
        setSections(result.sections);
        setPhase("review");
      } catch {
        setPhase("error");
      }
    })();
  }, [transcript, selected]);

  const insert = useCallback((): void => {
    void writeMeetingSectionsToNote(
      noteId,
      sections,
      i18n.t("editor.meeting.ai.notice"),
      settle,
    )
      .then(() => {
        clearMeetingAiOffer();
      })
      .catch(() => {
        setPhase("error");
      });
  }, [noteId, sections]);

  const present = MEETING_SECTION_IDS.filter((id) => {
    const text = sections[id];
    return text !== undefined && text.trim().length > 0;
  });

  return (
    <ModalShell
      open
      title={t("editor.meeting.ai.title")}
      onClose={close}
      labelId="meeting-ai-title"
      testId="meeting.ai-dialog"
    >
      {phase === "pick" && noModel && (
        <>
          <p data-testid="meeting.ai.no-model">
            {t("editor.meeting.ai.noModel")}
          </p>
          <div>
            {onOpenAiSettings !== undefined && (
              <Button
                variant="primary"
                data-testid="meeting.ai.open-settings"
                onClick={() => {
                  onOpenAiSettings();
                  close();
                }}
              >
                {t("editor.meeting.ai.openSettings")}
              </Button>
            )}
            <Button variant="secondary" onClick={close}>
              {t("editor.meeting.ai.close")}
            </Button>
          </div>
        </>
      )}

      {phase === "pick" && !noModel && (
        <>
          <p>{t("editor.meeting.ai.pickIntro")}</p>
          <p>{t("editor.meeting.ai.noAttribution")}</p>
          {MEETING_SECTION_IDS.map((id) => (
            <SettingRow
              key={id}
              label={sectionLabel(id, t)}
              testId={`meeting.ai.section.${id}`}
              control={
                <Switch
                  checked={selected[id]}
                  onChange={(next) =>
                    setSelected((prev) => ({ ...prev, [id]: next }))
                  }
                  ariaLabel={sectionLabel(id, t)}
                  testId={`meeting.ai.section.${id}.switch`}
                />
              }
            />
          ))}
          <div>
            <Button
              variant="primary"
              data-testid="meeting.ai.generate"
              onClick={generate}
            >
              {t("editor.meeting.ai.generate")}
            </Button>
          </div>
        </>
      )}

      {phase === "running" && (
        <>
          <p data-testid="meeting.ai.running">{t("editor.meeting.ai.running")}</p>
          <p data-testid="meeting.ai.progress">
            {t("editor.meeting.ai.progress", {
              done: progress[0],
              total: progress[1],
            })}
          </p>
          <div>
            <Button
              variant="secondary"
              data-testid="meeting.ai.stop"
              onClick={() => {
                stoppedRef.current = true;
                runRef.current?.stop();
                setPhase("cancelled");
              }}
            >
              {t("editor.meeting.ai.stop")}
            </Button>
          </div>
        </>
      )}

      {phase === "review" && (
        <>
          <p>{t("editor.meeting.ai.reviewIntro")}</p>
          {present.map((id) => (
            <div key={id} data-testid={`meeting.ai.preview.${id}`}>
              <h3>{MEETING_SECTION_HEADINGS[id]}</h3>
              <p>{sections[id]}</p>
            </div>
          ))}
          <div>
            <Button
              variant="primary"
              data-testid="meeting.ai.insert"
              onClick={insert}
            >
              {t("editor.meeting.ai.insert")}
            </Button>
            <Button
              variant="secondary"
              data-testid="meeting.ai.discard"
              onClick={close}
            >
              {t("editor.meeting.ai.discard")}
            </Button>
          </div>
        </>
      )}

      {phase === "error" && (
        <>
          <p data-testid="meeting.ai.error">{t("editor.meeting.ai.failed")}</p>
          <div>
            <Button
              variant="secondary"
              data-testid="meeting.ai.close"
              onClick={close}
            >
              {t("editor.meeting.ai.close")}
            </Button>
          </div>
        </>
      )}

      {phase === "cancelled" && (
        <>
          <p data-testid="meeting.ai.cancelled">
            {t("editor.meeting.ai.cancelled")}
          </p>
          <div>
            <Button
              variant="secondary"
              data-testid="meeting.ai.close"
              onClick={close}
            >
              {t("editor.meeting.ai.close")}
            </Button>
          </div>
        </>
      )}
    </ModalShell>
  );
}
