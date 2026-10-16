// Settings → Account panel: the account-level surface, and ONLY that.
//
// ── What "account" means here ───────────────────────────────────────────────
// The account is the DEVICE-LOCAL grouping of vaults (myne-md/myne#684): the
// name a user gives to the set of vaults this device treats as one identity.
// It is a per-device organisational choice, sealed in the device-local record,
// and it never syncs. The vault's OWN name (`vault.prefs.label`) is a different
// thing entirely: it lives inside the sealed container and it does sync. That
// one is in the Vault panel.
//
// ── Why this panel was rewritten rather than extended ───────────────────────
// Until the split this panel contained no account-level control at all: change
// password, vault label, vault icon and the danger zone all act on the sealed
// container, and the account the panel is named after appeared nowhere. A user
// could not rename their account, or even see which vaults share it, anywhere
// after unlock. Those five vault controls moved to the Vault panel
// (`settings/VaultPanel.tsx`) and this panel kept the one thing that is
// genuinely account-scoped: the grouping.
//
// ── What is deliberately NOT here yet ───────────────────────────────────────
// Devices, the member roster and the person identity stay in the Sync panel.
// They are account-shaped, but they are wired into the sync status indicator,
// the enrollment gate, the beta-terms gate and the child-dialog gating that
// live there, and moving them is a change of its own rather than a paragraph of
// this one. The pointer under the account block is what keeps them findable in
// the meantime.

import {
  useEffect,
  useState,
  type CSSProperties,
} from "react";
import { useTranslation } from "react-i18next";
import { Button } from "../primitives/Button";
import { Input } from "../primitives/Input";
import * as capabilities from "../../platform/capabilities";
import { ConnectedExtensions } from "./ConnectedExtensions";
import { SettingsSection, SettingsSectionCounter } from "./SettingsSection";
import { ControlBlock } from "./ControlBlock";
import { SettingRow } from "./SettingRow";
import { HELPER_STYLE } from "./panel-styles";
import {
  accountCommandErrorKind,
  accountIdForVault,
  listAccounts,
  renameAccount,
  truncateLabelToBytes,
  type AccountView,
} from "../../lib/account";
import { listVaults, orderByLastUnlock } from "../../lib/vault-list";
import { vaultDisplayNameById } from "../../lib/vaultDisplayName";
import type { VaultSummary } from "../../types/vault-summary";
import i18n from "../../i18n";

/**
 * The backend's byte cap on an account label (`ACCOUNT_LABEL_MAX_LEN`).
 *
 * Inputs count in characters while the backend counts UTF-8 bytes, so a
 * multibyte draft can pass `maxLength` and still trip `LabelTooLong`;
 * `truncateLabelToBytes` is what keeps the two in agreement. Same 512 the vault
 * picker's rename form uses.
 */
const ACCOUNT_LABEL_MAX_LEN = 512;

/** Copy for an account-command failure, or `null` for the kinds this panel has
 *  no honest sentence for. `LabelTooLong` cannot be reached through the input
 *  (it truncates), so it shares the generic line rather than getting a banner
 *  nothing can trigger. */
function accountErrorCopy(e: unknown): string {
  switch (accountCommandErrorKind(e)) {
    case "Hidden":
      return i18n.t("settings.account.groupingHidden");
    case "RecordUnreadable":
      return i18n.t("settings.account.groupingUnreadable");
    default:
      return i18n.t("settings.account.groupingError");
  }
}

const INPUT_ROW_STYLE: CSSProperties = {
  display: "flex",
  flexDirection: "row",
  alignItems: "center",
  gap: "var(--space-2)",
  alignSelf: "stretch",
  marginTop: "var(--space-1)",
};

const VAULT_ROW_STYLE: CSSProperties = {
  display: "flex",
  flexDirection: "row",
  alignItems: "baseline",
  gap: "var(--space-2)",
  fontSize: "var(--text-sm)",
  color: "var(--ink-2)",
};

export interface AccountPanelProps {
  /**
   * The active vault's id, from `SettingsModal`. It is what resolves WHICH
   * account this panel is about (`accountIdForVault`) and what
   * `account_rename` takes, since the backend addresses an account through one
   * of its member vaults.
   *
   * `null` while a post-reload editor is still resolving it: the panel then
   * states that it does not know which vault it is looking at rather than
   * aiming a rename at a guess.
   */
  vaultId: string | null;
}

export function AccountPanel({ vaultId }: AccountPanelProps) {
  const { t } = useTranslation();

  // `account === null` after a successful load means the vault is STANDALONE on
  // this device (no account record, or a keychain-less device), which is a real
  // state and not an error: the picker shows that vault without a group header
  // and offers no account actions for it.
  const [account, setAccount] = useState<AccountView | null>(null);
  const [vaults, setVaults] = useState<VaultSummary[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);

  // The draft mirrors `saved`; Save is enabled only while the two differ.
  const [saved, setSaved] = useState("");
  const [draft, setDraft] = useState("");
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoaded(false);
    setLoadError(null);
    void (async () => {
      // The vault list and the account grouping are independent reads: a vault
      // list failure costs the row NAMES and not the panel, so it is folded
      // into an empty list rather than into the error state.
      const vaultsPromise = listVaults().then(
        (r) => ("ok" in r ? r.ok : []),
        () => [] as VaultSummary[],
      );
      try {
        const accounts = await listAccounts();
        const list = await vaultsPromise;
        if (cancelled) return;
        const id = vaultId === null ? null : accountIdForVault(accounts, vaultId);
        const found =
          id === null ? null : (accounts.find((a) => a.id === id) ?? null);
        setAccount(found);
        setSaved(found?.label ?? "");
        setDraft(found?.label ?? "");
        setVaults(orderByLastUnlock(list));
      } catch (e) {
        if (cancelled) return;
        // A device with no keychain, or an unreadable record, cannot show the
        // grouping. Say so instead of rendering the standalone state, which
        // would claim the vault has no account when the truth is unknown.
        setLoadError(accountErrorCopy(e));
      } finally {
        if (!cancelled) setLoaded(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [vaultId]);

  const trimmed = draft.trim();
  const changed = trimmed !== saved;
  const saveDisabled = !changed || trimmed === "" || saving;

  const handleSave = () => {
    if (saveDisabled || vaultId === null) return;
    setSaving(true);
    setSaveError(null);
    void (async () => {
      try {
        // `account_rename` answers with the updated record, so the panel
        // re-seeds from the backend's own value rather than from the draft: a
        // backend-side trim or cap then shows up here instead of being
        // remembered wrongly.
        const updated = await renameAccount(vaultId, trimmed);
        setAccount(updated);
        setSaved(updated.label);
        setDraft(updated.label);
      } catch (e) {
        // Leave the draft as typed so the user can retry or correct it; the
        // banner carries the reason.
        setSaveError(accountErrorCopy(e));
      } finally {
        setSaving(false);
      }
    })();
  };

  const groupingKnown = account !== null;

  return (
    // The shared section treatment (myne-md/myne#885): the account grouping and
    // the paired browser extensions are two concerns, so two seams, and the
    // counter drops the heading where the extensions section is absent (the web
    // client) and the grouping is the panel's only section.
    <SettingsSectionCounter>
    <div
      style={{ display: "flex", flexDirection: "column", gap: "var(--space-5)" }}
      data-testid="settings.account-panel"
    >
      {loadError !== null ? (
        <p
          role="alert"
          data-testid="settings.account-error"
          style={HELPER_STYLE}
        >
          {loadError}
        </p>
      ) : !loaded ? null : vaultId === null ? (
        // Still resolving which vault is open. Stating that is better than
        // rendering the standalone state, which would be a claim this panel
        // cannot back.
        <p data-testid="settings.account-unresolved" style={HELPER_STYLE}>
          {t("settings.account.unresolvedHelper")}
        </p>
      ) : !groupingKnown ? (
        <p data-testid="settings.account-standalone" style={HELPER_STYLE}>
          {t("settings.account.standaloneHelper")}
        </p>
      ) : (
        <SettingsSection title={t("settings.account.sections.grouping")}>
          <ControlBlock
            label={t("settings.account.nameLabel")}
            anchorId="account.name"
            testId="settings.account-name-row"
            helper={t("settings.account.nameHelper")}
            control={
              <>
                <div style={INPUT_ROW_STYLE}>
                  <Input
                    className="account-name-input"
                    data-testid="settings.account-name-input"
                    type="text"
                    value={draft}
                    maxLength={ACCOUNT_LABEL_MAX_LEN}
                    placeholder={t("settings.account.namePlaceholder")}
                    aria-label={t("settings.account.nameLabel")}
                    autoComplete="off"
                    autoCapitalize="off"
                    autoCorrect="off"
                    spellCheck={false}
                    disabled={saving}
                    onChange={(e) =>
                      setDraft(
                        truncateLabelToBytes(
                          e.target.value,
                          ACCOUNT_LABEL_MAX_LEN,
                        ),
                      )
                    }
                    onKeyDown={(e) => {
                      if (e.key === "Enter") {
                        e.preventDefault();
                        handleSave();
                      }
                    }}
                    style={{ flex: 1, minWidth: 0 }}
                  />
                  <Button
                    variant="primary"
                    data-testid="settings.account-name-save"
                    disabled={saveDisabled}
                    onClick={handleSave}
                  >
                    {saving
                      ? t("settings.account.nameSaving")
                      : t("settings.account.nameSave")}
                  </Button>
                </div>
                {saveError !== null && (
                  <p
                    role="alert"
                    data-testid="settings.account-name-error"
                    style={HELPER_STYLE}
                  >
                    {saveError}
                  </p>
                )}
              </>
            }
          />

          <SettingRow
            label={t("settings.account.vaultsLabel")}
            anchorId="account.vaults"
            testId="settings.account-vaults-row"
            helper={t("settings.account.vaultsHelper")}
            control={
              <span
                data-testid="settings.account-vaults-count"
                style={{ fontSize: "var(--text-sm)", color: "var(--ink-2)" }}
              >
                {t("settings.account.vaultsCount", {
                  count: account.vaults.length,
                })}
              </span>
            }
          >
            <ul
              data-testid="settings.account-vaults"
              style={{
                listStyle: "none",
                margin: 0,
                padding: 0,
                display: "flex",
                flexDirection: "column",
                gap: "var(--space-1)",
              }}
            >
              {account.vaults.map((id) => (
                <li
                  key={id}
                  data-testid="settings.account-vault-row"
                  data-current={id === vaultId ? "true" : "false"}
                  style={VAULT_ROW_STYLE}
                >
                  <span>
                    {vaultDisplayNameById(id, vaults, t) ??
                      t("settings.account.unknownVault")}
                  </span>
                  {id === vaultId && (
                    <span style={{ color: "var(--ink-3)" }}>
                      {t("settings.account.currentVault")}
                    </span>
                  )}
                </li>
              ))}
            </ul>
          </SettingRow>

          {/* Where the rest of the account actually lives. Devices and members
              are account-shaped but stay in Sync for now (see the file header);
              saying so is what stops this panel from reading as "the account is
              only a name". */}
          <p data-testid="settings.account-devices-note" style={HELPER_STYLE}>
            {t("settings.account.devicesNote")}
          </p>
        </SettingsSection>
      )}

      {/* Browser clipper: absent on web (MYND-574 task 27). A page cannot be a
          native-messaging host, so the extension talks to the desktop app or to
          nothing — there is no degraded mode to offer. Omitted rather than
          disabled: `decisions.md` 2026-07-26 makes that normative.

          These are the account's paired devices rather than the vault's: the
          pairing token is bound to the account, which is why they sit here and
          not under Sync. */}
      {capabilities.has("clipper") && (
        <SettingsSection title={t("settings.account.sections.extensions")}>
          <div data-testid="settings.account-extensions">
            <ConnectedExtensions />
          </div>
        </SettingsSection>
      )}
    </div>
    </SettingsSectionCounter>
  );
}
