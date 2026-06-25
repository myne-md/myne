// Decrypting sub-step. Consumes the shared `<BlockingProgressStep>`
// in canon parity with vault-creation's `screen------encrypting`
// frame — eyebrow + heading + sub-caption (KDF params) + body +
// footer hint. Penpot canon: `screen------recover--decrypting`
// (cloned from `screen------encrypting`, label-only delta).
//
// No Cancel (spec §3.3 — Argon2id is not abortable mid-iteration),
// no Lock affordance (TOCTOU window — `vault_unlock/commands.rs`
// documents the silent-swallow risk if vault_lock arrives
// mid-Argon2id).

import { useTranslation } from "react-i18next";
import { BlockingProgressStep } from "../../components/BlockingProgressStep";

export function DecryptingStep() {
  const { t } = useTranslation();
  return (
    <BlockingProgressStep
      eyebrow={t("vaultRecover.decrypting.eyebrow")}
      heading={t("vaultRecover.decrypting.heading")}
      subCaption={t("vaultRecover.decrypting.subCaption")}
      caption={t("vaultRecover.decrypting.caption")}
      footerHint={t("vaultRecover.decrypting.footerHint")}
      testId="recover.decrypting"
    />
  );
}
