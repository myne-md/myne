// The step between `begin` and the phrase screen on a client where sync is
// required (`decisions.md` 2026-08-15).
//
// # Why the flow has an extra step here at all
//
// Desktop creation ends at the local write: a vault exists once `commit` says
// so, and pointing it at a server is a separate, later, optional decision. The
// web client cannot do that — `decisions.md` 2026-07-26 makes sync REQUIRED
// there, so a browser vault with no account behind it is a thing this client's
// own rules say cannot exist.
//
// # Why it sits BEFORE the phrase and not after
//
// `recovery-flow.md` §2.4 is a no-re-display commitment: the phrase is shown
// exactly once and never again. Register after showing it and a failure leaves
// the user holding 24 words for an account that was never created — and a retry
// mints a DIFFERENT phrase, so the words they carefully wrote down are silently
// wrong for the vault they end up with. That is a permanent data-loss trap, not
// a cosmetic ordering preference, which is why the ordering is stated in the
// decision entry rather than left to the screen.
//
// Same `<BlockingProgressStep>` idiom as `EncryptingStep` and the recover flow's
// decrypting sub-step: a dedicated honest screen rather than a spinner over a
// form, and no Cancel — there is no half-created account to leave behind,
// because the failure path erases what it wrote.

import { useTranslation } from "react-i18next";
import { BlockingProgressStep } from "../../components/BlockingProgressStep";

export function ProvisioningStep() {
  const { t } = useTranslation();
  return (
    <BlockingProgressStep
      heading={t("vaultCreation.provisioning.heading")}
      caption={t("vaultCreation.provisioning.caption")}
      footerHint={t("vaultCreation.provisioning.footerHint")}
      testId="create.provisioning"
    />
  );
}
