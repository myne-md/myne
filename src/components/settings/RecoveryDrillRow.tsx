// The recovery DRILL: check that the 24 words you wrote down still open this
// vault (myne-md/myne#468).
//
// **Why this exists.** `recovery-flow.md` §2.4 is a no-re-display commitment and
// `protocol.md` §7 gives the phrase no rotation, so a phrase mis-copied at
// creation is discovered on the day it is needed — which is the day the password
// is already gone. BIP-39's own checksum misses roughly one random error in 256,
// and a permutation it never catches at all. A user with the phrase in front of
// them and an OPEN vault can find out now and export everything; the same user a
// year later has nothing.
//
// **Three things it deliberately does not do.**
//
//  1. **It never displays the phrase.** Entry only. A Settings screen that
//     re-showed 24 words would be the re-display §2.4 rules out, and it would
//     put them on a surface reachable from any unlocked session.
//  2. **It is never surfaced automatically.** No badge, no periodic nag, no
//     "you have not checked in 90 days". Notesnook's undismissable reminder is
//     the cautionary case recorded in `research.md`: a prompt a user cannot
//     satisfy becomes a prompt they learn to dismiss, and the one automatic
//     surfacing this feature gets is a single dismissible line on the backup
//     success screen.
//  3. **Its failure message names nothing.** One sentence for every way to
//     fail. See the copy note on `FAILED` below — this is the part most likely
//     to be "improved" into a vulnerability by a later change.

import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "../primitives/Button";
import { Input } from "../primitives/Input";
import { Spinner } from "../../components/Spinner";
import { SettingRow } from "./SettingRow";
import { HELPER_STYLE } from "./panel-styles";
import { verifyRecoveryPhrase } from "../../lib/vault-recover";
import { RECOVERY_DRILL_FAILED_SENTENCE } from "../../lib/load-bearing-copy";
import type { CSSProperties } from "react";

/**
 * What the row is showing.
 *
 * `failed` and `error` are SEPARATE, and collapsing them is the mistake to
 * avoid: `failed` means the words do not open this vault, `error` means the
 * question could not be asked. Telling a user their phrase is wrong because
 * `vault.meta` could not be read sends them hunting for a phrase that is fine.
 */
type Outcome = "idle" | "checking" | "passed" | "failed" | "error";

const RESULT_STYLE: CSSProperties = {
  ...HELPER_STYLE,
  marginBlockStart: "var(--space-2)",
};

const FORM_STYLE: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: "var(--space-2)",
  marginBlockStart: "var(--space-2)",
};

export function RecoveryDrillRow() {
  const { t } = useTranslation();
  const [phrase, setPhrase] = useState("");
  const [outcome, setOutcome] = useState<Outcome>("idle");

  const check = async () => {
    setOutcome("checking");
    try {
      // The backend normalizes (NFKD + lowercase + trim + whitespace collapse,
      // `protocol.md` §7.4), so nothing here tidies the input first. A frontend
      // that pre-normalized would be a second implementation of a rule the
      // wire shape depends on.
      setOutcome((await verifyRecoveryPhrase(phrase)) ? "passed" : "failed");
    } catch (e) {
      // Every rejection is "could not ask", which is the honest reading: the
      // command answers a wrong phrase with `false`, so anything that arrives
      // here is a locked slot, a busy auth budget, or an unreadable vault file.
      // Not branched into three messages, because all three have the same
      // remedy — try again in a moment — and the one that does not
      // (`InvalidVaultMeta`) is a state this screen cannot be reached from
      // without the vault already being open.
      setOutcome("error");
    }
  };

  // Cleared on success AND on failure, and that is deliberate on the failure
  // side: a wrong phrase left in the field is 24 words sitting in the DOM of an
  // unlocked session for as long as the panel stays open, and the user's next
  // action is to re-read the paper and type it again rather than to edit what
  // they typed. (The success side is obvious: the drill is over.)
  const finish = async () => {
    await check();
    setPhrase("");
  };

  const busy = outcome === "checking";

  return (
    <SettingRow
      anchorId="privacy.recovery-drill"
      testId="settings.recovery-drill"
      stateAttrs={{ "data-outcome": outcome }}
      label={t("settings.privacy.recoveryDrillLabel")}
      helper={t("settings.privacy.recoveryDrillHelper")}
      control={null}
    >
      <form
        style={FORM_STYLE}
        onSubmit={(e) => {
          e.preventDefault();
          if (!busy && phrase.trim().length > 0) void finish();
        }}
      >
        <Input
          type="text"
          // Pinned left-to-right for the reason the creation grid is: the words
          // are frozen English (`protocol.md` §7) and their ORDER is part of the
          // secret, so an RTL locale must not reflow what the user is checking.
          dir="ltr"
          value={phrase}
          onChange={(e) => {
            setPhrase(e.target.value);
            // Any edit retires the previous verdict. A "this phrase does not
            // open this vault" line sitting under a field the user has since
            // changed is a claim about text that is no longer there.
            if (outcome !== "idle") setOutcome("idle");
          }}
          placeholder={t("settings.privacy.recoveryDrillPlaceholder")}
          aria-label={t("settings.privacy.recoveryDrillLabel")}
          autoComplete="off"
          spellCheck={false}
          mono
          disabled={busy}
          data-testid="settings.recovery-drill-input"
        />
        <div>
          <Button
            type="submit"
            variant="secondary"
            disabled={busy || phrase.trim().length === 0}
            data-testid="settings.recovery-drill-submit"
          >
            {busy && <Spinner size={14} style={{ borderWidth: 2 }} />}
            {busy
              ? t("settings.privacy.recoveryDrillChecking")
              : t("settings.privacy.recoveryDrillCheck")}
          </Button>
        </div>
      </form>

      {/* `role="status"` on the container rather than on each line, so a screen
          reader is told the outcome once however it lands. */}
      <p style={RESULT_STYLE} role="status" data-testid="settings.recovery-drill-result">
        {outcome === "passed" && t("settings.privacy.recoveryDrillPassed")}
        {/* NOT a `t()` key. Its exact wording is the privacy property — it
            refuses to name which word was wrong, and says why — so it is a
            load-bearing literal rendered verbatim in every locale
            (`src/lib/load-bearing-copy.ts` carries the rule and the argument).
            `check-i18n.mjs` fails if it ever appears in a catalog. */}
        {outcome === "failed" && RECOVERY_DRILL_FAILED_SENTENCE}
        {outcome === "error" && t("settings.privacy.recoveryDrillError")}
      </p>
    </SettingRow>
  );
}
