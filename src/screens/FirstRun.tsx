// SPDX-License-Identifier: AGPL-3.0
// The first run (myne-md/myne#911 task 6): identity first, then the vault.
//
// # Why this is a stage and not the welcome screen
//
// The welcome screen used to offer a fork: create an identity, or create a local
// vault with no identity, and a skip was implied by which row you pressed. That
// is gone. A person is the thing Myne is organised around, the account number
// belongs to them rather than to a vault, and one phrase recovers THEM on any
// device (it opens no vault, myne-md/myne#938), so "create" has to mean one
// thing: the identity, then the vault.
//
// A stage rather than a mode inside `welcome` because the two screens answer
// different questions. Welcome asks "what do you want to do on this device" and
// keeps the restore and join doors; this asks one thing and has no fork to draw.
//
// # The kit
//
// The phrase step IS the recovery kit now: one phrase, one save action, one
// type-back, and that phrase is the identity's (the vault's own phrase is
// retired, myne-md/myne#911 task 5, and on the `NTV8` generation the vault has no
// phrase at all, myne-md/myne#938). There is deliberately no second kit on the
// vault that follows: `CreateVault` skips its kit and type-back when the backend
// returns no phrase, so the user meets exactly one "keep this forever" moment.
// What that moment buys is narrower than it reads: the words get the person back
// on a new device and open no note, and the vault password is the only thing that
// does.
//
// # Abandoning
//
// The way out is NOT a cancel, and it is not labelled as one. An identity created
// a moment ago exists, sealed on this device, and its phrase is on screen;
// treating the exit as a rollback would be a lie the disk contradicts. So the exit
// re-probes, and boot routing sends a device with an identity and no vault to the
// identity home (`myne-md/myne#911` task 4), which is exactly where an abandoned
// first run should land. It is drawn as the back arrow every other first-run step
// uses (bottom-left, `ghost` + `arrow-left`), because a way out of the flow is a
// step back rather than a sentence under the card.
import { useTranslation } from "react-i18next";
import { MyneMark } from "../components/primitives/MyneMark";
import { stageRootStyle } from "../components/primitives/stageRoot";
import { IdentitySetupPanel } from "../components/IdentitySetupPanel";

interface FirstRunProps {
  /** The ceremony finished. App advances to vault creation. */
  onIdentityCreated: () => void;
  /** The user left without finishing (or after finishing the identity but
   *  before the vault). App re-probes, which lands on the identity home when the
   *  identity exists and on welcome when it does not. */
  onAbandon: () => void;
}

export function FirstRun({ onIdentityCreated, onAbandon }: FirstRunProps) {
  const { t } = useTranslation();
  return (
    <div
      data-testid="first-run.root"
      style={{
        ...stageRootStyle,
        background: "var(--bg-1)",
        padding: "var(--space-5)",
      }}
    >
      <div
        style={{
          width: 520,
          maxWidth: "100%",
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
        }}
      >
        {/* The same mark and wordmark the welcome screen shows, so entering the
            first run reads as the same app continuing rather than a new
            surface. */}
        <MyneMark size={64} />
        <div
          style={{
            marginTop: "var(--space-3)",
            fontFamily: "var(--font-display)",
            fontSize: "var(--text-2xl)",
            fontWeight: "var(--weight-semibold)",
            letterSpacing: "var(--tracking-tight)",
            color: "var(--fg-display)",
            textAlign: "center",
          }}
        >
          {t("firstRun.heading")}
        </div>
        <div
          style={{
            marginTop: "var(--space-5)",
            width: "100%",
          }}
        >
          <IdentitySetupPanel
            testIdPrefix="first-run.identity"
            onDone={onIdentityCreated}
            onCancel={onAbandon}
          />
        </div>
      </div>
    </div>
  );
}
