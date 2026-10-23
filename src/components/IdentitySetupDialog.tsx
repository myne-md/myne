// SPDX-License-Identifier: AGPL-3.0
// Identity-only setup DIALOG (myne-md/myne#711, b2b-member-sync).
//
// A vault-less person can add an identity without creating a vault: a 24-word
// phrase is generated and shown ONCE, the keypair is derived and sealed
// backend-side. Recovering an existing identity takes its phrase instead.
//
// Since myne-md/myne#911 task 6 this file is a FRAME and nothing else. The
// ceremony itself is `IdentitySetupPanel`, because the first run is not a dialog
// and needed the same body inline (see that file's header). What stays here is
// the modal contract: the title, the `ModalShell` chrome, and the refusal to
// dismiss while a phrase has been shown but not yet proven.
//
// Settings → Sync is the remaining host. The first run mounts the panel
// directly, so this dialog is no longer part of onboarding.
import { useCallback, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { ModalShell } from "./primitives/ModalShell";
import { IdentitySetupPanel } from "./IdentitySetupPanel";

interface IdentitySetupDialogProps {
  open: boolean;
  onClose: () => void;
  /** Fired after a successful setup/recover so the host can re-probe and land
   *  the user on the identity home. */
  onCreated?: () => void;
}

/** Which half of the ceremony is on screen (myne-md/myne#869). */
type Step = "phrase" | "confirm";

export function IdentitySetupDialog({ open, onClose, onCreated }: IdentitySetupDialogProps) {
  const { t } = useTranslation();
  // Which half of the ceremony is on screen (myne-md/myne#869). The dialog owns
  // it because the TITLE depends on it, and that cannot be read out of the panel.
  const [step, setStep] = useState<Step>("phrase");
  // Whether a phrase exists at all, which is what makes the TITLE name the
  // step: a created identity has a phrase to show and to prove, a recovered one
  // does not.
  const [ceremonyStarted, setCeremonyStarted] = useState(false);
  // Whether the ceremony produced a RESULT, which is a different fact from
  // "a phrase was shown" and is the one the host needs: a RECOVERED identity
  // returns `phrase: null`, so a phrase-derived flag never fires on that arm and
  // `onCreated` was never called there (myne-md/myne#911 review). The panel's
  // Done CTA is reachable only once a result exists, so it is the reset point
  // that knows; nothing here can infer it from the state the panel reports.
  const ceremonyResult = useRef(false);

  // The gate reads live state through a REF and is one stable predicate for the
  // life of the dialog.
  //
  // Both halves are load-bearing, and the reason is a defect this shipped with
  // for one review round: a closure-based predicate can be read by a listener
  // registered on an earlier render, and that stale copy answers for the state
  // the ceremony has already left. Measured: on the phrase step the close button
  // was correctly gone (`dismissBlocked`, evaluated per render) while the first
  // Escape still closed the dialog, because the listener that fired had captured
  // `started = false` from before the phrase existed. A ref cannot go stale, so
  // the predicate is right whichever listener asks.
  //
  // The state setter beside it is only for RENDERING the ×, which has to appear
  // and disappear with the gate. It bumps when the answer flips, so the dialog
  // does not re-render on every keystroke of the type-back.
  const ceremonyState = useRef({
    phraseShown: false,
    step: "phrase" as Step,
    challengePassed: false,
  });
  const gate = useRef({ dismissible: true });
  const [, setGateVersion] = useState(0);
  // Reads the panel's LIVE facts, so it is correct whichever listener asks and
  // whenever it was registered. `gate.current` is the presentation mirror.
  const canDismiss = useCallback(
    () => !ceremonyState.current.phraseShown || ceremonyState.current.challengePassed,
    [],
  );
  const onCeremonyState = useCallback(
    (state: { phraseShown: boolean; challengePassed: boolean; step: Step }) => {
      const dismissible = !state.phraseShown || state.challengePassed;
      if (dismissible !== gate.current.dismissible) {
        gate.current.dismissible = dismissible;
        setGateVersion((v) => v + 1);
      }
      // Two facts the frame cannot read off the panel: whether a phrase exists
      // (which is what makes Done a CREATE rather than a recovery) and which
      // half of the ceremony the title should name.
      setCeremonyStarted(state.phraseShown);
      setStep(state.step);
    },
    [],
  );

  function close() {
    // The ENFORCEMENT point, not a second opinion. Hiding the × and swallowing
    // Escape are presentation; this is the one place every route out arrives,
    // and React's render order makes it necessary: a parent renders before its
    // children, so the frame's `dismissBlocked` is always one commit behind the
    // panel's own facts. That is invisible for the × (it goes a frame later)
    // and unacceptable for a refusal (a click in that frame must not skip the
    // challenge). Measured as a flake in `identitySetupTypeBack` before this
    // guard existed.
    if (!canDismiss()) return;
    // A result, not a phrase: see `ceremonyResult`'s declaration for why the
    // two are not the same fact.
    const created = ceremonyResult.current;
    ceremonyResult.current = false;
    setStep("phrase");
    gate.current.dismissible = true;
    onClose();
    if (created) onCreated?.();
  }

  return (
    <ModalShell
      open={open}
      title={
        ceremonyStarted
          ? step === "confirm"
            ? t("identitySetup.confirmTitle")
            : t("identitySetup.phraseTitle")
          : t("identitySetup.title")
      }
      onClose={close}
      labelId="identity-setup-title"
      testId="identity-setup.root"
      canDismiss={canDismiss}
    >
      {/* The modal body carries no padding of its own (Settings fills it edge
          to edge), so a dialog that wants an inset supplies it. This one did
          not, and its copy ran into the frame. */}
      <div style={{ padding: "var(--space-5)", overflowY: "auto", minHeight: 0 }}>
        <IdentitySetupPanel
          // The re-probe is deferred to the Done CTA (not fired from the
          // panel's own create), because the generated recovery phrase is shown
          // ONCE and must stay on screen until the user dismisses it: firing
          // `onCreated` earlier lets the host re-route and unmount the surface
          // before the phrase ever renders.
          //
          // Done is also the only signal that a ceremony RESULT exists, and the
          // frame cannot read that off the state the panel reports (a recovered
          // identity's `phraseShown` is false), so this is where it is recorded.
          onDone={() => {
            ceremonyResult.current = true;
            close();
          }}
          onCeremonyState={onCeremonyState}
          ceremonyStateRef={ceremonyState}
        />
      </div>
    </ModalShell>
  );
}
