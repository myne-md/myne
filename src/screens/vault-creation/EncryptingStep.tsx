// Transient loading screen while the backend `vault-creation:begin`
// command runs Argon2id × 2 in `spawn_blocking` (~1–3 s per RFC).
//
// Implements design session 2026-04-28-vault-creation-frontend.md Q6.1:
//   - Dedicated full-screen step (not an overlay on PasswordStep) so the
//     transition is honest — the user sees "the app is working" rather
//     than a frozen form with a spinner overlay.
//   - No eyebrow (transient state, not a numbered step).
//   - No Cancel button: spawn_blocking is not abortable mid-Argon2id;
//     window-close is the OS-level escape valve. Helper text below the
//     spinner makes that escape path explicit.
//
// Visual + layout delegated to the shared `<BlockingProgressStep>`
// component (`src/components/BlockingProgressStep.tsx`) so the recover
// flow's `decrypting` sub-step (per `recovery-flow.md` §3.3) renders
// the same idiom with a different label.

import { useTranslation } from "react-i18next";
import { BlockingProgressStep } from "../../components/BlockingProgressStep";

export function EncryptingStep() {
  const { t } = useTranslation();
  return (
    <BlockingProgressStep
      heading={t("vaultCreation.encrypting.heading")}
      caption={t("vaultCreation.encrypting.caption")}
      footerHint={t("vaultCreation.encrypting.footerHint")}
      testId="create.encrypting"
    />
  );
}
