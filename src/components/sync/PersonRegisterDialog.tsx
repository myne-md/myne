// SPDX-License-Identifier: AGPL-3.0
// The register-an-identity DIALOG (2026-10-24 owner report).
//
// # Why the act moved into a dialog
//
// It used to expand inline inside whatever was asking: the identity home's
// invitation section, and a Settings row. Two things were wrong with that.
//
//  - **On the identity home it made the card unreadable.** That card already
//    carries the account number, the invite code and the invitation list, and the
//    register block added a 24-cell grid to the same scroll region. In the owner's
//    screenshot the block is what pushed the card past the window; every other
//    destructive or consequential confirmation in the app (the forget-identity
//    dialog in the same file, `DeleteAttachmentDialog`) gets `ModalShell` chrome
//    instead, and this one states MORE than either of them: which server the
//    identity will be written to, plus a full identity credential.
//  - **It was a step of a flow with no beginning and no end.** Inline, the only
//    way out was to press Register or leave the screen; a dialog says what it is
//    asking for and offers Cancel.
//
// The host owns only whether it is up, and `PersonRegisterForm` owns the phrase,
// the address, the admission code and the failure arms, so one act has one
// implementation whether it is opened from zero vaults or from Settings.
//
// **The portal is the caller's job, deliberately** (`IdentityHome`): `CenteredCard`
// masks its scroll region with `mask-image` once the content outgrows the window,
// and a mask clips its whole rendered subtree, a fixed-position backdrop
// included, so a dialog mounted in there is faded and cut at the edges. Settings
// mounts this directly because `SettingsModal` is already an overlay.
import { useTranslation } from "react-i18next";
import { ModalShell } from "../primitives/ModalShell";
import { PersonRegisterForm } from "./PersonRegisterForm";

/** `ModalShell`'s `.myne-modal-body` is a flex column with `overflow: hidden`,
 *  so the form is given the full body and manages its own scroll region plus a
 *  pinned action row: 24 cells outgrow a short window, and buttons that scroll
 *  out of view read as unanswerable (`BetaTermsConsent` carries the same shape).
 *  No padding here, the form owns it. */

export function PersonRegisterDialog({
  open,
  testIdPrefix,
  onRegistered,
  onClose,
}: {
  open: boolean;
  /** `data-testid` prefix carried through to the form, plus `-dialog` for the
   *  backdrop root (the element whose presence means "this dialog is up"). */
  testIdPrefix: string;
  onRegistered: () => void;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  return (
    <ModalShell
      open={open}
      title={t("common.registerthisidentity")}
      labelId={`${testIdPrefix.replace(/\./g, "-")}-title`}
      closeLabel={t("common.close")}
      onClose={onClose}
      width={560}
      testId={`${testIdPrefix}-dialog`}
    >
      <PersonRegisterForm
        testIdPrefix={testIdPrefix}
        onRegistered={onRegistered}
        onCancel={onClose}
      />
    </ModalShell>
  );
}
