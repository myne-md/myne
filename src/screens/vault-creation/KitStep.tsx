// Step 3 of 4 — the recovery kit: the phrase and the account number, on one
// screen, styled as a preview of the file being saved (myne-md/myne#468 K11/K13).
//
// This replaces two consecutive steps (`PhraseStep` then `AccountStep`), and the
// merge is the research finding rather than a tidy-up: no product surveyed in
// `agent-tooling/features/onboarding/research.md` asks a user to absorb two
// back-to-back "keep this forever" moments, and the account step arrived AFTER
// the phrase challenge had already been passed, so it read as an epilogue to a
// ceremony that was over. One screen, one save, one acknowledgement.
//
// Three decisions worth stating, because each replaced something that was built:
//
//  1. **The document IS the argument.** The screen is laid out as the text file
//     `recoveryKitText` produces, so the user can see that both secrets are in
//     the one file they are about to save. A box saying so in words was built,
//     reviewed and rejected: it restated what the sheet already shows.
//  2. **The account number's reason is "adding another device"** (K13), not
//     "registering for sync". That is what the second device actually does —
//     `sync.join.help` says so — and it is a reason a first-time user can act on.
//  3. **No acknowledgement checkbox.** The old account step had one, and
//     `protocol.md` §7.1.3 is explicit that a bare checkbox is insufficient
//     evidence. What gates the commit is the type-back challenge on the next
//     step, which is stronger than the checkbox it replaces rather than a
//     relaxation of it.
//
// The save/copy OUTCOME-REPORTING rules are unchanged and still normative
// (`recovery-flow.md` §2.2): a failure is always reported, a cancelled dialog
// reports nothing, and a browser download never claims the file landed. All
// three live inside `saveSecretAsTextFile` / `saveOutcomeMessage`, which is why
// this screen reuses them rather than writing a file itself.
//
// Spec: protocol.md §7 (BIP-39 24-word, English wordlist), §7.5;
// account-number.md §7 (bearer-token semantics).

import { useCallback, useMemo, useRef, type Dispatch } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "../../components/primitives/Button";
import { PhraseGrid } from "../../components/PhraseGrid";
import { SecretDisplayCaveats } from "../../components/SecretDisplayCaveats";
import {
  ActionStatus,
  type SecretAction,
  useActionStatus,
} from "../../components/ActionStatus";
import {
  copySecretToClipboard,
  saveOutcomeMessage,
  saveSecretAsTextFile,
} from "../../lib/secret-export";
import { recoveryKitText } from "../../lib/recovery-kit";
import { has } from "../../platform/capabilities";
import { StepCounter, StepHeading, StepLayout } from "./step-shell";
import type { Action } from "./reducer";
import type { CSSProperties } from "react";

/** The sheet: page-coloured, bordered and lifted, against the step's own page.
 *  A document on a desk rather than another recessed card. */
const SHEET_STYLE: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: "var(--space-4)",
  padding: "var(--space-5)",
  background: "var(--bg-1)",
  border: "1px solid var(--line-2)",
  borderRadius: "var(--radius-2)",
  boxShadow: "var(--shadow-1)",
};

/** The section labels inside the sheet: what this secret is, and what it is for. */
const SECTION_LABEL_STYLE: CSSProperties = {
  fontSize: "var(--text-sm)",
  lineHeight: 1.5,
  color: "var(--fg-2)",
  margin: 0,
  marginBlockEnd: "var(--space-2)",
};

const RULE_STYLE: CSSProperties = {
  border: 0,
  borderTop: "1px solid var(--line-1)",
  margin: 0,
};

interface KitStepProps {
  phrase: string[];
  accountNumber: string;
  /** The name from the `name` step. Empty when the user left it blank. */
  vaultName: string;
  revealed: boolean;
  dispatch: Dispatch<Action>;
  /**
   * Abandon the half-made vault and return to the password step.
   *
   * OPTIONAL, and absent means the Back control is not rendered at all rather
   * than rendered and inert. It is absent on the ordering this flow uses where
   * sync is required: there the vault is committed and the account registered
   * BEFORE the kit is shown, so by the time this screen exists there is no
   * session left to cancel and nothing local to erase that would undo the
   * registration. A Back that dropped the phrase from state would therefore
   * discard, permanently, the only copy of a credential for an account that
   * still exists (`recovery-flow.md` §2.4 is a no-re-display commitment, and
   * `protocol.md` §7 gives the phrase no rotation), through a control labelled
   * "Back". Omitted rather than confirmed: a confirmation would be offering a
   * choice whose safe branch is "do not press this".
   */
  onCancelSession?: () => void;
}

export function KitStep({
  phrase,
  accountNumber,
  vaultName,
  revealed,
  dispatch,
  onCancelSession,
}: KitStepProps) {
  const { t, i18n } = useTranslation();

  // The date the sheet shows and the file carries. Formatted here, in the
  // active locale, so `recoveryKitText` holds no locale logic and stays a pure
  // function over strings.
  const savedOn = useMemo(
    () =>
      new Intl.DateTimeFormat(i18n.language, { dateStyle: "medium" }).format(
        new Date(),
      ),
    [i18n.language],
  );

  const phraseLabel = t("vaultCreation.kit.phraseFor");
  const accountLabel = t("vaultCreation.kit.accountFor");
  const kitTitle = t("vaultCreation.kit.documentTitle");

  // What Save writes and what Copy puts on the clipboard: the same bytes, so
  // the two affordances cannot disagree about what the kit is.
  const kitText = useMemo(
    () =>
      recoveryKitText({
        vaultName,
        savedOn,
        phrase,
        accountNumber,
        labels: {
          title: kitTitle,
          phraseHeading: phraseLabel,
          accountHeading: accountLabel,
        },
      }),
    [vaultName, savedOn, phrase, accountNumber, kitTitle, phraseLabel, accountLabel],
  );

  const { outcome, feedbackFor } = useActionStatus<SecretAction>();

  // The pending auto-clear is NOT cancelled on unmount, deliberately
  // (myne-md/myne#390). Advancing past this screen is the intended next action,
  // so cancelling there left the words on the system clipboard permanently
  // while the copy had just said they would clear. Letting the clear fire after
  // unmount is safe because it is the host-side compare-and-clear: it only wipes
  // the clipboard if the kit is still on it.
  const cancelAutoClearRef = useRef<(() => void) | null>(null);

  const handleCopy = useCallback(async () => {
    cancelAutoClearRef.current?.();
    cancelAutoClearRef.current = await copySecretToClipboard(
      kitText,
      feedbackFor("copy"),
    );
  }, [kitText, feedbackFor]);

  // The filename is NOT a catalog string, matching the two it replaces
  // (`myne-recovery-phrase.txt`, `myne-account-number.txt`): a user who lands in
  // support with a localized filename cannot be asked for it by name, and the
  // save dialog lets them rename it anyway.
  const handleSave = useCallback(
    () => saveSecretAsTextFile("myne-recovery-kit.txt", kitText, feedbackFor("save")),
    [kitText, feedbackFor],
  );

  // Exhaustive over `SecretAction` by construction, so a third affordance is a
  // compile error here rather than a silent fall into the save sentence. The
  // capability test sits OUTSIDE `t(...)`: `check-i18n.mjs` matches a STATIC
  // `t("literal")`, so `t(cond ? "a" : "b")` would drop every key it selects out
  // of the only check that proves they exist in the catalog.
  const message: Record<SecretAction, (ok: boolean) => string> = {
    copy: (ok) =>
      ok
        ? has("clipboardAutoClear")
          ? t("vaultCreation.kit.copied")
          : t("vaultCreation.kit.copiedNoAutoClear")
        : t("vaultCreation.kit.copyFailed"),
    save: (ok) =>
      saveOutcomeMessage(ok, {
        saved: t("vaultCreation.kit.savedToFile"),
        started: t("vaultCreation.kit.downloadStarted"),
        failed: t("vaultCreation.kit.saveFailed"),
      }),
  };

  return (
    <StepLayout width={600}>
      <StepCounter
        step="kit"
        label={t("vaultCreation.kit.eyebrowLabel")}
      />
      <StepHeading>{t("vaultCreation.kit.heading")}</StepHeading>

      <div style={{ fontSize: "var(--text-base)", lineHeight: 1.6, color: "var(--fg-2)" }}>
        {t("vaultCreation.kit.intro")}
      </div>

      <div style={SHEET_STYLE} data-testid="create.kit-sheet">
        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            alignItems: "baseline",
            gap: "var(--space-3)",
          }}
        >
          <span
            style={{
              fontSize: "var(--text-md)",
              fontWeight: "var(--weight-semibold)",
              color: "var(--fg-display)",
            }}
          >
            {kitTitle}
          </span>
          {/* The vault's own name on its own kit, which is half of why the name
              step exists. Truncated rather than wrapped: the name is unbounded
              (the backend's cap is 4096 bytes) and this is a header row. */}
          <span
            style={{
              fontSize: "var(--text-sm)",
              color: "var(--fg-3)",
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
            }}
            data-testid="create.kit-meta"
          >
            {[vaultName, savedOn].filter((p) => p.length > 0).join(" · ")}
          </span>
        </div>

        <hr style={RULE_STYLE} />

        <div>
          <p style={SECTION_LABEL_STYLE}>{phraseLabel}</p>
          <PhraseGrid
            phrase={phrase}
            revealed={revealed}
            onReveal={() => dispatch({ type: "PHRASE_REVEALED" })}
            onHide={() => dispatch({ type: "PHRASE_HIDDEN" })}
            testIdPrefix="create.phrase"
          />
        </div>

        <hr style={RULE_STYLE} />

        <div>
          <p style={SECTION_LABEL_STYLE}>{accountLabel}</p>
          <span
            className="t-account-number"
            style={{ fontSize: "var(--text-lg)" }}
            data-testid="create.account-number"
          >
            {accountNumber}
          </span>
        </div>
      </div>

      {/* The two ways out for the kit, side by side and directly under the
          sheet they act on. Save is the one the flow wants; Copy is the
          fallback for a machine with nowhere good to put a file. */}
      <div style={{ display: "flex", gap: "var(--space-2)" }}>
        <Button
          variant="primary"
          icon="download"
          onClick={() => void handleSave()}
          data-testid="create.kit-save"
        >
          {t("vaultCreation.kit.save")}
        </Button>
        <Button
          variant="secondary"
          icon="copy"
          onClick={() => void handleCopy()}
          data-testid="create.kit-copy"
        >
          {t("vaultCreation.kit.copy")}
        </Button>
      </div>

      {/* Both outcomes render: neither button's label swaps, so without this line
          a successful save would be indistinguishable from a click that did
          nothing. */}
      <ActionStatus
        testId="create.kit-action-status"
        message={outcome === null ? null : message[outcome.action](outcome.ok)}
      />

      {/* Why the words are not in the reader's language, said once, where the
          question occurs (myne-md/myne#468). The wordlist is frozen English by
          `protocol.md` §7 so any client can read a phrase any other client
          wrote; without this line an untranslated grid in a translated UI looks
          like a missing translation, and a user "helpfully" translating the
          words back has destroyed their only backup.
          Restored (myne-md/myne#911 review): the identity-phrase screen carries
          this note, but the vault kit still renders a 24-word phrase for every
          vault that is not person-born, so dropping it here left the older path
          with no warning at all. */}
      <p
        style={{
          fontSize: "var(--text-sm)",
          lineHeight: 1.6,
          color: "var(--fg-3)",
          margin: 0,
        }}
        data-testid="create.kit-english-note"
      >
        {t("vaultCreation.kit.whyEnglish")}
      </p>

      <SecretDisplayCaveats testIdPrefix="create.kit" secret="vault" />

      <div style={{ display: "flex", gap: "var(--space-2)", marginTop: "var(--space-2)" }}>
        {onCancelSession && (
          <Button
            variant="ghost"
            onClick={onCancelSession}
            icon="arrow-left"
            data-testid="create.phrase-back"
          >
            {t("vaultCreation.kit.back")}
          </Button>
        )}
        <div style={{ flex: 1 }} />
        <Button
          variant="secondary"
          onClick={() => dispatch({ type: "PHRASE_ACKED" })}
          data-testid="create.phrase-continue"
        >
          {t("vaultCreation.kit.continue")}
        </Button>
      </div>
    </StepLayout>
  );
}
