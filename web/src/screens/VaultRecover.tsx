// The web build's stand-in for phrase recovery (phase3-web-client task 32).
//
// Same mechanism and the same reason as `./CreateVault`: `decisions.md`
// 2026-07-26 forbids the recovery phrase from being **typed into** served code
// as firmly as it forbids generating it there, and hiding the screen would leave
// the phrase-entry grid — and the BIP-39 wordlist it validates against — in the
// bundle. Substituted at build time, so neither is shipped.
//
// The distinction that matters: this is not "recovery is unimplemented on web".
// Recovery by phrase is a **decided absence** (`phraseRecovery` in the capability
// descriptor), and the user's route back into a locked-out account is the desktop
// app, which is where the phrase belongs.

import { useTranslation } from "react-i18next";
import { CenteredCard } from "../../../src/components/primitives/CenteredCard";

export interface VaultRecoverProps {
  [key: string]: unknown;
}

export function VaultRecover(_props: VaultRecoverProps) {
  const { t } = useTranslation();
  return (
    // The container anchor (phase3-web-client task 100). A scenario asserts
    // "absent, not disabled" POSITIVELY — it finds this surface and reads its
    // `data-surface` — rather than by the absence of a selector, which is
    // indistinguishable from a selector somebody renamed.
    <CenteredCard>
      <h1
        style={{ fontFamily: "var(--font-sans)", fontSize: "var(--text-xl)" }}
        data-testid="web.unavailable"
        data-surface="phrase-recovery"
      >
        {t("web.unavailableHere.title")}
      </h1>
      <p style={{ color: "var(--fg-3)" }} data-testid="web.phrase-recovery-absent">
        {t("web.unavailableHere.phraseRecovery")}
      </p>
    </CenteredCard>
  );
}
