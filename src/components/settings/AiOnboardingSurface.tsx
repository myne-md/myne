// First-run AI onboarding surface (myne-md/myne#805).
//
// A one-time surface rendered after the first successful unlock, gated on the
// DEVICE-LOCAL "seen" flag in `src/lib/aiOnboardingSeen.ts` so it covers every
// entry path (fresh create, restore, recovery, member accept) and appears
// exactly once per device. It is fully skippable: the app works without AI, and
// every AI feature shows an actionable "download to enable" state later.
//
// Three independent cards on desktop:
//   * Semantic search: downloads the multilingual embedding model.
//   * Auto-tagging: downloads the tag model.
//   * Chat: no download; routes into the existing provider setup.
// On mobile the surface shows only the opt-in and the Chat card (`downloads`
// prop false), because the mobile engine is transcription-only.
//
// Copy discipline: user-facing strings go through i18n; the AI trust invariant
// is `load-bearing-copy.ts`, rendered VERBATIM and never translated
// (`src/AGENTS.md`). Design: tokens only, no literals (`check-token-adoption`).

import { useCallback, useEffect, useRef, useState, type CSSProperties } from "react";
import { useTranslation } from "react-i18next";

import { usePrefs } from "../../hooks/usePrefs";
import {
  isChecksumMismatch,
  downloadModel,
  cancelModelDownload,
  newDownloadId,
  type DownloadArtifactId,
} from "../../lib/ai-model-download";
import { AI_TRUST_INVARIANT } from "../../lib/load-bearing-copy";
import { Button } from "../primitives/Button";
import { ModalShell } from "../primitives/ModalShell";

/** How a download card is progressing. `idle` is the offered state; the rest
 *  are the states the task's acceptance criteria name. */
type DownloadState =
  | { kind: "idle" }
  | { kind: "downloading"; id: string }
  | { kind: "complete" }
  | { kind: "failed"; cause: "checksum" | "generic" }
  | { kind: "cancelled" };

const CARD_STYLE: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: "var(--space-2)",
  padding: "var(--space-3)",
  border: "1px solid var(--line-1)",
  borderRadius: "var(--radius-2)",
  background: "var(--bg-1)",
};

const CARD_TITLE_STYLE: CSSProperties = {
  margin: 0,
  fontSize: "var(--text-md)",
  fontWeight: "var(--weight-semibold)" as CSSProperties["fontWeight"],
  color: "var(--fg-1)",
};

const CARD_BODY_STYLE: CSSProperties = {
  margin: 0,
  fontSize: "var(--text-sm)",
  color: "var(--fg-2)",
  lineHeight: 1.5,
};

const CARD_FOOTER_STYLE: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: "var(--space-2)",
  flexWrap: "wrap",
};

/** One downloadable feature card (semantic search / auto-tag). */
function DownloadCard(props: {
  title: string;
  body: string;
  artifact: DownloadArtifactId;
  disabled: boolean;
}) {
  const { t } = useTranslation();
  const [state, setState] = useState<DownloadState>({ kind: "idle" });
  // The id of the in-flight download, so unmount can cancel it. A ref (not the
  // state) because the cleanup reads the LATEST id, not the one captured at the
  // render the effect ran on.
  const activeId = useRef<string | null>(null);

  useEffect(
    () => () => {
      // The surface was dismissed mid-download (Skip/Done/Esc/backdrop): the
      // host fetch keeps running otherwise, and the card that would show its
      // progress is gone. Best-effort cancel, so a model the user never saw
      // finish is not silently registered.
      if (activeId.current) void cancelModelDownload(activeId.current);
    },
    [],
  );

  const start = useCallback(async () => {
    const id = newDownloadId();
    activeId.current = id;
    setState({ kind: "downloading", id });
    try {
      await downloadModel(props.artifact, id);
      activeId.current = null;
      setState({ kind: "complete" });
    } catch (err) {
      // A cancel surfaces as a rejection too; distinguish it from a genuine
      // failure by the state `stop` already set, not by the error shape (the
      // error is opaque by design). `isChecksumMismatch` selects the copy that
      // names the compiled-in-digest refusal specifically.
      activeId.current = null;
      setState((prev) =>
        prev.kind === "cancelled"
          ? prev
          : { kind: "failed", cause: isChecksumMismatch(err) ? "checksum" : "generic" },
      );
    }
  }, [props.artifact]);

  const stop = useCallback(async () => {
    if (state.kind !== "downloading") return;
    // Set the terminal state BEFORE the IPC rejects, so `start`'s catch does not
    // relabel a user cancel as a failure.
    setState({ kind: "cancelled" });
    activeId.current = null;
    try {
      await cancelModelDownload(state.id);
    } catch {
      /* best-effort: the fetch has already been marked cancelled locally */
    }
  }, [state]);

  return (
    <div style={CARD_STYLE} data-testid={`aiOnboarding.card.${props.artifact}`}>
      <h3 style={CARD_TITLE_STYLE}>{props.title}</h3>
      <p style={CARD_BODY_STYLE}>{props.body}</p>
      <div style={CARD_FOOTER_STYLE}>
        {(state.kind === "idle" || state.kind === "cancelled") && (
          <Button
            variant="primary"
            disabled={props.disabled}
            onClick={() => void start()}
            data-testid={`aiOnboarding.download.${props.artifact}`}
          >
            {state.kind === "cancelled"
              ? t("aiOnboarding.retry")
              : t("aiOnboarding.download")}
          </Button>
        )}
        {state.kind === "downloading" && (
          <>
            <span
              data-testid={`aiOnboarding.downloading.${props.artifact}`}
              style={CARD_BODY_STYLE}
            >
              {t("aiOnboarding.downloading")}
            </span>
            <Button
              variant="ghost"
              onClick={() => void stop()}
              data-testid={`aiOnboarding.cancel.${props.artifact}`}
            >
              {t("aiOnboarding.cancel")}
            </Button>
          </>
        )}
        {state.kind === "complete" && (
          <span
            data-testid={`aiOnboarding.complete.${props.artifact}`}
            style={{ ...CARD_BODY_STYLE, color: "var(--accent)" }}
          >
            {t("aiOnboarding.complete")}
          </span>
        )}
        {state.kind === "failed" && (
          <>
            <span
              data-testid={`aiOnboarding.failed.${props.artifact}`}
              role="alert"
              style={{ ...CARD_BODY_STYLE, color: "var(--danger)" }}
            >
              {state.cause === "checksum"
                ? t("settings.ai.downloadFailedChecksum")
                : t("settings.ai.downloadFailed")}
            </span>
            <Button
              variant="secondary"
              onClick={() => void start()}
              data-testid={`aiOnboarding.retry.${props.artifact}`}
            >
              {t("aiOnboarding.retry")}
            </Button>
          </>
        )}
      </div>
    </div>
  );
}

export interface AiOnboardingSurfaceProps {
  open: boolean;
  /** Dismiss (skip) the surface. Also the post-choice completion path: the
   *  caller writes the device-local "seen" flag. */
  onClose: () => void;
  /**
   * Whether to offer model-download cards. False on mobile (its engine is
   * transcription-only), so the surface shows the opt-in and the Chat card
   * only: never an affordance the device cannot run.
   */
  downloads: boolean;
  /** Route the user into the existing provider setup (Settings → AI). */
  onOpenProviderSetup: () => void;
}

export function AiOnboardingSurface({
  open,
  onClose,
  downloads,
  onOpenProviderSetup,
}: AiOnboardingSurfaceProps) {
  const { t } = useTranslation();
  const { prefs, setAiEnabled } = usePrefs();
  // The enable toggle writes the existing `ai_enabled` pref, so this surface
  // and the Settings panel cannot disagree. A user who skips leaves it off and
  // nothing is downloaded.

  const aiEnabled = prefs.ai_enabled;

  return (
    <ModalShell
      open={open}
      title={t("aiOnboarding.title")}
      onClose={onClose}
      labelId="ai-onboarding-title"
      width={560}
      testId="aiOnboarding.screen"
      closeLabel={t("aiOnboarding.skip")}
    >
      <div
        style={{
          flex: 1,
          minHeight: 0,
          overflowY: "auto",
          display: "flex",
          flexDirection: "column",
          gap: "var(--space-3)",
        }}
      >
      <p data-testid="aiOnboarding.intro" style={CARD_BODY_STYLE}>
        {t("aiOnboarding.intro")}
      </p>

      {/* Load-bearing: rendered verbatim, never i18n'd. */}
      <p
        data-testid="aiOnboarding.trust-invariant"
        style={{ ...CARD_BODY_STYLE, color: "var(--fg-1)" }}
      >
        {AI_TRUST_INVARIANT}
      </p>

      {/* The opt-in. Turning it on is what makes the cards meaningful; a user
          who skips leaves it off and nothing is downloaded. */}
      <label
        style={{ ...CARD_BODY_STYLE, display: "flex", gap: "var(--space-2)", alignItems: "center" }}
      >
        <input
          type="checkbox"
          data-testid="aiOnboarding.enable"
          checked={aiEnabled}
          onChange={(e) => void setAiEnabled(e.target.checked)}
        />
        {t("aiOnboarding.enableLabel")}
      </label>

      {downloads && (
        <div style={{ display: "flex", flexDirection: "column", gap: "var(--space-3)" }}>
          <DownloadCard
            title={t("aiOnboarding.semantic.title")}
            body={t("aiOnboarding.semantic.body")}
            artifact="embedding-e5-small"
            disabled={!aiEnabled}
          />
          <DownloadCard
            title={t("aiOnboarding.tag.title")}
            body={t("aiOnboarding.tag.body")}
            artifact="tag"
            disabled={!aiEnabled}
          />
        </div>
      )}

      {/* Chat: no download. Routes into the existing provider setup, which owns
          the consent step. */}
      <div style={CARD_STYLE} data-testid="aiOnboarding.card.chat">
        <h3 style={CARD_TITLE_STYLE}>{t("aiOnboarding.chat.title")}</h3>
        <p style={CARD_BODY_STYLE}>{t("aiOnboarding.chat.body")}</p>
        <div style={CARD_FOOTER_STYLE}>
          <Button
            variant="secondary"
            onClick={onOpenProviderSetup}
            data-testid="aiOnboarding.chat.setup"
          >
            {t("aiOnboarding.chat.setup")}
          </Button>
        </div>
      </div>

      </div>

      <div style={{ display: "flex", justifyContent: "flex-end", gap: "var(--space-2)" }}>
        <Button
          variant="ghost"
          onClick={onClose}
          data-testid="aiOnboarding.skip"
        >
          {t("aiOnboarding.skip")}
        </Button>
        <Button
          variant="primary"
          onClick={onClose}
          data-testid="aiOnboarding.done"
        >
          {t("aiOnboarding.done")}
        </Button>
      </div>
    </ModalShell>
  );
}
