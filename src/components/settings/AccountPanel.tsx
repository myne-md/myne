// SPDX-License-Identifier: AGPL-3.0
// Settings → Account panel: the account-level surface, and ONLY that.
//
// ── What "account" means here ───────────────────────────────────────────────
// The account is the DEVICE-LOCAL grouping of vaults (myne-md/myne#684): the set
// of vaults this device treats as one identity. It is a per-device
// organisational choice, sealed in the device-local record, and it never syncs.
// It has no name of its own (`design-notes/ui/0728`): the heading a picker
// draws for a group is built from that group's own vault names, so this panel
// no longer offers a rename. The vault's OWN name (`vault.prefs.label`) is a
// different thing entirely: it lives inside the sealed container, it does sync,
// and it is in the Vault panel.
//
// ── Why this panel was rewritten rather than extended ───────────────────────
// Until the split this panel contained no account-level control at all: change
// password, vault label, vault icon and the danger zone all act on the sealed
// container, and the account the panel is named after appeared nowhere: a user
// could not even see which vaults share it anywhere after unlock. Those five
// vault controls moved to the Vault panel (`settings/VaultPanel.tsx`) and this
// panel kept the one thing that is genuinely account-scoped: the grouping.
//
// ── The roster, as of 2026-10-23 ─────────────────────────────────────────────
// The vault list was a naked `<ul>` of names under a paragraph of semantics, so
// the panel read as a read-out rather than as a surface: no glyph, no state and
// a count that said "1 vaults". It reuses the shape `ConnectedExtensions`
// established in the same panel (a glyph, a primary line, a secondary line) and
// moves the per-device semantics into the row's `explanation` disclosure.
//
// ── Why the roster offers no actions (myne-md/myne#937) ─────────────────────
// It carried the two grouping mutations the vault picker also performed
// (`account_split`, `account_move`, in the same `vaultPicker.*` vocabulary). Both
// are gone: splitting was the only code path that could ever create a second
// account, so on a product with no multi-account support the menu's only
// destination was a state nothing else in the app could reach, and the roster
// paid for it with a confirm step, a failure line and its own focus trap. A
// read-out is the honest shape for a grouping the user cannot rearrange.
//
// The person account NUMBER is the panel's FIRST block, where the account name
// used to be (`design-notes/ui/0728`). It is derived from the identity phrase,
// so it never needs saving, it is the one value support and a self-host operator
// ask for, and a value the picker and the identity home can show should not be
// buried under a roster on the surface named after the account.
//
// ── What is deliberately NOT here yet ───────────────────────────────────────
// Devices, the member roster and the person identity stay in the Sync panel.
// They are account-shaped, but they are wired into the sync status indicator,
// the enrollment gate, the beta-terms gate and the child-dialog gating that
// live there, and moving them is a change of its own rather than a paragraph of
// this one. The pointer under the account block is what keeps them findable in
// the meantime, and since 2026-10-23 it is a button that goes there rather than
// a sentence telling the user where to go.

import {
  useEffect,
  useRef,
  useState,
  type CSSProperties,
} from "react";
import { useTranslation } from "react-i18next";
import { IconButton } from "../primitives/IconButton";
import { Input } from "../primitives/Input";
import { VISUALLY_HIDDEN } from "../primitives/visuallyHidden";
import { SettingsSection, SettingsSectionCounter } from "./SettingsSection";
import { ControlBlock } from "./ControlBlock";
import { SettingRow } from "./SettingRow";
import { BLOCK_STYLE, HELPER_STYLE } from "./panel-styles";
import { accountIdForVault, listAccounts, type AccountView } from "../../lib/account";
import { listVaults, orderByLastUnlock } from "../../lib/vault-list";
import { vaultDisplayNameById } from "../../lib/vaultDisplayName";
import { formatPersonAccountNumber } from "@myne/client-core/person-account";
import { personAccountNumber } from "../../lib/personAccount";
import { copyText } from "../../lib/clipboard";
import { writeText as clipboardWriteText } from "../../platform/clipboardManager";
import { toast } from "../toast/toastStore";
import { FolderGlyph } from "../../notes/components/FolderGlyph";
import { FOLDER_ICON_PATHS } from "../../notes/folderIcons";
import { formatRelativeTime } from "../../notes/components/relativeTime";
import type { VaultSummary } from "../../types/vault-summary";

const INPUT_ROW_STYLE: CSSProperties = {
  display: "flex",
  flexDirection: "row",
  alignItems: "center",
  gap: "var(--space-2)",
  alignSelf: "stretch",
  marginTop: "var(--space-1)",
};

const ROW_STYLE: CSSProperties = {
  display: "flex",
  flexDirection: "row",
  alignItems: "center",
  gap: "var(--space-3)",
  padding: "var(--space-2) var(--space-3)",
  background: "var(--bg-1)",
  border: "1px solid var(--line-1)",
  borderRadius: "var(--radius-2)",
};

/** The glyph chip, at the vault switcher's size. A mini-helper rather than an
 *  import of that component's private one: the two surfaces draw the same mark
 *  (curated glyph, or the "M" wordmark) and neither owns the other. */
const GLYPH_STYLE: CSSProperties = {
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  flexShrink: 0,
  width: 24,
  height: 24,
  borderRadius: "var(--radius-1)",
  background: "var(--bg-3)",
  color: "var(--fg-2)",
  fontSize: "var(--text-xs)",
  fontWeight: "var(--weight-semibold)",
};

const ROW_TEXT_STYLE: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: "var(--space-1)",
  minWidth: 0,
  flex: 1,
};

const ROW_PRIMARY_STYLE: CSSProperties = {
  fontSize: "var(--text-sm)",
  fontWeight: "var(--weight-medium)",
  color: "var(--fg-1)",
  overflow: "hidden",
  textOverflow: "ellipsis",
  whiteSpace: "nowrap",
};

const ROW_SECONDARY_STYLE: CSSProperties = {
  fontSize: "var(--text-xs)",
  color: "var(--fg-3)",
};

const ROW_SECONDARY_DANGER_STYLE: CSSProperties = {
  ...ROW_SECONDARY_STYLE,
  color: "var(--danger)",
};

/**
 * One vault in the account's roster.
 *
 * A local component rather than an export: it exists for this roster alone, and
 * keeping it here means the file stays the unit a reader opens (and the story
 * and surface rosters stay honest about what is a shared component).
 *
 * A read-out since myne-md/myne#937: no menu, because there is no other account
 * to move a vault into and nothing here can split one out.
 */
function VaultRow({
  vault,
  name,
  isCurrent,
  secondary,
  secondaryDanger,
}: {
  vault: VaultSummary;
  name: string;
  isCurrent: boolean;
  secondary: string;
  secondaryDanger: boolean;
}) {
  const hasGlyph = vault.icon !== null && vault.icon in FOLDER_ICON_PATHS;

  return (
    <li
      data-testid="settings.account-vault-row"
      data-current={isCurrent ? "true" : "false"}
      style={ROW_STYLE}
    >
      <span style={GLYPH_STYLE} aria-hidden="true">
        {hasGlyph ? <FolderGlyph name={vault.icon as string} size={14} /> : "M"}
      </span>
      <span style={ROW_TEXT_STYLE}>
        <span style={ROW_PRIMARY_STYLE}>{name}</span>
        <span
          data-testid="settings.account-vault-state"
          style={secondaryDanger ? ROW_SECONDARY_DANGER_STYLE : ROW_SECONDARY_STYLE}
        >
          {secondary}
        </span>
      </span>
    </li>
  );
}

export interface AccountPanelProps {
  /**
   * The active vault's id, from `SettingsModal`. It is what resolves WHICH
   * account this panel is about (`accountIdForVault`), since the backend
   * addresses an account through one of its member vaults.
   *
   * `null` while a post-reload editor is still resolving it: the panel then
   * states that it does not know which vault it is looking at rather than
   * aiming a mutation at a guess.
   */
  vaultId: string | null;
}

/**
 * The account panel.
 *
 * It carried an `onOpenPanel("sync")` prop whose only job was a door the rail
 * already provides (2026-10-25, below). With the door gone the prop is gone too,
 * deliberately: a dead parameter is where a second copy of a removed control comes
 * back from.
 */
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
  // The person account number (2026-10-23). Derived from the identity phrase, so
  // it is read rather than stored, and `null` on a device with no identity.
  // `numberUnavailable` keeps a FAILED read apart from that "no identity" answer:
  // both used to end in the same silent absence.
  const [accountNumber, setAccountNumber] = useState<string | null>(null);
  const [numberUnavailable, setNumberUnavailable] = useState(false);

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
      // Bare number, formatted here: the canonical value never leaves the
      // client in display form, the same rule the identity home follows. The
      // `typeof` guard is not ceremony: a stub or a malformed answer must read
      // as "no number" rather than throw inside the panel's own effect (found
      // by the story tier, whose harness answers this binding with nothing).
      void personAccountNumber().then(
        (canonical) =>
          !cancelled &&
          setAccountNumber(
            typeof canonical === "string" && canonical.length > 0
              ? formatPersonAccountNumber(canonical)
              : null,
          ),
        () => {
          if (!cancelled) setNumberUnavailable(true);
        },
      );
      try {
        const list = await listAccounts();
        const vaultList = await vaultsPromise;
        if (cancelled) return;
        const id = vaultId === null ? null : accountIdForVault(list, vaultId);
        const found = id === null ? null : (list.find((a) => a.id === id) ?? null);
        setAccount(found);
        setVaults(orderByLastUnlock(vaultList));
      } catch (e) {
        if (cancelled) return;
        // A device with no keychain, or an unreadable record, cannot show the
        // grouping. Say so instead of rendering the standalone state, which
        // would claim the vault has no account when the truth is unknown.
        // One sentence covers every remaining kind, because the two that used to
        // get their own wording moved with the move/split commands
        // (myne-md/myne#937) and hide-vault-names answers an empty list.
        setLoadError(t("settings.account.groupingError"));
      } finally {
        if (!cancelled) setLoaded(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [vaultId]);

  // The number's copy confirms itself (2026-10-24): tick plus one pop on the
  // control, announced in the live region below; the toast is kept for the
  // FAILURE only.
  const [numberCopied, setNumberCopied] = useState(false);
  const numberCopyTimer = useRef<number | null>(null);
  useEffect(
    () => () => {
      if (numberCopyTimer.current !== null) window.clearTimeout(numberCopyTimer.current);
    },
    [],
  );
  const copyAccountNumber = () => {
    if (accountNumber === null) return;
    void copyText(clipboardWriteText, accountNumber, {
      onSuccess: {
        kind: "toast",
        run: () => {
          setNumberCopied(true);
          if (numberCopyTimer.current !== null) window.clearTimeout(numberCopyTimer.current);
          numberCopyTimer.current = window.setTimeout(() => {
            setNumberCopied(false);
            numberCopyTimer.current = null;
          }, 1600);
        },
      },
      onFailure: {
        kind: "toast",
        run: () =>
          toast({ message: t("settings.account.numberCopyFailed"), variant: "error" }),
      },
    });
  };

  const groupingKnown = account !== null;
  const secondaryFor = (vault: VaultSummary): { text: string; danger: boolean } => {
    if (vault.status.kind === "Corrupted") {
      return { text: t("settings.account.vaultCorrupted"), danger: true };
    }
    const parts: string[] = [];
    if (vault.id === vaultId) parts.push(t("settings.account.currentVault"));
    if (vault.last_unlock !== null) {
      const rel = formatRelativeTime(new Date(vault.last_unlock));
      if (rel !== "") parts.push(t("vaultPicker.openedRelative", { rel }));
    }
    if (!vault.published) parts.push(t("settings.account.vaultDeviceOnly"));
    return { text: parts.join(" · "), danger: false };
  };

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
          {/* The account number, first: derived from the identity phrase, so it
              cannot be lost and needs no saving, but it is the value support and
              a self-host operator ask for, and it now stands where the account
              name used to (`design-notes/ui/0728`).

              Rendered in EVERY grouping state, with an honest empty line when
              the device holds no identity: the settings search entry for it is
              not gated (the registry's only runtime axes are developer mode and
              member-vault), and a hit that lands on a row which does not exist
              degrades to a silent panel switch. `ControlBlock` rather than
              `SettingRow` because a 27-character monospace value is the
              "long value rendered inline" exception the row's own header names. */}
          <ControlBlock
            label={t("settings.account.numberLabel")}
            anchorId="account.number"
            testId="settings.account-number-row"
            helper={
              accountNumber !== null
                ? t("settings.account.numberHelper")
                : numberUnavailable
                  ? t("settings.account.numberUnavailable")
                  : t("settings.account.numberEmpty")
            }
            control={
              accountNumber !== null ? (
                <div style={INPUT_ROW_STYLE}>
                  <Input
                    readOnly
                    data-testid="settings.account-number"
                    aria-label={t("settings.account.numberLabel")}
                    value={accountNumber}
                    style={{
                      fontFamily: "var(--font-mono)",
                      fontSize: "var(--text-sm)",
                      color: "var(--fg-1)",
                      flex: 1,
                      minWidth: 0,
                      userSelect: "all",
                    }}
                  />
                  <IconButton
                    icon="copy"
                    label={t("settings.account.copyAccountNumber")}
                    bordered
                    tooltip
                    confirmed={numberCopied}
                    testId="settings.account-number-copy"
                    onClick={copyAccountNumber}
                  />
                  <p
                    role="status"
                    aria-live="polite"
                    data-testid="settings.account-number-copy-status"
                    style={VISUALLY_HIDDEN}
                  >
                    {numberCopied ? t("settings.account.numberCopied") : ""}
                  </p>
                </div>
              ) : (
                <p data-testid="settings.account-number-empty" style={HELPER_STYLE}>
                  {t("settings.account.numberEmpty")}
                </p>
              )
            }
          />

          {/* The roster. The count moved into the row's control slot and the
              paragraph of semantics moved into `explanation`, which `SettingRow`
              renders behind the `?` beside the label and associates with the row
              for assistive tech while collapsed (myne-md/myne#885). */}
          <SettingRow
            label={t("settings.account.vaultsLabel")}
            anchorId="account.vaults"
            testId="settings.account-vaults-row"
            helper={t("settings.account.vaultsHelperShort")}
            explanation={[t("settings.account.vaultsHelper")]}
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
                gap: "var(--space-2)",
              }}
            >
              {account.vaults.map((id) => {
                const summary = vaults.find((v) => v.id === id) ?? null;
                // A vault the list could not enumerate is NOT a vault with no
                // publish state: the panel would otherwise claim "Device only"
                // from no data (2026-10-23 review). It states the gap.
                const unreadable = summary === null;
                const vault: VaultSummary =
                  summary ??
                  ({
                    id,
                    status: { kind: "Exists" as const },
                    label: null,
                    icon: null,
                    last_unlock: null,
                    published: false,
                  } satisfies VaultSummary);
                const secondary = unreadable
                  ? { text: t("settings.account.vaultUnreadable"), danger: false }
                  : secondaryFor(vault);
                return (
                  <VaultRow
                    key={id}
                    vault={vault}
                    name={
                      vaultDisplayNameById(id, vaults, t) ??
                      t("settings.account.unknownVault")
                    }
                    isCurrent={id === vaultId}
                    secondary={secondary.text}
                    secondaryDanger={secondary.danger}
                  />
                );
              })}
            </ul>
          </SettingRow>

          {/* Where the rest of the account actually lives. One statement, no
              second control: the rail already holds the Sync panel, and a button
              that repeats a rail item is a third way to say one thing
              (2026-10-25 owner report; `decisions/ui/0725` item 5 said door
              INSTEAD of the sentence, and the shipped panel carried both). */}
          <div style={BLOCK_STYLE} data-testid="settings.account-devices-note">
            <p style={HELPER_STYLE}>{t("settings.account.devicesNote")}</p>
          </div>
        </SettingsSection>
      )}

      {/* The browser clipper used to live here, as an inline section: it is now
          its own rail panel (`BrowserExtensionsPanel`, myne-md/myne#960). Account
          answers "who am I on this device"; a pairing with a browser is software
          the user connects, so it stopped being a subsection of identity. */}
    </div>
    </SettingsSectionCounter>
  );
}
