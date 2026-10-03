// First-run AI onboarding for the mobile client (myne-md/myne#805).
//
// The desktop surface (`src/components/settings/AiOnboardingSurface.tsx`) cannot
// be mounted here: it reads the DESKTOP platform seam through
// `src/lib/ai-model-download.ts` and the shared tree's `usePrefs`, so importing
// it would resolve `@tauri-apps/*` against the wrong host. Mobile recuts desktop
// components as twins (see `MemorySection.tsx`), and this is that twin.
//
// It shows the AI opt-in and the Chat card only, and never a download card: the
// mobile engine is transcription-only, so there is nothing to download. The
// provider setup lives in the mobile Settings AI panel, which owns the consent
// step. Once-per-device gating uses a device-local localStorage flag, exactly
// like `home-tiles.ts`, so it covers every unlock path and never touches
// `vault.prefs`.

import { useCallback, useState, type CSSProperties } from "react";
import { useTranslation } from "react-i18next";

import { Button, Sheet, Switch } from "./index";
import { setAiEnabled } from "../lib/prefs";
import { usePrefs } from "../lib/use-prefs";
// Desktop's `src/lib/load-bearing-copy.ts` holds the same literal (it is
// desktop-local, not in `@myne/copy`); the two are kept byte-identical by the
// `check-twin-inventory` review, not by construction.
import { AI_TRUST_INVARIANT } from "../lib/load-bearing-copy";

const SEEN_KEY = "myne.aiOnboardingSeen";

/** Whether the first-run AI surface has already been shown on this device. */
export function readAiOnboardingSeen(): boolean {
  try {
    return localStorage.getItem(SEEN_KEY) === "1";
  } catch {
    // Private mode / disabled storage: offer it rather than hide it.
    return false;
  }
}

/** Mark the first-run AI surface as seen on this device. Idempotent. */
export function writeAiOnboardingSeen(): void {
  try {
    localStorage.setItem(SEEN_KEY, "1");
  } catch {
    /* private mode — offered again next launch */
  }
}

const BODY: CSSProperties = {
  margin: 0,
  fontSize: "var(--text-sm)",
  color: "var(--fg-2)",
  lineHeight: 1.5,
};

export function AiOnboardingSheet({
  onOpenProviderSetup,
  onClose,
}: {
  /** Route the user into Settings → AI, which owns the provider consent step. */
  onOpenProviderSetup: () => void;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const { prefs } = usePrefs();
  const [busy, setBusy] = useState(false);

  const dismiss = useCallback(() => {
    writeAiOnboardingSeen();
    onClose();
  }, [onClose]);

  const setup = useCallback(() => {
    writeAiOnboardingSeen();
    onOpenProviderSetup();
  }, [onOpenProviderSetup]);

  const toggle = useCallback(() => {
    setBusy(true);
    void setAiEnabled(!prefs.ai_enabled).finally(() => setBusy(false));
  }, [prefs.ai_enabled]);

  return (
    <Sheet onClose={dismiss}>
      <div
        data-testid="aiOnboarding.screen"
        style={{
          display: "flex",
          flexDirection: "column",
          gap: "var(--space-3)",
          padding: "0 var(--space-4) var(--space-4)",
        }}
      >
        <h2 style={{ margin: 0, fontSize: "var(--text-lg)", color: "var(--fg-1)" }}>
          {t("aiOnboarding.title")}
        </h2>
        <p data-testid="aiOnboarding.intro" style={BODY}>
          {t("aiOnboarding.intro")}
        </p>

        {/* Load-bearing: rendered verbatim, never i18n'd, exactly as the desktop
            surface does. */}
        <p
          data-testid="aiOnboarding.trust-invariant"
          style={{ ...BODY, color: "var(--fg-1)" }}
        >
          {AI_TRUST_INVARIANT}
        </p>

        <label
          style={{
            ...BODY,
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            gap: "var(--space-3)",
            color: "var(--fg-1)",
          }}
        >
          {t("aiOnboarding.enableLabel")}
          <Switch on={prefs.ai_enabled} onToggle={toggle} disabled={busy} />
        </label>

        <div
          data-testid="aiOnboarding.card.chat"
          style={{
            display: "flex",
            flexDirection: "column",
            gap: "var(--space-2)",
            padding: "var(--space-3)",
            border: "1px solid var(--line-1)",
            borderRadius: "var(--radius-2)",
            background: "var(--bg-1)",
          }}
        >
          <h3 style={{ margin: 0, fontSize: "var(--text-md)", color: "var(--fg-1)" }}>
            {t("aiOnboarding.chat.title")}
          </h3>
          <p style={BODY}>{t("aiOnboarding.chat.body")}</p>
          <Button variant="secondary" onClick={setup} data-testid="aiOnboarding.chat.setup">
            {t("aiOnboarding.chat.setup")}
          </Button>
        </div>

        <div style={{ display: "flex", justifyContent: "flex-end", gap: "var(--space-2)" }}>
          <Button variant="ghost" onClick={dismiss} data-testid="aiOnboarding.skip">
            {t("aiOnboarding.skip")}
          </Button>
          <Button variant="primary" onClick={dismiss} data-testid="aiOnboarding.done">
            {t("aiOnboarding.done")}
          </Button>
        </div>
      </div>
    </Sheet>
  );
}
