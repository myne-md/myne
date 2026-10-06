// The recovery DRILL, on the phone: check that the 24 words you wrote down still
// open this vault (myne-md/myne#468). Twin of `src/components/settings/RecoveryDrillRow.tsx`.
//
// The argument for the feature is in the desktop twin's header and is not
// repeated. What is worth writing down HERE is the one thing the phone changes
// and the three it must not.
//
// **What the phone changes: the keyboard.** Twenty-four words typed on a
// software keyboard is where autocorrect and autocapitalisation do their damage
// — a BIP-39 word "corrected" to an English one that is not in the wordlist, or
// capitalised into a form only a locale-aware lowercase would break (see
// `mobile/tests/phrase-normalization-locale.test.ts`). So the field carries
// `autoCapitalize="none"` and `autoCorrect="off"`, matching `WordEntry` in the
// creation flow, and the manual roster already gates the observation that a real
// keyboard does not mangle the input.
//
// **What it must not change.** The phrase is never DISPLAYED here, only entered.
// Nothing surfaces the drill automatically. And the failure sentence names
// nothing: it is a load-bearing literal rendered verbatim in every locale, and
// the reason it refuses to name the wrong word is in
// `src/lib/load-bearing-copy.ts` beside the string itself.

import { useState, type CSSProperties, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "./Button";
import { Spinner } from "./feedback";
import { verifyRecoveryPhrase } from "../lib/vault-recover";
import { RECOVERY_DRILL_FAILED_SENTENCE } from "../lib/load-bearing-copy";

/**
 * What the block is showing.
 *
 * `failed` and `error` are SEPARATE, and collapsing them is the mistake to
 * avoid: `failed` means the words do not open this vault, `error` means the
 * question could not be asked. Telling a user their phrase is wrong because
 * `vault.meta` could not be read sends them hunting for a phrase that is fine.
 */
type Outcome = "idle" | "checking" | "passed" | "failed" | "error";

const rowLabel: CSSProperties = { fontSize: "var(--text-md)", color: "var(--fg-1)" };

const subtitle: CSSProperties = {
  fontSize: "var(--text-sm)",
  lineHeight: "var(--leading-normal)",
  color: "var(--fg-3)",
  marginTop: "var(--space-1)",
};

const helper: CSSProperties = {
  fontSize: "var(--text-sm)",
  lineHeight: "var(--leading-normal)",
  color: "var(--fg-3)",
  margin: "var(--space-2) var(--space-1) 0",
};

function Group({ children }: { children: ReactNode }) {
  return (
    <div
      style={{
        border: "1px solid var(--line-1)",
        borderRadius: "var(--radius-3)",
        overflow: "hidden",
        background: "var(--bg-1)",
      }}
    >
      {children}
    </div>
  );
}

export function RecoveryDrillBlock(): ReactNode {
  const { t } = useTranslation();
  const [phrase, setPhrase] = useState("");
  const [outcome, setOutcome] = useState<Outcome>("idle");

  const run = async (): Promise<void> => {
    setOutcome("checking");
    try {
      // The backend normalizes (NFKD + lowercase + trim + whitespace collapse,
      // `protocol.md` §7.4), so nothing here tidies the input first. A frontend
      // that pre-normalized would be a second implementation of a rule the wire
      // shape depends on.
      setOutcome((await verifyRecoveryPhrase(phrase)) ? "passed" : "failed");
    } catch {
      // Every rejection is "could not ask": the command answers a wrong phrase
      // with `false`, so anything arriving here is a locked slot, a busy auth
      // budget, or an unreadable vault file.
      setOutcome("error");
    }
    // Cleared on BOTH outcomes, and the failure side is the deliberate one: a
    // wrong phrase left in the field is 24 words resident in an unlocked
    // session's DOM, and the user's next action is to re-read the paper rather
    // than to edit what they typed.
    setPhrase("");
  };

  const busy = outcome === "checking";

  return (
    <>
      <Group>
        <div
          data-testid="settings.recovery-drill"
          data-outcome={outcome}
          style={{
            display: "flex",
            flexDirection: "column",
            gap: "var(--space-2)",
            padding: "var(--space-3) var(--space-4)",
          }}
        >
          <div style={{ minWidth: 0 }}>
            <div style={rowLabel}>{t("settings.privacy.recoveryDrillLabel")}</div>
            <div style={subtitle}>{t("settings.privacy.recoveryDrillHelper")}</div>
          </div>
          <input
            type="text"
            // Pinned left-to-right for the reason `RecoveryGrid` is: the words
            // are frozen English (`protocol.md` §7) and their ORDER is part of
            // the secret, so an RTL locale must not reflow what is being checked.
            dir="ltr"
            value={phrase}
            // The two attributes that matter on a phone. A BIP-39 word
            // autocorrected to a near neighbour is not in the wordlist, and a
            // capitalised one is a locale-lowercase hazard.
            autoCapitalize="none"
            autoCorrect="off"
            spellCheck={false}
            disabled={busy}
            placeholder={t("settings.privacy.recoveryDrillPlaceholder")}
            aria-label={t("settings.privacy.recoveryDrillLabel")}
            onChange={(e) => {
              setPhrase(e.target.value);
              // Any edit retires the previous verdict: a "does not open this
              // vault" line under a field the user has since changed is a claim
              // about text that is no longer there.
              if (outcome !== "idle") setOutcome("idle");
            }}
            data-testid="settings.recovery-drill-input"
            style={{
              width: "100%",
              minWidth: 0,
              boxSizing: "border-box",
              border: "1px solid var(--line-2)",
              borderRadius: "var(--radius-2)",
              background: "var(--bg-2)",
              padding: "var(--space-3)",
              fontFamily: "var(--font-mono)",
              fontSize: "var(--text-base)",
              color: "var(--fg-1)",
            }}
          />
          <Button
            variant="secondary"
            disabled={busy || phrase.trim().length === 0}
            onClick={() => void run()}
            data-testid="settings.recovery-drill-submit"
          >
            {busy && <Spinner size={16} stroke={2} />}
            {busy
              ? t("settings.privacy.recoveryDrillChecking")
              : t("settings.privacy.recoveryDrillCheck")}
          </Button>
        </div>
      </Group>

      {/* `role="status"` on one element, so a reader is told the outcome once
          however it lands. Rendered always rather than conditionally, for the
          reason the creation flow's status line is: a live region inserted only
          when there is something to say cannot announce it. */}
      <p
        style={helper}
        role="status"
        aria-live="polite"
        data-testid="settings.recovery-drill-result"
      >
        {outcome === "passed" && t("settings.privacy.recoveryDrillPassed")}
        {/* NOT a `t()` key — its exact wording is the privacy property. See
            `src/lib/load-bearing-copy.ts`. */}
        {outcome === "failed" && RECOVERY_DRILL_FAILED_SENTENCE}
        {outcome === "error" && t("settings.privacy.recoveryDrillError")}
      </p>
    </>
  );
}
