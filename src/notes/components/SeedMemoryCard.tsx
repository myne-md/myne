// The once-only "Teach Myne your vault" card in the chat zero state
// (myne-md/myne#915).
//
// It appears at the moment the blank slate is visible: the assistant is on, it
// remembers nothing, the vault has enough substance to be worth distilling, and
// this device has not dismissed the offer. Every one of those is a condition
// rather than a timer, so the card cannot nag: dismissing it writes one
// device-local flag and it never returns.
//
// The dismissal is `localStorage`, the precedent set by the first-run AI
// onboarding surface (`src/lib/aiOnboardingSeen.ts`): it carries nothing
// vault-derived, so device-local at rest is the same trust level as the
// language preference. It is device-wide rather than per-vault, deliberately:
// a per-vault key would need a vault identifier in plaintext storage, and the
// Settings row is always available for the second vault.

import { useCallback, useEffect, useState } from "react";
import type { CSSProperties } from "react";
import { useTranslation } from "react-i18next";

import { Button } from "../../components/primitives/Button";
import { usePrefs } from "../../hooks/usePrefs";
import { readAiOnboardingSeen } from "../../lib/aiOnboardingSeen";
import { memoryList } from "../../lib/memory";
import { SEED_SUGGEST_MIN_NOTES, seedMemoryStatus } from "../../lib/seed-memory";
import { SeedMemoryWizard } from "../../components/settings/SeedMemoryWizard";

const DISMISSED_KEY = "myne.seedMemorySeen";

function readDismissed(): boolean {
  try {
    return localStorage.getItem(DISMISSED_KEY) === "1";
  } catch {
    // Private mode / disabled storage: treat as "not dismissed" so the offer is
    // still made. A missing offer is the failure direction this feature cannot
    // recover from; a repeated one is one click.
    return false;
  }
}

function writeDismissed(): void {
  try {
    localStorage.setItem(DISMISSED_KEY, "1");
  } catch {
    // Storage unavailable: the card returns next session. Nothing is written to
    // the vault, so the failure is cosmetic.
  }
}

const CARD_STYLE: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: "var(--space-2)",
  margin: "var(--space-3) auto 0",
  maxWidth: 420,
  padding: "var(--space-3)",
  borderRadius: "var(--radius-2)",
  border: "1px solid var(--line-1)",
  background: "var(--paper-2)",
  textAlign: "left",
};

const BODY_STYLE: CSSProperties = {
  margin: 0,
  fontSize: "var(--text-sm)",
  color: "var(--fg-2)",
};

export function SeedMemoryCard() {
  const { t } = useTranslation();
  const { prefs } = usePrefs();
  const [eligible, setEligible] = useState(false);
  const [open, setOpen] = useState(false);
  const [dismissed, setDismissed] = useState(readDismissed);

  const check = useCallback(async () => {
    if (!prefs.ai_enabled || dismissed || !readAiOnboardingSeen()) {
      setEligible(false);
      return;
    }
    try {
      const view = await memoryList();
      if (view.rows.length > 0) {
        setEligible(false);
        return;
      }
      const status = await seedMemoryStatus();
      // A floor on notes only. A vault with ten notes in one folder still has
      // plenty to distil, and requiring a second folder would hide the offer
      // from exactly the people who keep a flat vault.
      setEligible(status.notes >= SEED_SUGGEST_MIN_NOTES);
    } catch {
      // AI off or the store unreadable: no offer. The Settings row states the
      // cause if the user goes looking.
      setEligible(false);
    }
  }, [prefs.ai_enabled, dismissed]);

  useEffect(() => {
    void check();
  }, [check]);

  return (
    <>
      {eligible ? (
    <div style={CARD_STYLE} data-testid="ai.seed-card">
      <p style={{ margin: 0, fontSize: "var(--text-sm)", color: "var(--fg-1)" }}>
        {t("editor.chrome.rightPanel.aiChat.seedCard.title")}
      </p>
      <p style={BODY_STYLE}>{t("editor.chrome.rightPanel.aiChat.seedCard.body")}</p>
      <div style={{ display: "flex", gap: "var(--space-2)" }}>
        <Button
          data-testid="ai.seed-card-start"
          onClick={() => setOpen(true)}
        >
          {t("editor.chrome.rightPanel.aiChat.seedCard.action")}
        </Button>
        <Button
          variant="ghost"
          data-testid="ai.seed-card-dismiss"
          onClick={() => {
            writeDismissed();
            setDismissed(true);
            setEligible(false);
          }}
        >
          {t("common.notnow")}
        </Button>
      </div>
    </div>
      ) : null}
      {/* Mounted OUTSIDE the card so the wizard's own unmount is not tied to the
          eligibility re-check: a successful apply makes the card ineligible
          (memory is no longer empty) at the same moment the wizard closes
          itself and reports the count as a toast (issue #970, item 11). */}
      <SeedMemoryWizard
        open={open}
        onClose={() => {
          setOpen(false);
          void check();
        }}
      />
    </>
  );
}
