// Multi-vault recovery selection sub-step (MYND-206 — SYNC-12).
//
// Entered BEFORE phrase-entry when ≥2 vaults exist on disk. The user picks
// WHICH vault to recover via either:
//   - a vault picker (rows ordered by last-unlock, "Vault N" fallback for
//     never-this-session-unlocked vaults — the SAME pre-unlock enumeration
//     policy as the boot picker, SYNC-7 / SYNC-3; encrypted labels are not
//     shown pre-unlock, the account-number is never stored so it can't be
//     shown either), OR
//   - an OPTIONAL account-number affordance: typing the account-number resolves
//     it to a VaultId via `resolve_vault_by_account_number` (Task 1's
//     header-only `account_number_hash` match — no decrypt, no auth_permits).
//
// Both paths call `onVaultSelected(vaultId)`; the orchestrator dispatches
// `vault-selected` → `phrase-entry` against that vault. The account-number is
// NEVER required (story 6) — it is a jump-to-vault convenience; the 24-word
// phrase stays the sole recovery secret.
//
// **Non-distinguishing account-number result (`account-number.md` §5).** A
// malformed account-number and a valid-but-no-match both resolve to `null`
// from the backend; this component shows the SAME single generic
// "invalid account number" message either way — it cannot (and must not) tell
// the user a typo from a no-such-vault.
//
// With exactly 1 vault the recover screen SKIPS this sub-step entirely
// (single-vault parity, story 7) — this component is never mounted in that
// case (the orchestrator routes straight to phrase-entry with `vaultId = null`).

import {
  useEffect,
  useReducer,
  useState,
  type CSSProperties,
  type FormEvent,
} from "react";
import { useTranslation } from "react-i18next";
import i18n from "../../i18n";
import { Button } from "../../components/primitives/Button";
import { Icon } from "../../components/primitives/Icon";
import { Input } from "../../components/primitives/Input";
import { Spinner } from "../../components/Spinner";
import {
  listVaults,
  orderByLastUnlock,
  stableVaultNumber,
} from "../../lib/vault-list";
import { listAccounts, accountCommandErrorKind, groupVaultsByAccount } from "../../lib/account";
import type { AccountView } from "../../lib/account";
import { resolveVaultByAccountNumber } from "../../lib/vault-recover";
import { formatAccountNumberInput } from "../../lib/account-number-format";
import { formatRelativeTime, useTick } from "../../notes/components/relativeTime";
import type { VaultSummary } from "../../types/vault-summary";
import { StepShell } from "./step-shell";

interface RecoverySelectStepProps {
  /** Called with the chosen canonical `VaultId` string once the user picks a
   *  row OR a successful account-number match resolves. The orchestrator
   *  dispatches `vault-selected` → phrase-entry against that vault. */
  onVaultSelected: (vaultId: string) => void;
  /** Cancel out of the whole recovery flow (same `recover.cancel` route as the
   *  phrase-entry Cancel). */
  onCancel: () => void;
}

type ListState =
  | { kind: "loading" }
  | { kind: "loaded"; vaults: VaultSummary[]; accounts: AccountView[] }
  | { kind: "failed" };

type ListAction =
  | { type: "loaded"; vaults: VaultSummary[]; accounts: AccountView[] }
  | { type: "failed" };

function listReducer(state: ListState, action: ListAction): ListState {
  switch (action.type) {
    case "loaded":
      return { kind: "loaded", vaults: action.vaults, accounts: action.accounts };
    case "failed":
      return { kind: "failed" };
    default:
      return state;
  }
}

/** Display name for a row: the real label when `vault_list` has one (SYNC-3),
 *  else the neutral "Vault N" fallback. N is the vault's stable per-vault
 *  number and not its position in this list (myne-md/myne#411: a positional N
 *  renamed every vault whenever one was unlocked). Same helper as the picker
 *  and the switcher, so one vault reads the same on all three. */
function rowLabel(vault: VaultSummary, vaults: readonly VaultSummary[]): string {
  return (
    vault.label ??
    i18n.t("vaultRecover.select.vaultFallback", {
      index: stableVaultNumber(vaults, vault.id),
    })
  );
}

function lastUnlockText(lastUnlock: number | null): string {
  if (lastUnlock == null) return "";
  const rel = formatRelativeTime(new Date(lastUnlock));
  return rel === "" ? "" : i18n.t("vaultRecover.select.openedRelative", { rel });
}

/** Grouping lives in `../../lib/account` (`groupVaultsByAccount`, shared with
 *  the picker and the mobile flow); this file keeps only the label. */
function accountLabel(account: AccountView | null): string {
  if (account === null) return "";
  return account.label === "" ? i18n.t("vaultRecover.select.accountFallback") : account.label;
}

const LIST_STYLE: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: "var(--space-2)",
};

function rowStyle(hovered: boolean): CSSProperties {
  return {
    display: "flex",
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    width: "100%",
    height: 56,
    boxSizing: "border-box",
    padding: "var(--space-3) var(--space-4)",
    borderRadius: "var(--radius-2)",
    background: hovered ? "var(--bg-2)" : "var(--bg-1)",
    border: `1px solid ${hovered ? "var(--line-2)" : "var(--line-1)"}`,
    cursor: "pointer",
    textAlign: "start",
    fontFamily: "var(--font-sans)",
  };
}

const ROW_LABEL_COL_STYLE: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: "var(--space-1)",
  minWidth: 0,
};

function rowLabelStyle(real: boolean): CSSProperties {
  return {
    fontSize: "var(--text-base)",
    fontWeight: "var(--weight-medium)",
    color: real ? "var(--fg-1)" : "var(--fg-2)",
    fontStyle: real ? "normal" : "italic",
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
  };
}

const ROW_META_STYLE: CSSProperties = {
  fontSize: "var(--text-sm)",
  color: "var(--fg-3)",
};

const GROUP_HEADER_STYLE: CSSProperties = {
  margin: 0,
  fontSize: "var(--text-sm)",
  fontWeight: "var(--weight-medium)",
  color: "var(--fg-3)",
  padding: "var(--space-2) var(--space-1) 0",
};

const DIVIDER_ROW_STYLE: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: "var(--space-3)",
  color: "var(--fg-3)",
  fontSize: "var(--text-sm)",
};

const HR_STYLE: CSSProperties = {
  flex: 1,
  height: 1,
  border: 0,
  margin: 0,
  background: "var(--line-1)",
};

const ACCOUNT_FORM_STYLE: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: "var(--space-2)",
};

const ERROR_STYLE: CSSProperties = {
  fontSize: "var(--text-sm)",
  color: "var(--danger)",
};

function VaultRow({
  vault,
  label,
  meta,
  onSelect,
}: {
  vault: VaultSummary;
  label: string;
  meta: string;
  onSelect: () => void;
}) {
  const [hovered, setHovered] = useState(false);
  const real = vault.label != null;
  return (
    <button
      type="button"
      onClick={onSelect}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      onFocus={() => setHovered(true)}
      onBlur={() => setHovered(false)}
      data-testid="recover.select-row"
      data-vault-id={vault.id}
      style={rowStyle(hovered)}
    >
      <span style={ROW_LABEL_COL_STYLE}>
        <span style={rowLabelStyle(real)}>{label}</span>
        {meta !== "" && <span style={ROW_META_STYLE}>{meta}</span>}
      </span>
      <Icon name="chevron-right" size={16} style={{ color: "var(--fg-3)", flexShrink: 0 }} />
    </button>
  );
}

export function RecoverySelectStep({
  onVaultSelected,
  onCancel,
}: RecoverySelectStepProps) {
  const { t } = useTranslation();
  const [list, dispatchList] = useReducer(listReducer, { kind: "loading" });
  const [accountNumber, setAccountNumber] = useState("");
  const [accountError, setAccountError] = useState<string | null>(null);
  const [accountsError, setAccountsError] = useState<string | null>(null);
  const [resolving, setResolving] = useState(false);
  // Keep the row timestamps live (shared 30s tick).
  useTick();

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      // Grouping failure is not list failure, same contract as the picker:
      // only KeychainUnavailable degrades silently to standalone. Any other
      // grouping error renders the vaults ungrouped plus a banner: phrase
      // recovery must not fail over organisational chrome.
      let accounts: AccountView[];
      try {
        accounts = await listAccounts();
        if (!cancelled) setAccountsError(null);
      } catch (e) {
        if (cancelled) return;
        if (accountCommandErrorKind(e) === "KeychainUnavailable") {
          accounts = [];
          setAccountsError(null);
        } else {
          accounts = [];
          setAccountsError(t("vaultRecover.select.accountsError"));
        }
      }
      const result = await listVaults();
      if (cancelled) return;
      if ("ok" in result) {
        dispatchList({
          type: "loaded",
          vaults: orderByLastUnlock(result.ok),
          accounts,
        });
      } else {
        dispatchList({ type: "failed" });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const handleAccountSubmit = (e: FormEvent) => {
    e.preventDefault();
    if (resolving) return;
    const trimmed = accountNumber.trim();
    if (trimmed === "") return;
    setResolving(true);
    setAccountError(null);
    void (async () => {
      try {
        const vaultId = await resolveVaultByAccountNumber(trimmed);
        if (vaultId == null) {
          // Non-distinguishing: malformed OR no-match → one generic message.
          setAccountError(t("vaultRecover.select.accountInvalid"));
          return;
        }
        onVaultSelected(vaultId);
      } catch {
        // An unexpected IPC failure is also surfaced as the same generic
        // message — never leak which failure mode occurred.
        setAccountError(t("vaultRecover.select.accountInvalid"));
      } finally {
        setResolving(false);
      }
    })();
  };

  return (
    <StepShell
      title={t("vaultRecover.select.title")}
      body={t("vaultRecover.select.body")}
    >
      {list.kind === "loading" && (
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: "var(--space-2)",
            color: "var(--fg-3)",
          }}
        >
          <Spinner size={14} style={{ borderWidth: 2 }} />
          <span>{t("vaultRecover.select.loading")}</span>
        </div>
      )}

      {list.kind === "loaded" && (
        <div style={LIST_STYLE}>
          {groupVaultsByAccount(list.vaults, list.accounts).map((group) => (
            <div
              key={group.account?.id ?? "__standalone__"}
              style={{ display: "flex", flexDirection: "column", gap: "var(--space-2)" }}
            >
              {group.account !== null && (
                <p style={GROUP_HEADER_STYLE} data-testid="recover.select-account-header">
                  {accountLabel(group.account)}
                </p>
              )}
              {group.vaults.map((vault) => (
                <VaultRow
                  key={vault.id}
                  vault={vault}
                  label={rowLabel(vault, list.vaults)}
                  meta={lastUnlockText(vault.last_unlock)}
                  onSelect={() => onVaultSelected(vault.id)}
                />
              ))}
            </div>
          ))}
        </div>
      )}

      {list.kind === "failed" && (
        <p style={{ color: "var(--fg-3)", fontSize: "var(--text-base)" }}>
          {t("vaultRecover.select.loadFailed")}
        </p>
      )}

      {accountsError !== null && (
        <p
          role="alert"
          data-testid="recover.select-accounts-error"
          style={{ color: "var(--danger)", fontSize: "var(--text-sm)" }}
        >
          {accountsError}
        </p>
      )}

      <div style={DIVIDER_ROW_STYLE}>
        <hr style={HR_STYLE} />
        <span>{t("vaultRecover.select.or")}</span>
        <hr style={HR_STYLE} />
      </div>

      <form style={ACCOUNT_FORM_STYLE} onSubmit={handleAccountSubmit}>
        <Input
          mono
          value={accountNumber}
          onChange={(e) => {
            setAccountNumber(formatAccountNumberInput(e.target.value));
            if (accountError) setAccountError(null);
          }}
          placeholder={t("vaultRecover.select.accountPlaceholder")}
          aria-label={t("vaultRecover.select.accountLabel")}
          autoComplete="off"
          spellCheck={false}
          autoCapitalize="off"
          invalid={accountError != null}
          data-testid="recover.select-account-input"
        />
        {accountError != null && (
          <span role="alert" style={ERROR_STYLE} data-testid="recover.select-account-error">
            {accountError}
          </span>
        )}
        <Button
          type="submit"
          variant="secondary"
          disabled={resolving || accountNumber.trim() === ""}
          data-testid="recover.select-account-submit"
        >
          {resolving
            ? t("vaultRecover.select.checking")
            : t("vaultRecover.select.useAccountNumber")}
        </Button>
      </form>

      <Button
        type="button"
        variant="ghost"
        onClick={onCancel}
        data-testid="recover.select-cancel"
      >
        {t("vaultRecover.select.cancel")}
      </Button>
    </StepShell>
  );
}
