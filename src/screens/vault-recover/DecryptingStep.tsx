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

import { BlockingProgressStep } from "../../components/BlockingProgressStep";

export function DecryptingStep() {
  return (
    <BlockingProgressStep
      eyebrow="RECOVERY · DECRYPTING"
      heading="Decrypting your vault"
      subCaption="Working… Argon2id m=256 MiB, t=3, p=2"
      caption="This takes a moment."
      footerHint="If this takes longer than 30 seconds, close the window and try again."
      testId="recover.decrypting"
    />
  );
}
