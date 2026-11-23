// First-run AI onboarding surface (myne-md/myne#805).
//
// A one-time surface rendered after the first successful unlock, gated on the
// DEVICE-LOCAL "seen" flag in `src/lib/aiOnboardingSeen.ts` so it covers every
// entry path (fresh create, restore, recovery, member accept) and appears
// exactly once per device. It is fully skippable: the app works without AI, and
// every AI feature shows an actionable "download to enable" state later.
//
// Two independent cards on desktop:
//   * Auto-tagging: downloads the tag model.
//   * Chat: no download; routes into the existing provider setup.
// On mobile the surface shows only the opt-in and the Chat card (`downloads`
// prop false), because the mobile engine is transcription-only.
//
// Copy discipline: user-facing strings go through i18n; the AI trust invariant
// is `load-bearing-copy.ts`, rendered VERBATIM and never translated
// (`src/AGENTS.md`). Design: tokens only, no literals (`check-token-adoption`).

import { type CSSProperties } from "react";
import { useTranslation } from "react-i18next";

import { usePrefs } from "../../hooks/usePrefs";
import type { DownloadArtifactId } from "../../lib/ai-model-download";
import {
  cancelModelDownloadFor,
  startModelDownload,
  useModelDownload,
} from "../../lib/ai-download-store";
import { AI_TRUST_INVARIANT } from "../../lib/load-bearing-copy";
import { Button } from "../primitives/Button";
import { ModalShell } from "../primitives/ModalShell";
import { Switch } from "../primitives/Switch";

const OPT_IN_ROW_STYLE: CSSProperties = {
  display: "flex",
  alignItems: "center",
  justifyContent: "space-between",
  gap: "var(--space-3)",
};

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


/* Space ABOVE only: the modal body already insets its children, so a footer
   carrying its own inset too sat twice as far in as the content above it. */
const FOOTER_STYLE: CSSProperties = {
  display: "flex",
  justifyContent: "flex-end",
  gap: "var(--space-2)",
  marginTop: "var(--space-4)",
  flexShrink: 0,
};

/** One downloadable feature card (auto-tag). */
function DownloadCard(props: {
  title: string;
  body: string;
  artifact: DownloadArtifactId;
  disabled: boolean;
}) {
  const { t } = useTranslation();
  // Shared with the Settings row, so dismissing this surface no longer cancels
  // the fetch: the store owns it and the Settings panel shows its progress
  // (myne-md/myne#814).
  const download = useModelDownload(props.artifact);
  const downloading = download.status === "downloading";
  const percent =
    download.total > 0
      ? Math.min(100, Math.round((download.downloaded / download.total) * 100))
      : 0;

  return (
    <div style={CARD_STYLE} data-testid={`aiOnboarding.card.${props.artifact}`}>
      <h3 style={CARD_TITLE_STYLE}>{props.title}</h3>
      <p style={CARD_BODY_STYLE}>{props.body}</p>
      <div style={CARD_FOOTER_STYLE}>
        {(download.status === "idle" || download.status === "cancelled") && (
          <Button
            variant="primary"
            disabled={props.disabled}
            onClick={() => void startModelDownload(props.artifact)}
            data-testid={`aiOnboarding.download.${props.artifact}`}
          >
            {download.status === "cancelled"
              ? t("aiOnboarding.retry")
              : t("aiOnboarding.download")}
          </Button>
        )}
        {downloading && (
          <>
            <span
              data-testid={`aiOnboarding.downloading.${props.artifact}`}
              style={CARD_BODY_STYLE}
            >
              {t("settings.ai.downloadingPercent", { percent })}
            </span>
            <Button
              variant="ghost"
              onClick={() => cancelModelDownloadFor(props.artifact)}
              data-testid={`aiOnboarding.cancel.${props.artifact}`}
            >
              {t("common.cancel")}
            </Button>
          </>
        )}
        {download.status === "complete" && (
          <span
            data-testid={`aiOnboarding.complete.${props.artifact}`}
            style={{ ...CARD_BODY_STYLE, color: "var(--accent)" }}
          >
            {t("aiOnboarding.complete")}
          </span>
        )}
        {download.status === "failed" && (
          <>
            <span
              data-testid={`aiOnboarding.failed.${props.artifact}`}
              role="alert"
              style={{ ...CARD_BODY_STYLE, color: "var(--danger)" }}
            >
              {download.cause === "checksum"
                ? t("settings.ai.downloadFailedChecksum")
                : t("settings.ai.downloadFailed")}
            </span>
            <Button
              variant="secondary"
              onClick={() => void startModelDownload(props.artifact)}
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

      {/* The opt-in, as a `Switch`: a setting's control is this one, and a native
          checkbox does not follow the theme on every platform. */}
      <div style={OPT_IN_ROW_STYLE}>
        <span style={CARD_BODY_STYLE}>{t("aiOnboarding.enableLabel")}</span>
        <Switch
          checked={aiEnabled}
          onChange={(next) => void setAiEnabled(next)}
          ariaLabel={t("aiOnboarding.enableLabel")}
          testId="aiOnboarding.enable"
        />
      </div>

      {downloads && (
        <div style={{ display: "flex", flexDirection: "column", gap: "var(--space-3)" }}>
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

      <div style={FOOTER_STYLE}>
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
          {t("common.done")}
        </Button>
      </div>
    </ModalShell>
  );
}
