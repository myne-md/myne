// The web build's stand-in for the multi-vault picker
// (phase3-web-client task 70).
//
// # One origin, one container — the ≥2 case cannot happen
//
// The web client's vault id is a CONSTANT (`WEB_VAULT_ID_STR`, task 85): an
// origin holds exactly one container, so `vault_list` returns zero or one
// entry and `initialStageFromProbe`'s `vaults.length >= 2` branch — the only
// producer of the `picker` stage — is unreachable by construction rather than
// by configuration.
//
// Substituted rather than left in place so "excluded" means absent from the
// artefact, not merely unvisited. It also drops the picker's own create and
// restore doors, neither of which web can honour.

import { useTranslation } from "react-i18next";
import { CenteredCard } from "../../../src/components/primitives/CenteredCard";

export interface VaultPickerProps {
  [key: string]: unknown;
}

export function VaultPicker(_props: VaultPickerProps) {
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
        data-surface="multi-vault"
      >
        {t("web.unavailableHere.title")}
      </h1>
      <p style={{ color: "var(--fg-3)" }} data-testid="web.picker-absent">
        {t("web.unavailableHere.multiVault")}
      </p>
    </CenteredCard>
  );
}
