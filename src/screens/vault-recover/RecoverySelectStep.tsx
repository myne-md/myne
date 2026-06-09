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
import { Button } from "../../components/primitives/Button";
import { Icon } from "../../components/primitives/Icon";
import { Input } from "../../components/primitives/Input";
import { Spinner } from "../../components/Spinner";
import { listVaults, orderByLastUnlock } from "../../lib/vault-list";
import { resolveVaultByAccountNumber } from "../../lib/vault-recover";
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
  | { kind: "loaded"; vaults: VaultSummary[] }
  | { kind: "failed" };

type ListAction =
  | { type: "loaded"; vaults: VaultSummary[] }
  | { type: "failed" };

function listReducer(state: ListState, action: ListAction): ListState {
  switch (action.type) {
    case "loaded":
      return { kind: "loaded", vaults: action.vaults };
    case "failed":
      return { kind: "failed" };
    default:
      return state;
  }
}

/** Display name for a row — real label when cached this session (SYNC-3),
 *  else the neutral "Vault N" fallback (N = 1-based last-unlock position). */
function rowLabel(vault: VaultSummary, index: number): string {
  return vault.label ?? `Vault ${index + 1}`;
}

function lastUnlockText(lastUnlock: number | null): string {
  if (lastUnlock == null) return "";
  const rel = formatRelativeTime(new Date(lastUnlock));
  return rel === "" ? "" : `opened ${rel}`;
}

// Single generic message for EVERY account-number failure — malformed input
// and valid-but-no-match are indistinguishable (`account-number.md` §5).
const ACCOUNT_NUMBER_INVALID = "Invalid account number. Please check and retry.";

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
    textAlign: "left",
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
    fontWeight: 500,
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
  const [list, dispatchList] = useReducer(listReducer, { kind: "loading" });
  const [accountNumber, setAccountNumber] = useState("");
  const [accountError, setAccountError] = useState<string | null>(null);
  const [resolving, setResolving] = useState(false);
  // Keep the row timestamps live (shared 30s tick).
  useTick();

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const result = await listVaults();
      if (cancelled) return;
      if ("ok" in result) {
        dispatchList({ type: "loaded", vaults: orderByLastUnlock(result.ok) });
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
          setAccountError(ACCOUNT_NUMBER_INVALID);
          return;
        }
        onVaultSelected(vaultId);
      } catch {
        // An unexpected IPC failure is also surfaced as the same generic
        // message — never leak which failure mode occurred.
        setAccountError(ACCOUNT_NUMBER_INVALID);
      } finally {
        setResolving(false);
      }
    })();
  };

  return (
    <StepShell
      title="Choose a vault to recover"
      body="Pick the vault you want to recover with your 24-word recovery phrase. You can also type your account number to jump straight to it."
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
          <span>Loading your vaults…</span>
        </div>
      )}

      {list.kind === "loaded" && (
        <div style={LIST_STYLE}>
          {list.vaults.map((vault, index) => (
            <VaultRow
              key={vault.id}
              vault={vault}
              label={rowLabel(vault, index)}
              meta={lastUnlockText(vault.last_unlock)}
              onSelect={() => onVaultSelected(vault.id)}
            />
          ))}
        </div>
      )}

      {list.kind === "failed" && (
        <p style={{ color: "var(--fg-3)", fontSize: "var(--text-base)" }}>
          No vaults could be loaded right now.
        </p>
      )}

      <div style={DIVIDER_ROW_STYLE}>
        <hr style={HR_STYLE} />
        <span>or</span>
        <hr style={HR_STYLE} />
      </div>

      <form style={ACCOUNT_FORM_STYLE} onSubmit={handleAccountSubmit}>
        <Input
          mono
          value={accountNumber}
          onChange={(e) => {
            setAccountNumber(e.target.value);
            if (accountError) setAccountError(null);
          }}
          placeholder="MY-XXXX-XXXX-XXXX-XXXX-X (optional)"
          aria-label="Account number (optional)"
          autoComplete="off"
          spellCheck={false}
          autoCapitalize="off"
          invalid={accountError != null}
        />
        {accountError != null && (
          <span role="alert" style={ERROR_STYLE}>
            {accountError}
          </span>
        )}
        <Button
          type="submit"
          variant="secondary"
          disabled={resolving || accountNumber.trim() === ""}
        >
          {resolving ? "Checking…" : "Use account number"}
        </Button>
      </form>

      <Button type="button" variant="ghost" onClick={onCancel}>
        Cancel
      </Button>
    </StepShell>
  );
}
