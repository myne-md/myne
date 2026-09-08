import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import type { TFunction } from "i18next";
import { Screen, ScreenScroll, Title, FooterBar, Button, Banner, Spinner, MyneMark, Sheet, ListGroup, ListRow } from "../../components";
import { listVaults, orderByLastUnlock, stableVaultNumber } from "../../lib/vault-list";
import { listAccounts, renameAccount, moveVault, splitVault, accountIdForVault, accountCommandErrorKind, groupVaultsByAccount, truncateLabelToBytes } from "../../lib/account";
import type { AccountView, AccountCommandErrorKind } from "../../lib/account";
import { vaultDisplayLabel } from "../../lib/vault-label";
import { ioBanner } from "../../lib/io-banner";
import { HAS_TAURI } from "../../lib/app-window";
import { useHold } from "./editor/chrome/useHold";
import type { VaultSummary } from "../../types/vault-summary";
import type { PickerFlowProps } from "./types";

/**
 * MV-01 · Vault picker — wired. The ≥2-vault startup surface (Stage `picker`).
 * On mount it enumerates discovered vaults (`vault_list`), orders them by
 * last-unlock (SYNC-7), and renders one row per vault. Tapping a row routes to
 * that vault's unlock screen (`onSelect(id, fromPicker=true)`); the footer
 * carries the same pair of doors Welcome does — vault creation (`onCreate`) and
 * the sync-join flow (`onJoin`, myne-mobile#40). Carries no secret material —
 * the list is the DENY-list-clean `VaultSummary` projection only.
 *
 * The account/vault split (myne-md/myne#684) groups rows under the account
 * label; a long-press on a row opens a sheet with rename / move-to-new-account /
 * move-to-account. On Android the keychain has no backend, so `account_list`
 * answers empty and every vault shows standalone (no header, no error).
 */

/** Dot palette for labeled vaults (cycled by position); placeholder rows use a muted dot. */
const DOT_PALETTE = [
  "var(--label-slate)",
  "var(--label-moss)",
  "var(--label-clay)",
  "var(--label-ochre)",
  "var(--label-plum)",
  "var(--label-stone)",
];

/** Browser-dev (no Tauri host) demo data so the picker is navigable under `pnpm dev`.
 *  `icon` is always `null` here for the same reason it is on the real wire: this
 *  screen is PRE-unlock, so no vault has a decrypted glyph in the RAM icon cache
 *  (SYNC-3). The rows stay on the positional dot below — a vault-icon mark here
 *  would render as N identical wordmarks and read as a broken feature. */
const PLACEHOLDER_VAULTS: VaultSummary[] = [
  {
    id: "00000000-0000-7000-8000-000000000001",
    status: { kind: "Exists" },
    label: "Personal",
    icon: null,
    last_unlock: Date.now() - 2 * 60 * 1000,
  },
  {
    id: "00000000-0000-7000-8000-000000000002",
    status: { kind: "Exists" },
    label: "Work",
    icon: null,
    last_unlock: Date.now() - 26 * 60 * 60 * 1000,
  },
];

/** Relative "opened …" copy from an epoch-ms last-unlock (mirrors the MV-01 static copy). */
function openedWhen(ms: number | null, t: TFunction): string {
  if (ms === null) return t("picker.neverOpened");
  const sec = Math.max(0, Math.round((Date.now() - ms) / 1000));
  if (sec < 45) return t("picker.openedJustNow");
  const min = Math.round(sec / 60);
  if (min < 2) return t("picker.openedMinuteAgo");
  if (min < 60) return t("picker.openedMinutesAgo", { count: min });
  const hr = Math.round(min / 60);
  if (hr < 2) return t("picker.openedHourAgo");
  if (hr < 24) return t("picker.openedHoursAgo", { count: hr });
  const day = Math.round(hr / 24);
  if (day < 2) return t("picker.openedYesterday");
  if (day < 7) return t("picker.openedDaysAgo", { count: day });
  const wk = Math.round(day / 7);
  if (wk < 2) return t("picker.openedLastWeek");
  if (wk < 5) return t("picker.openedWeeksAgo", { count: wk });
  const mo = Math.round(day / 30);
  if (mo < 2) return t("picker.openedLastMonth");
  if (mo < 12) return t("picker.openedMonthsAgo", { count: mo });
  const yr = Math.round(day / 365);
  if (yr < 2) return t("picker.openedLastYear");
  return t("picker.openedYearsAgo", { count: yr });
}

/** Thin chevron-right (8×14, line-2 stroke) — the MV-01 row affordance. */
function RowChevron() {
  return (
    <svg width="8" height="13" viewBox="0 0 8 14">
      <path
        d="M1 1l6 6-6 6"
        stroke="var(--line-2)"
        strokeWidth="2"
        fill="none"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function VaultRow({
  dot,
  name,
  when,
  italic,
  corrupted,
  onClick,
  onHold,
}: {
  dot: string;
  name: string;
  when: string;
  italic: boolean;
  corrupted: boolean;
  onClick: () => void;
  onHold: () => void;
}) {
  const { t } = useTranslation();
  const { handlers, consumeHeldClick } = useHold(onHold);
  return (
    <button
      onClick={() => {
        if (consumeHeldClick()) return;
        onClick();
      }}
      {...handlers}
      style={{
        display: "flex",
        alignItems: "center",
        gap: 12,
        width: "100%",
        textAlign: "start",
        border: "1px solid var(--line-1)",
        borderRadius: 10,
        background: "var(--bg-1)",
        padding: "14px 14px",
        cursor: "pointer",
        fontFamily: "var(--font-sans)",
      }}
    >
      <span
        style={{
          flex: "none",
          width: 30,
          height: 30,
          borderRadius: 7,
          background: "var(--ink-1)",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
        }}
      >
        <svg width="18" height="18" viewBox="0 0 32 32" fill="none">
          <path d="M8 22 V10 L16 18 L24 10 V22" stroke="var(--paper)" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </span>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 7 }}>
          <span style={{ flex: "none", width: 8, height: 8, borderRadius: 2, background: dot }} />
          <span
            style={{
              fontSize: 16,
              fontWeight: 600,
              color: italic ? "var(--fg-3)" : "var(--fg-1)",
              fontStyle: italic ? "italic" : undefined,
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
            }}
          >
            {name}
          </span>
          {corrupted && (
            <span
              style={{
                flex: "none",
                borderRadius: 999,
                padding: "2px 8px",
                fontSize: 11,
                fontWeight: 600,
                letterSpacing: "0.02em",
                background: "var(--danger-soft)",
                color: "var(--danger)",
              }}
            >
              {t("picker.corruptedBadge")}
            </span>
          )}
        </div>
        <div style={{ marginTop: 2, fontSize: 13, color: "var(--fg-3)" }}>{when}</div>
      </div>
      <RowChevron />
    </button>
  );
}

export function PickerFlow({ onSelect, onCreate, onJoin }: PickerFlowProps) {
  const { t } = useTranslation();
  const [vaults, setVaults] = useState<VaultSummary[] | null>(null);
  const [accounts, setAccounts] = useState<AccountView[]>([]);
  const [ioError, setIoError] = useState<string | null>(null);
  const [accountsError, setAccountsError] = useState<string | null>(null);
  const [heldVault, setHeldVault] = useState<VaultSummary | null>(null);
  // Sheet mode: the action menu, the inline rename form, or the
  // destination-account list for a move. One sheet, three faces.
  const [sheetMode, setSheetMode] = useState<"menu" | "rename" | "move">("menu");
  const [renameDraft, setRenameDraft] = useState("");

  const accountErrorCopy = (kind: AccountCommandErrorKind | null): string => {
    if (kind === "Hidden") return t("picker.accountHidden");
    if (kind === "LabelTooLong") return t("picker.labelTooLong");
    if (kind === "RecordUnreadable") return t("picker.accountUnreadable");
    return t("picker.accountError");
  };

  const reload = () => {
    let cancelled = false;
    async function load() {
      if (!HAS_TAURI) {
        // Browser dev (no Tauri host) — show demo vaults so the picker is
        // navigable under `pnpm dev`. Real enumeration needs `pnpm tauri dev`.
        if (!cancelled) setVaults(orderByLastUnlock(PLACEHOLDER_VAULTS));
        return;
      }
      const result = await listVaults();
      // Grouping failure is not list failure: only KeychainUnavailable
      // degrades silently to standalone; the rest surfaces the banner.
      let accts: AccountView[] = [];
      try {
        accts = await listAccounts();
        if (!cancelled) setAccountsError(null);
      } catch (e) {
        if (cancelled) return;
        if (accountCommandErrorKind(e) === "KeychainUnavailable") {
          setAccountsError(null);
        } else {
          setAccountsError(accountErrorCopy(accountCommandErrorKind(e)));
        }
      }
      if (cancelled) return;
      if ("ok" in result) {
        setVaults(orderByLastUnlock(result.ok));
        setAccounts(accts);
      } else {
        setIoError(ioBanner(result.err.detail.io_error_kind));
        setVaults([]);
      }
    }
    void load();
    return () => {
      cancelled = true;
    };
  };

  useEffect(reload, []);

  const runAccountAction = (fn: () => Promise<unknown>) => {
    setAccountsError(null);
    setHeldVault(null);
    void (async () => {
      try {
        await fn();
      } catch (e) {
        setAccountsError(accountErrorCopy(accountCommandErrorKind(e)));
      }
      reload();
    })();
  };

  // Grouping lives in `../../lib/account` (`groupVaultsByAccount`, shared with
  // both desktop pickers); this file keeps only the label.
  const groupVaults = (): { account: AccountView | null; vaults: VaultSummary[] }[] => {
    if (vaults === null) return [];
    return groupVaultsByAccount(vaults, accounts);
  };

  const accountLabel = (account: AccountView | null): string => {
    if (account === null) return "";
    return account.label === "" ? t("picker.accountFallback") : account.label;
  };

  const holdActions = (vault: VaultSummary): void => {
    if (!HAS_TAURI) return;
    // Account actions are offered only for member vaults: a standalone
    // vault has no account to rename or move from, and every command would
    // answer VaultNotFound.
    if (accountIdForVault(accounts, vault.id) === null) return;
    setSheetMode("menu");
    setHeldVault(vault);
  };

  return (
    <Screen>
      <div style={{ flex: "none", padding: "80px 24px 0", display: "flex", alignItems: "center", gap: 10 }}>
        <MyneMark size={26} radius={6} />
        <span style={{ fontSize: 19, fontWeight: 600, letterSpacing: "-0.02em", color: "var(--fg-1)" }}>myne</span>
      </div>
      <div style={{ flex: "none", padding: "22px 24px 6px" }}>
        <Title style={{ fontSize: 27 }}>{t("vaultPicker.heading")}</Title>
      </div>

      <ScreenScroll style={{ padding: "10px 16px" }}>
        {vaults === null ? (
          <div style={{ display: "flex", justifyContent: "center", padding: "40px 0" }}>
            <Spinner />
          </div>
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            {ioError && <Banner kind="danger">{ioError}</Banner>}
            {accountsError && (
              <Banner kind="danger" testID="picker.account-error">
                {accountsError}
              </Banner>
            )}
            {groupVaults().map((group) => (
              <div key={group.account?.id ?? "__standalone__"} style={{ display: "flex", flexDirection: "column", gap: "var(--space-2)" }}>
                {group.account !== null && (
                  <div
                    data-testid="picker.account-header"
                    style={{ fontSize: "var(--text-sm)", fontWeight: "var(--weight-semibold)", color: "var(--fg-3)", padding: "var(--space-1) var(--space-1) 0" }}
                  >
                    {accountLabel(group.account)}
                  </div>
                )}
                {group.vaults.map((vault) => {
                  const corrupted = vault.status.kind === "Corrupted";
                  const labeled = vault.label !== null;
                  const n = stableVaultNumber(vaults, vault.id);
                  return (
                    <VaultRow
                      key={vault.id}
                      dot={labeled ? DOT_PALETTE[(n - 1) % DOT_PALETTE.length] : "var(--line-2)"}
                      name={vaultDisplayLabel(vault.label, n)}
                      when={openedWhen(vault.last_unlock, t)}
                      italic={!labeled}
                      corrupted={corrupted}
                      onClick={() => onSelect(vault.id, true)}
                      onHold={() => holdActions(vault)}
                    />
                  );
                })}
              </div>
            ))}
          </div>
        )}
      </ScreenScroll>

      {/* Both doors Welcome offers, not just one (myne-mobile#40): a device that
          already holds vaults never returns to Welcome, so a picker that only
          creates leaves "connect to my account" with no route at all. */}
      <FooterBar style={{ flexDirection: "column", padding: "14px 20px 44px" }}>
        <Button variant="secondary" style={{ height: 48, color: "var(--fg-1)" }} onClick={onCreate}>
          {t("vaultPicker.createAnother")}
        </Button>
        <Button variant="ghost" onClick={onJoin} data-testid="picker.join-account">
          {t("welcome.connect")}
        </Button>
      </FooterBar>

      {heldVault !== null && (
        <Sheet
          onClose={() => {
            setHeldVault(null);
            setSheetMode("menu");
          }}
        >
          {(() => {
            const heldAccountId = accountIdForVault(accounts, heldVault.id);
            const destinations = accounts.filter(
              (a) => a.id !== heldAccountId && a.vaults.length > 0,
            );
            if (sheetMode === "rename") {
              return (
                <ListGroup>
                  <ListRow
                    title={
                      <input
                        // eslint-disable-next-line jsx-a11y/no-autofocus
                        autoFocus
                        value={renameDraft}
                        maxLength={512}
                        placeholder={t("picker.renamePlaceholder")}
                        aria-label={t("picker.renameAccount")}
                        data-testid="picker.rename-input"
                        style={{
                          width: "100%",
                          fontSize: "var(--text-base)",
                          color: "var(--fg-1)",
                          background: "transparent",
                          border: "none",
                          outline: "none",
                        }}
                        onChange={(e) =>
                          setRenameDraft(truncateLabelToBytes(e.target.value, 512))
                        }
                        onKeyDown={(e) => {
                          if (e.key === "Escape") {
                            setHeldVault(null);
                            setSheetMode("menu");
                          }
                        }}
                      />
                    }
                    isLast={false}
                  />
                  <ListRow
                    title={t("picker.renameSave")}
                    isLast={false}
                    testID="picker.rename-save"
                    onClick={() => {
                      const vault = heldVault;
                      const label = renameDraft.trim();
                      if (label === "") return;
                      runAccountAction(() => renameAccount(vault.id, label));
                      setSheetMode("menu");
                    }}
                  />
                  <ListRow
                    title={t("picker.renameCancel")}
                    isLast
                    testID="picker.rename-cancel"
                    onClick={() => {
                      setHeldVault(null);
                      setSheetMode("menu");
                    }}
                  />
                </ListGroup>
              );
            }
            if (sheetMode === "move") {
              return (
                <ListGroup>
                  {destinations.map((a, i) => (
                    <ListRow
                      key={a.id}
                      title={accountLabel(a)}
                      isLast={i === destinations.length - 1}
                      testID={`picker.account-move-to-${a.id}`}
                      onClick={() => {
                        const vault = heldVault;
                        const anchor = a.vaults[0];
                        if (anchor === undefined) return;
                        runAccountAction(() => moveVault(vault.id, anchor));
                        setSheetMode("menu");
                      }}
                    />
                  ))}
                </ListGroup>
              );
            }
            return (
              <ListGroup>
                <ListRow
                  title={t("picker.renameAccount")}
                  isLast={false}
                  testID="picker.account-rename"
                  onClick={() => {
                    const current =
                      accounts.find((a) => a.id === heldAccountId)?.label ?? "";
                    setRenameDraft(current);
                    setSheetMode("rename");
                  }}
                />
                <ListRow
                  title={t("picker.moveToNewAccount")}
                  isLast={destinations.length === 0}
                  testID="picker.account-move-new"
                  onClick={() => {
                    const vault = heldVault;
                    runAccountAction(() => splitVault(vault.id));
                  }}
                />
                {destinations.length > 0 && (
                  <ListRow
                    title={t("picker.moveToAccount")}
                    isLast
                    testID="picker.account-move"
                    chevron
                    onClick={() => setSheetMode("move")}
                  />
                )}
              </ListGroup>
            );
          })()}
        </Sheet>
      )}
    </Screen>
  );
}
