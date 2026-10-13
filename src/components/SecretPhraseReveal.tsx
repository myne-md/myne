// SPDX-License-Identifier: AGPL-3.0
// The shared protected recovery-phrase reveal: the grid, its display
// protections, and Copy plus Save-as-file for the phrase alone.
//
// Two callers, and the second one is why this exists (myne-md/myne#768). The
// identity phrase used to render as a plain block, which is the same secret on a
// screen with one showing. The two are different phrases
// (`decisions/protocol/0604` for the identity, `protocol.md` §7 for the vault)
// and neither unlocks the other, but the protection owed while one is on screen
// does not depend on which phrase it is.
//
// Since myne-md/myne#468 the composition is explicit: `<PhraseGrid>` holds the
// blur, the reveal and the walk-away listeners; `<SecretDisplayCaveats>` holds
// the two capability-gated lines; this file adds the phrase-only export row
// between them. The vault-creation kit reuses the first two and brings its own
// export row, because there the file being saved is the phrase AND the account
// number — see `src/screens/vault-creation/KitStep.tsx`.
//
// What is deliberately NOT here: a type-back challenge. The vault flow runs its
// own as a separate reducer step (`vault-creation/ConfirmStep.tsx`) and the
// identity dialog composes it from `PhraseTypeBack`; both gate the commit, and a
// bare checkbox is not evidence (`protocol.md` section 7.1.3). This file stays the
// reveal, so a third caller inherits the challenge by composing the same two
// pieces rather than by copying a grid.

import { useCallback, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "./primitives/Button";
import { ActionStatus, type SecretAction, useActionStatus } from "./ActionStatus";
import { PhraseGrid } from "./PhraseGrid";
import { SecretDisplayCaveats } from "./SecretDisplayCaveats";
import { copySecretToClipboard, saveOutcomeMessage, saveSecretAsTextFile } from "../lib/secret-export";
import { has } from "../platform/capabilities";

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
      <PhraseGrid
        phrase={phrase}
        revealed={revealed}
        onReveal={onReveal}
        onHide={onHide}
        testIdPrefix={testIdPrefix}
        gridTestId={gridTestId}
      />

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
          the caveats are: the desktop string promises a clear in 30 seconds
          and where `clipboardAutoClear` is absent nothing is scheduled at all. */}
      <ActionStatus
        testId={`${testIdPrefix}-action-status`}
        message={outcome === null ? null : message[outcome.action](outcome.ok)}
      />

      <SecretDisplayCaveats testIdPrefix={testIdPrefix} />
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
