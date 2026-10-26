// Settings → Vault → Vault format: the explicit, irreversible upgrade of an
// existing vault to the person-wrapped (`NTV7`) generation (myne-md/myne#911
// task 10).
//
// **What this row is for.** A vault created before this feature carries a
// per-vault recovery phrase. The person account replaces it with the identity
// phrase, so a vault can be moved to that model deliberately. The move is one
// atomic metadata write: the person envelope is appended and the phrase wrap is
// zeroed, which is why the phrase stops working the instant it commits.
//
// **Why the confirmation is a second press rather than a checkbox.** The two
// facts a user must read before this cannot be undone (the saved vault phrase
// stops opening the vault; clients older than this generation cannot open it
// once it syncs) are the body of the confirm step, and the confirming button
// names the act rather than saying "OK". A checkbox would let the two sentences
// scroll out of view while the box stays ticked.
//
// **The offer is omitted, never greyed, once the vault is already `NTV7`.**
// `vaultIsPersonWrapped` answers that before the row renders, so an upgraded
// vault shows nothing rather than a control whose only outcome is a refusal.
// `protocol.md` §10.4 is the rule this follows: an ordinary unlock never
// changes a vault's format, so the row is the only door and it is a deliberate
// one.
//
// **The section is the component's, not the caller's.** `VaultPanel` used to
// wrap this in `<SettingsSection>`, which drew a heading and its accent rule
// above an empty body whenever this returned null (still probing, in flight, or
// already `NTV7`). A heading is a claim that something is under it, so the
// heading and the row it names ship together.

import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "../primitives/Button";
import { SettingsSection } from "./SettingsSection";
import {
  upgradeVaultToNtv7,
  vaultIsPersonWrapped,
  vaultUpgradeErrorKind,
  type VaultUpgradeError,
} from "../../lib/vault-format-upgrade";

export interface VaultFormatUpgradeProps {
  /** Fired after a committed upgrade, so the panel can re-probe whatever it
   *  shows about this vault. The vault stays unlocked: nothing was re-keyed. */
  onUpgraded?: () => void;
}

type Offer = "checking" | "offer" | "hidden";

type State =
  | { kind: "idle" }
  | { kind: "confirming" }
  | { kind: "running" }
  | { kind: "done"; from: string }
  | { kind: "error"; error: VaultUpgradeError["kind"] };

/**
 * Copy key for a refusal. Every variant names the remedy the user can actually
 * take, because the two most likely ones (`PersonRequired`, `IdentityLocked`)
 * are both "you need your identity, and it is two different actions".
 */
function upgradeErrorMessageKey(error: VaultUpgradeError["kind"]): string {
  switch (error) {
    case "MigrationRequired":
      return "settings.vault.format.error.migrationRequired";
    case "PersonRequired":
      return "settings.vault.format.error.personRequired";
    case "IdentityLocked":
      return "settings.vault.format.error.identityLocked";
    case "PersonMismatch":
      return "settings.vault.format.error.personMismatch";
    case "NotOwner":
      return "settings.vault.format.error.notOwner";
    case "SharedVault":
      return "settings.vault.format.error.sharedVault";
    case "NotUnlocked":
      return "settings.vault.format.error.notUnlocked";
    case "AuthOperationInProgress":
      return "settings.vault.format.error.inProgress";
    case "AlreadyUpgraded":
      return "settings.vault.format.error.alreadyUpgraded";
    default:
      return "settings.vault.format.error.generic";
  }
}

const HELPER_STYLE = {
  color: "var(--fg-3)",
  fontSize: "var(--text-sm)",
  margin: 0,
} as const;

const WARNING_STYLE = {
  color: "var(--fg-2)",
  fontSize: "var(--text-sm)",
  margin: 0,
} as const;

export function VaultFormatUpgrade({
  onUpgraded,
}: VaultFormatUpgradeProps = {}): React.ReactElement | null {
  const { t } = useTranslation();
  const [offer, setOffer] = useState<Offer>("checking");
  const [state, setState] = useState<State>({ kind: "idle" });

  useEffect(() => {
    let live = true;
    void vaultIsPersonWrapped()
      .then((personWrapped) => {
        if (!live) return;
        setOffer(personWrapped ? "hidden" : "offer");
      })
      // A probe that cannot answer (a client with no person plane) hides the
      // row: a control whose backend refuses is exactly the offer the capability
      // descriptor exists to keep off the screen.
      .catch(() => live && setOffer("hidden"));
    return () => {
      live = false;
    };
  }, []);

  if (offer !== "offer") return null;

  const run = () => {
    setState({ kind: "running" });
    void (async () => {
      try {
        const view = await upgradeVaultToNtv7();
        setState({ kind: "done", from: view.upgraded_from });
        onUpgraded?.();
      } catch (raw) {
        setState({
          kind: "error",
          error: vaultUpgradeErrorKind(raw) ?? "Io",
        });
      }
    })();
  };

  if (state.kind === "done") {
    return (
      <SettingsSection title={t("settings.vault.format.heading")}>
        <div data-testid="settings.vault.format-done" style={HELPER_STYLE}>
          {t("settings.vault.format.done", { from: state.from })}
        </div>
      </SettingsSection>
    );
  }

  const running = state.kind === "running";

  return (
    <SettingsSection title={t("settings.vault.format.heading")}>
      <div
        data-setting-anchor="vault.format"
        data-setting-row="true"
        style={{ display: "flex", flexDirection: "column", gap: "var(--space-3)" }}
      >
        <p style={HELPER_STYLE}>{t("settings.vault.format.intro")}</p>

        {state.kind === "confirming" && (
          <div
            role="alert"
            data-testid="settings.vault.format-warning"
            style={{ display: "flex", flexDirection: "column", gap: "var(--space-2)" }}
          >
            <p style={WARNING_STYLE}>{t("settings.vault.format.warningPhrase")}</p>
            <p style={WARNING_STYLE}>{t("settings.vault.format.warningDevices")}</p>
          </div>
        )}

        {state.kind === "error" && (
          <div
            role="alert"
            data-testid="settings.vault.format-error"
            style={{ color: "var(--danger)", fontSize: "var(--text-sm)" }}
          >
            {t(upgradeErrorMessageKey(state.error))}
          </div>
        )}

        <div style={{ display: "flex", alignItems: "center", gap: "var(--space-3)" }}>
          {state.kind === "confirming" ? (
            <>
              <Button
                variant="primary"
                onClick={run}
                data-testid="settings.vault.format-confirm"
              >
                {t("settings.vault.format.confirm")}
              </Button>
              <button
                type="button"
                onClick={() => setState({ kind: "idle" })}
                style={HELPER_STYLE}
                className="myne-text-link"
                data-testid="settings.vault.format-cancel"
              >
                {t("settings.vault.format.cancel")}
              </button>
            </>
          ) : (
            <Button
              variant="primary"
              onClick={() => setState({ kind: "confirming" })}
              disabled={running}
              data-testid="settings.vault.format-cta"
            >
              {running
                ? t("settings.vault.format.running")
                : t("settings.vault.format.cta")}
            </Button>
          )}
        </div>
      </div>
    </SettingsSection>
  );
}
