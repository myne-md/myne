// SPDX-License-Identifier: AGPL-3.0
// The shared protected recovery-phrase reveal.
//
// One implementation of the display protections a 24-word phrase gets on the
// screens where it is shown exactly once: hidden until revealed, re-hidden when
// the window loses focus or the page is hidden, and Copy plus Save-as-file with
// the platform caveats stated where the guarantee cannot be performed.
//
// Two callers, and the second one is why this exists (myne-md/myne#768). The
// vault-creation phrase had all of this inline; the identity phrase rendered as a
// plain block, which is the same secret on a screen with one showing. The two are
// different phrases (`decisions/protocol/0604` for the identity, `protocol.md` §7
// for the vault) and neither unlocks the other, but the protection owed while one
// is on screen does not depend on which phrase it is.
//
// What is deliberately NOT here: a type-back challenge. `protocol.md` §7.1.3
// mandates one for the vault phrase and the identity phrase gets none
// (`decisions/ui/0615`). Comprehension testing is a property of the vault
// ceremony, not of the reveal.
//
// The protections and their capability gates are `recovery-flow.md` §2.2
// requirements as amended 2026-08-15, and they are the reason the copy success
// sentence and the caveat lines are chosen off `has(...)` rather than written
// once: a client may not claim a guarantee it cannot perform.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "./primitives/Button";
import { Icon } from "./primitives/Icon";
import { ActionStatus, type SecretAction, useActionStatus } from "./ActionStatus";
import { copySecretToClipboard, saveOutcomeMessage, saveSecretAsTextFile } from "../lib/secret-export";
import { has } from "../platform/capabilities";
import type { CSSProperties } from "react";

/**
 * The two platform-caveat lines under the actions. Secondary ink and the small
 * type scale: facts to read once, not warnings to be alarmed by (`PRODUCT.md`
 * register; `docs/design/README.md` voice).
 */
const CAVEAT_STYLE: CSSProperties = {
  color: "var(--fg-3)",
  fontSize: "var(--text-sm)",
  lineHeight: 1.5,
  margin: 0,
  maxWidth: 560,
};

export interface SecretPhraseRevealProps {
  /** The 24 words, already split. Joined with a single space for Copy/Save. */
  phrase: readonly string[];
  /** Whether the grid currently shows its words or is blurred. Owner-held so a
   *  caller can re-hide it for its own reasons (the vault flow's reducer does). */
  revealed: boolean;
  /** Called when the user asks to reveal, and when a walk-away hides it again. */
  onReveal: () => void;
  onHide: () => void;
  /** Testid stem. The grid is `<stem>-grid`, the words `<stem>-word`, the
   *  reveal control `<stem>-reveal`, Copy `<stem>-copy`, Save `<stem>-save` and
   *  the feedback line `<stem>-action-status`. */
  testIdPrefix: string;
  /**
   * Exact testid for the grid, overriding `<stem>-grid`. Exists for the identity
   * dialog, whose existing E2E asserts the bare `identity-setup.phrase` on the
   * grid element. Keeping that contract rather than rewriting the scenario is
   * the point: this change alters how the phrase is protected, not what a
   * scenario addresses.
   */
  gridTestId?: string;
  /** Default filename offered by Save-as-file. */
  saveFilename: string;
}

export function SecretPhraseReveal({
  phrase,
  revealed,
  onReveal,
  onHide,
  testIdPrefix,
  gridTestId,
  saveFilename,
}: SecretPhraseRevealProps) {
  const { t } = useTranslation();
  const phraseString = useMemo(() => phrase.join(" "), [phrase]);

  // Re-blur when the user Cmd-Tabs or the OS hides the window. Two events,
  // because one does not observe the same user action on both platforms
  // (`recovery-flow.md` §2.2 as amended): `blur` catches an app switch and a
  // screen lock on a desktop window, while a browser's most common walk-away is
  // a TAB switch, which `visibilitychange` reports and `blur` may not. Both are
  // registered on both clients; the inert one costs a listener.
  useEffect(() => {
    const onVisibility = () => {
      if (document.visibilityState === "hidden") onHide();
    };
    window.addEventListener("blur", onHide);
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      window.removeEventListener("blur", onHide);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [onHide]);

  const { outcome, feedbackFor } = useActionStatus<SecretAction>();

  // The pending auto-clear is NOT cancelled on unmount, deliberately
  // (myne-md/myne#390). Advancing past this screen is the intended next action,
  // so cancelling there left the words on the system clipboard permanently
  // while the copy had just said they would clear. Letting the clear fire after
  // unmount is safe because it is the host-side compare-and-clear: it only wipes
  // the clipboard if the phrase is still on it.
  const cancelAutoClearRef = useRef<(() => void) | null>(null);

  const handleCopy = useCallback(async () => {
    cancelAutoClearRef.current?.();
    cancelAutoClearRef.current = await copySecretToClipboard(
      phraseString,
      feedbackFor("copy"),
    );
  }, [phraseString, feedbackFor]);

  const handleSave = useCallback(
    () => saveSecretAsTextFile(saveFilename, phraseString, feedbackFor("save")),
    [saveFilename, phraseString, feedbackFor],
  );

  // Exhaustive over `SecretAction`, and both arms branch on a capability.
  // The capability test sits OUTSIDE the call: `check-i18n.mjs` matches a STATIC
  // quoted key, so `t(cond ? "a" : "b")` drops every key it selects out of
  // the only check that proves they exist in the catalog.
  const message: Record<SecretAction, (ok: boolean) => string> = {
    copy: (ok) =>
      ok
        ? has("clipboardAutoClear")
          ? t("vaultCreation.phrase.copied")
          : t("vaultCreation.phrase.copiedNoAutoClear")
        : t("vaultCreation.phrase.copyFailed"),
    save: (ok) =>
      saveOutcomeMessage(ok, {
        saved: t("vaultCreation.phrase.savedToFile"),
        started: t("vaultCreation.phrase.downloadStarted"),
        failed: t("vaultCreation.phrase.saveFailed"),
      }),
  };

  return (
    <>
      <div style={{ position: "relative" }}>
        <div
          data-testid={gridTestId ?? `${testIdPrefix}-grid`}
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
              data-testid={`${testIdPrefix}-word`}
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
              <span style={{ color: "var(--fg-3)", minWidth: 18, textAlign: "end" }}>
                {i + 1}
              </span>
              <span style={{ color: "var(--fg-1)" }}>{word}</span>
            </div>
          ))}
        </div>
        {!revealed && (
          <button
            type="button"
            onClick={onReveal}
            data-testid={`${testIdPrefix}-reveal`}
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
        <Button
          variant="ghost"
          icon="copy"
          onClick={() => void handleCopy()}
          data-testid={`${testIdPrefix}-copy`}
        >
          {t("vaultCreation.phrase.copy")}
        </Button>
        <Button
          variant="ghost"
          icon="download"
          onClick={() => void handleSave()}
          data-testid={`${testIdPrefix}-save`}
        >
          {t("vaultCreation.phrase.saveAsFile")}
        </Button>
      </div>

      {/* Both outcomes render here, because the Copy button's own label does not
          swap on this screen, so without this line a successful copy would be
          invisible. The success string is capability-gated for the same reason
          the caveat below is: the desktop string promises a clear in 30 seconds
          and where `clipboardAutoClear` is absent nothing is scheduled at all. */}
      <ActionStatus
        testId={`${testIdPrefix}-action-status`}
        message={outcome === null ? null : message[outcome.action](outcome.ok)}
      />

      {!has("clipboardAutoClear") && (
        <p data-testid={`${testIdPrefix}-clipboard-notice`} style={CAVEAT_STYLE}>
          {t("vaultCreation.phrase.clipboardNotCleared")}
        </p>
      )}
      {!has("screenCaptureProtection") && (
        <p data-testid={`${testIdPrefix}-extension-notice`} style={CAVEAT_STYLE}>
          {t("vaultCreation.phrase.extensionNotice")}
        </p>
      )}
    </>
  );
}

/**
 * Local reveal state for a caller that owns no reducer, e.g. a dialog. The vault
 * flow keeps its own (`PHRASE_REVEALED` / `PHRASE_HIDDEN`) and passes the pair
 * through, so this hook is not used there.
 */
export function useLocalPhraseReveal(initial = false): {
  revealed: boolean;
  onReveal: () => void;
  onHide: () => void;
} {
  const [revealed, setRevealed] = useState(initial);
  const onReveal = useCallback(() => setRevealed(true), []);
  const onHide = useCallback(() => setRevealed(false), []);
  return { revealed, onReveal, onHide };
}
