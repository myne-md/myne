// Step 2 of 4 — recovery phrase reveal + Copy/Save + acknowledgement.
//
// Implements design session 2026-04-28-vault-creation-frontend.md:
//   - Q4.1 reveal pattern: blur-by-default + click reveal + window-blur
//     listener that re-blurs on Cmd-Tab / app-switch (walk-away guard).
//   - Q4.2 actions: Copy + Save-as-file via Tauri plugins; clipboard
//     auto-clear after 30 s with a read-precondition (only clear if the
//     content still matches the phrase we wrote, so we never nuke the
//     user's later clipboard).
//   - Q4.3 hierarchy: Copy + Save are ghost variant; "I've saved this →
//     confirm phrase" is the visually primary CTA.
//   - Q8.1 Back from PhraseStep dispatches RESET_TO_PASSWORD; the
//     orchestrator's effect (this file calls a callback) fires
//     `cancel(sessionToken)` and resets the reducer to a fresh password
//     step. No confirmation modal — the user has not saved anything yet.
//   - Q10 step indicator: STEP 2 OF 4 — RECOVERY PHRASE.
//
// Spec: protocol.md § 7 (BIP-39 24-word, English wordlist) + § 7.5.

import { useEffect, useMemo, useRef, type CSSProperties, type Dispatch } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "../../components/primitives/Button";
import { Icon } from "../../components/primitives/Icon";
import {
  ActionStatus,
  type SecretAction,
  useActionStatus,
} from "../../components/ActionStatus";
import {
  copySecretToClipboard,
  saveSecretAsTextFile,
} from "../../lib/secret-export";
import { StepEyebrow, StepHeading, StepLayout } from "./step-shell";
import type { Action } from "./reducer";
import { has } from "../../platform/capabilities";

interface PhraseStepProps {
  phrase: string[];
  revealed: boolean;
  dispatch: Dispatch<Action>;
  /**
   * Abandon the half-made vault and return to the password step.
   *
   * OPTIONAL, and absent means the Back control is not rendered at all rather
   * than rendered and inert. It is absent on the ordering this flow uses where
   * sync is required: there the vault is committed and the account registered
   * BEFORE the phrase is shown, so by the time this screen exists there is no
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

/**
 * The two platform-caveat lines under the Copy / Save row. Secondary ink and the
 * small type scale: these are facts to read once, not warnings to be alarmed by
 * (`PRODUCT.md` register; `docs/design/README.md` voice).
 */
const CAVEAT_STYLE: CSSProperties = {
  color: "var(--fg-3)",
  fontSize: "var(--text-sm)",
  lineHeight: 1.5,
  margin: 0,
  maxWidth: 560,
};

export function PhraseStep({
  phrase,
  revealed,
  dispatch,
  onCancelSession,
}: PhraseStepProps) {
  const { t } = useTranslation();
  // Re-blur when the user Cmd-Tabs or the OS hides the window.
  //
  // **Two events, because one of them does not observe the same user action on
  // both platforms** (`recovery-flow.md` §2.2 as amended 2026-08-15). `blur`
  // catches Cmd-Tab, an app switch and a screen lock, which is the whole
  // walk-away surface on a desktop window. In a browser the most common
  // walk-away is a TAB switch, and whether that fires `blur` is not something to
  // rely on — `visibilitychange` is the event that actually reports it. Both are
  // registered on both clients: the extra listener is inert where the platform
  // does not fire it, and a capability check here would be gating a listener
  // rather than a feature.
  useEffect(() => {
    const hide = () => dispatch({ type: "PHRASE_HIDDEN" });
    const onVisibility = () => {
      if (document.visibilityState === "hidden") hide();
    };
    window.addEventListener("blur", hide);
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      window.removeEventListener("blur", hide);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [dispatch]);

  const phraseString = useMemo(() => phrase.join(" "), [phrase]);

  // myne-md/myne#390: this step had no copy feedback at all, and no i18n keys
  // for one, it was never given the affordance rather than given it wrongly.
  const { outcome, feedbackFor } = useActionStatus<SecretAction>();

  // This used to cancel the pending auto-clear on unmount, and that was wrong in
  // a way the copy made visible (myne-md/myne#390): advancing to the confirm step
  // is the intended next action and takes seconds, so cancelling there left the
  // twenty-four words on the system clipboard PERMANENTLY, while the screen had
  // just said they would clear in thirty seconds. A promise the mechanism cannot
  // keep is the exact class of claim this feature exists to remove.
  //
  // The cancel existed for a heap reason that no longer applies: the timer's
  // closure used to capture the phrase for the whole window. `copySecret` now
  // releases it on both exits (`src/lib/clipboard.ts`), so what remains is a
  // 30 s reference in a process that already holds the phrase in React state -
  // not a new exposure, and far cheaper than an indefinite one on a clipboard
  // every other app can read.
  //
  // Letting it fire after unmount is safe: the clear is the host-side
  // compare-and-clear, so it only wipes the clipboard if the phrase is still on
  // it. A user who copied something else in the window keeps it.
  const cancelAutoClearRef = useRef<(() => void) | null>(null);

  const handleCopy = async () => {
    cancelAutoClearRef.current?.();
    // The surface myne-md/myne#390 opened on, and the reason both arms are INLINE
    // and persistent rather than toasts. This is the screen where the twenty-four
    // words are shown ONCE and never again. Before this, pressing Copy changed
    // nothing on screen whether it worked or not, so "I pressed Copy" was not
    // evidence the phrase was anywhere, and a user who believed a failed copy
    // had worked has an unrecoverable vault the moment they leave.
    //
    // A transient toast would be the weakest option available here: on a
    // shown-once screen, a confirmation the user can miss is barely better than
    // none.
    cancelAutoClearRef.current = await copySecretToClipboard(
      phraseString,
      feedbackFor("copy"),
    );
  };

  const handleSave = () =>
    saveSecretAsTextFile("myne-recovery-phrase.txt", phraseString, feedbackFor("save"));

  // Exhaustive over `SecretAction`, so a third affordance is a compile error
  // rather than a silent fall into the save sentence. Both arms branch on a
  // capability, because this client may not promise either guarantee it cannot
  // perform: the clipboard clear (`recovery-flow.md` §2.2) and, on the save
  // half, a write it never observes.
  //
  // The capability test sits OUTSIDE `t(...)`, not inside it as
  // `t(cond ? "a" : "b")`. `check-i18n.mjs` matches a STATIC `t("literal")`, so
  // the inner form drops every key it selects out of the only check that proves
  // they exist in the catalog. Measured: moving two keys inside took the guard's
  // count from 2543 to 2541 while adding two keys.
  const message: Record<SecretAction, (ok: boolean) => string> = {
    copy: (ok) =>
      ok
        ? has("clipboardAutoClear")
          ? t("vaultCreation.phrase.copied")
          : t("vaultCreation.phrase.copiedNoAutoClear")
        : t("vaultCreation.phrase.copyFailed"),
    // Same capability split on the save half, and for the same reason: the
    // download arm cannot observe whether the browser wrote the file, so it may
    // not say it did (myne-md/myne#520 review).
    save: (ok) =>
      ok
        ? has("nativeSaveAs")
          ? t("vaultCreation.phrase.savedToFile")
          : t("vaultCreation.phrase.downloadStarted")
        : t("vaultCreation.phrase.saveFailed"),
  };

  return (
    <StepLayout width={600}>
      <StepEyebrow icon="key-round">{t("vaultCreation.phrase.eyebrow")}</StepEyebrow>
      <StepHeading>{t("vaultCreation.phrase.heading")}</StepHeading>

      <div style={{ fontSize: "var(--text-base)", lineHeight: 1.6, color: "var(--fg-2)" }}>
        {t("vaultCreation.phrase.intro")}
      </div>

      <div style={{ position: "relative" }}>
        <div
          data-testid="create.phrase-grid"
          data-revealed={revealed}
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(4, 1fr)",
            gap: 6,
            padding: "var(--space-4)",
            background: "var(--paper-2)",
            border: "1px solid var(--line-1)",
            borderRadius: "var(--radius-2)",
            filter: revealed ? "none" : "blur(8px)",
            transition: "filter 180ms cubic-bezier(0.2,0,0,1)",
            userSelect: revealed ? "text" : "none",
          }}
        >
          {phrase.map((word, i) => (
            <div
              key={i}
              data-testid="create.phrase-word"
              data-index={i + 1}
              style={{
                display: "flex",
                alignItems: "baseline",
                gap: 6,
                padding: "6px 10px",
                background: "var(--bg-1)",
                border: "1px solid var(--line-1)",
                borderRadius: "var(--radius-1)",
                fontFamily: "var(--font-mono)",
                fontSize: "var(--text-sm)",
                fontFeatureSettings: '"ss02","zero","calt"',
              }}
            >
              <span
                style={{
                  color: "var(--fg-3)",
                  minWidth: 18,
                  textAlign: "end",
                }}
              >
                {i + 1}
              </span>
              <span style={{ color: "var(--fg-1)" }}>{word}</span>
            </div>
          ))}
        </div>
        {!revealed && (
          <button
            type="button"
            onClick={() => dispatch({ type: "PHRASE_REVEALED" })}
            data-testid="create.phrase-reveal"
            style={{
              position: "absolute",
              inset: 0,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              background: "transparent",
              border: 0,
              cursor: "pointer",
              color: "var(--fg-1)",
              fontFamily: "var(--font-sans)",
              fontSize: "var(--text-sm)",
              fontWeight: "var(--weight-medium)",
            }}
          >
            <span
              style={{
                display: "inline-flex",
                alignItems: "center",
                gap: "var(--space-2)",
                padding: "8px 14px",
                background: "var(--bg-1)",
                border: "1px solid var(--line-2)",
                borderRadius: "var(--radius-2)",
              }}
            >
              <Icon name="eye" size={14} />
              {t("vaultCreation.phrase.reveal")}
            </span>
          </button>
        )}
      </div>

      <div style={{ display: "flex", alignItems: "center", gap: "var(--space-2)" }}>
        <Button variant="ghost" icon="copy" onClick={handleCopy} data-testid="create.phrase-copy">
          {t("vaultCreation.phrase.copy")}
        </Button>
        <Button
          variant="ghost"
          icon="download"
          onClick={handleSave}
          data-testid="create.phrase-save"
        >
          {t("vaultCreation.phrase.saveAsFile")}
        </Button>
      </div>

      {/* Both outcomes render here, unlike the account step's, because the Copy
          button's own label does NOT swap on this screen, so without this line
          a successful copy would still be invisible.

          The SUCCESS string is capability-gated for the same reason the caveat
          below it is, and skipping that gate is what the two changes that met
          here each half-did. The desktop string promises a clear in 30 seconds;
          where `clipboardAutoClear` is absent nothing is scheduled at all
          (`secret-export.ts` passes the `none` strategy), so that sentence
          would appear in direct response to the user's press, eight lines above
          a paragraph saying the opposite. On the one screen where the phrase is
          shown once and never again, the false half is the one the user acts
          on. */}
      <ActionStatus
        testId="create.phrase-action-status"
        message={outcome === null ? null : message[outcome.action](outcome.ok)}
      />

      {/* The two sentences this client owes the user and the desktop does not.
          Both are `recovery-flow.md` §2.2 requirements as amended 2026-08-15,
          and both are stated rather than implied: a control whose protection
          the platform cannot perform may not be presented as if it could, and
          an exposure the page cannot prevent has to be named. Rendered
          together, in the calm register `PRODUCT.md` asks for — a fact and what
          to do about it, not a warning banner. */}
      {!has("clipboardAutoClear") && (
        <p
          data-testid="create.phrase-clipboard-notice"
          style={CAVEAT_STYLE}
        >
          {t("vaultCreation.phrase.clipboardNotCleared")}
        </p>
      )}
      {!has("screenCaptureProtection") && (
        <p data-testid="create.phrase-extension-notice" style={CAVEAT_STYLE}>
          {t("vaultCreation.phrase.extensionNotice")}
        </p>
      )}

      <div style={{ display: "flex", gap: "var(--space-2)", marginTop: "var(--space-2)" }}>
        {onCancelSession && (
          <Button
            variant="ghost"
            onClick={onCancelSession}
            icon="arrow-left"
            data-testid="create.phrase-back"
          >
            {t("vaultCreation.phrase.back")}
          </Button>
        )}
        <div style={{ flex: 1 }} />
        <Button
          variant="primary"
          onClick={() => dispatch({ type: "PHRASE_ACKED" })}
          data-testid="create.phrase-continue"
        >
          {t("vaultCreation.phrase.continue")}
        </Button>
      </div>
    </StepLayout>
  );
}
