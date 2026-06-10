// Vault picker screen — MYND-204 (multi-vault sub-feature 3).
//
// The ≥2-vault startup surface. Mounts when Stage = `picker` (produced
// ONLY by `initialStageFromProbe` boot routing — there is no `transition`
// arm that enters `picker`). It owns its own data: the vault list is
// fetched from `vault_list()` on mount, NOT carried on the Stage payload
// (`src/lib/stage.ts` — the `picker` variant is payload-free).
//
// Each row → `onSelect(vaultId)` (App.tsx dispatches
// `picker.select-vault{vaultId}` → unlock screen for that vault; the
// vaultId-targeted unlock IPC lives in task 7). A "create another"
// affordance → `onCreateAnother()` (→ `picker.create-vault` → create-vault).
//
// **Pre-unlock enumeration policy (SYNC-7 / SYNC-3).** Rows show the real
// label ONLY when `vault_list()` returns one (`label !== null`, cached from
// a this-session unlock); a never-unlocked-this-session vault shows the
// neutral fallback "Vault N". Rows are ordered by last-unlock, most-recent
// first (SYNC-7); the only pre-unlock leak is vault count + last-unlock
// times. No real labels or content for never-unlocked vaults.
//
// **Visual canon (MYND-204 tasks 4–6).** Refined to the approved Penpot
// frame `screen------unlock--vault-picker` on page "4a - Onboarding &
// Auth": a 440px CenteredCard-family card on the `--paper` canvas, brand
// row + "Choose a vault" heading + subline, an 8px-gap vault list of
// 60px rows (chip + decorative dot + label/timestamp column + chevron),
// and a divider-separated, chip-less, accent-tinted "Create another vault"
// action. Fallback "Vault N" rows render the label italic + demoted with a
// neutral-grey dot (SYNC-3); the real-label row carries a `--label-slate`
// dot. Tokens only — no raw hex (`src/CLAUDE.md` design-token discipline).

import {
  useEffect,
  useReducer,
  useState,
  type CSSProperties,
  type ReactNode,
} from "react";
import { Icon } from "../components/primitives/Icon";
import { MyneMark } from "../components/primitives/MyneMark";
import { Spinner } from "../components/Spinner";
import { formatRelativeTime, useTick } from "../notes/components/relativeTime";
import { listVaults, orderByLastUnlock } from "../lib/vault-list";
import type { VaultId } from "../lib/stage";
import type { VaultSummary } from "../types/vault-summary";

interface VaultPickerProps {
  /** Row select → App dispatches `picker.select-vault{vaultId}` → unlock. */
  onSelect: (vaultId: VaultId) => void;
  /** "Restore from backup" → `picker.restore-backup` → restore flow (MYND-56). */
  onRestoreBackup: () => void;
  /** "Create another" → App dispatches `picker.create-vault` → create-vault. */
  onCreateAnother: () => void;
}

// `loading` until the `vault_list()` IPC resolves; `loaded` carries the
// ordered rows; `failed` is the list-level IO failure surface (the picker
// is reached only at ≥2 vaults, so a transient list-read failure here is a
// soft "couldn't load" state with no actionable rows — distinct from the
// boot-probe IoError, which routes to the fail-closed unlock surface).
type PickerState =
  | { kind: "loading" }
  | { kind: "loaded"; vaults: VaultSummary[] }
  | { kind: "failed" };

type PickerAction =
  | { type: "loaded"; vaults: VaultSummary[] }
  | { type: "failed" };

function reducer(state: PickerState, action: PickerAction): PickerState {
  switch (action.type) {
    case "loaded":
      return { kind: "loaded", vaults: action.vaults };
    case "failed":
      return { kind: "failed" };
    default:
      return state;
  }
}

/**
 * Display name for a row. Real label when `vault_list()` returned one
 * (`label !== null`, cached from a this-session unlock, SYNC-3); otherwise
 * the neutral fallback "Vault N", N being the row's 1-based position in the
 * last-unlock-ordered list (SYNC-7). The position-based fallback avoids
 * surfacing any vault-identifying string for never-unlocked vaults.
 */
function rowLabel(vault: VaultSummary, index: number): string {
  return vault.label ?? `Vault ${index + 1}`;
}

// ── Card chrome ──────────────────────────────────────────────────────────
// CenteredCard family (same envelope as the Unlock card) but pinned to the
// frame's 440px width + 24px section gap, so this is a local card rather
// than the shared <CenteredCard> (which is 480px / `--space-4` gap).

const ROOT_STYLE: CSSProperties = {
  minHeight: "100vh",
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  background: "var(--paper)",
  fontFamily: "var(--font-sans)",
  padding: "var(--space-6)",
};

const CARD_STYLE: CSSProperties = {
  width: 440,
  maxWidth: "100%",
  background: "var(--paper-2)",
  border: "1px solid var(--line-1)",
  borderRadius: "var(--radius-2)",
  padding: "var(--space-6)",
  display: "flex",
  flexDirection: "column",
  gap: "var(--space-5)",
};

const BRAND_ROW_STYLE: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: "var(--space-3)",
};

const WORDMARK_STYLE: CSSProperties = {
  fontSize: "var(--text-xl)",
  fontWeight: "var(--weight-semibold)" as CSSProperties["fontWeight"],
  color: "var(--ink-0)",
};

const HEADING_STYLE: CSSProperties = {
  margin: 0,
  fontSize: "var(--text-2xl)",
  lineHeight: "var(--leading-snug)",
  fontWeight: "var(--weight-semibold)" as CSSProperties["fontWeight"],
  color: "var(--ink-0)",
};

const SUBLINE_STYLE: CSSProperties = {
  margin: 0,
  fontSize: "var(--text-base)",
  lineHeight: "var(--leading-normal)",
  fontWeight: "var(--weight-regular)" as CSSProperties["fontWeight"],
  color: "var(--ink-2)",
};

// ── Vault list + rows ────────────────────────────────────────────────────

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
    height: 60,
    boxSizing: "border-box",
    padding: "var(--space-3) var(--space-4) var(--space-3) 14px",
    borderRadius: "var(--radius-2)",
    background: hovered ? "var(--paper-3)" : "var(--paper)",
    border: `1px solid ${hovered ? "var(--line-2)" : "var(--line-1)"}`,
    cursor: "pointer",
    textAlign: "left",
    fontFamily: "var(--font-sans)",
  };
}

const ROW_LEFT_STYLE: CSSProperties = {
  display: "flex",
  flexDirection: "row",
  alignItems: "center",
  gap: "var(--space-3)",
  minWidth: 0,
};

const CHIP_STYLE: CSSProperties = {
  width: 36,
  height: 36,
  flexShrink: 0,
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  background: "var(--paper-2)",
  border: "1px solid var(--line-1)",
  borderRadius: "var(--radius-2)",
};

function dotStyle(real: boolean): CSSProperties {
  return {
    width: 10,
    height: 10,
    borderRadius: "var(--radius-pill)",
    // Real-label row's dot is the decorative iron blue-grey; a fallback
    // ("Vault N") row gets a neutral grey so it reads as demoted.
    background: real ? "var(--label-slate)" : "var(--line-2)",
  };
}

const LABEL_COL_STYLE: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: "var(--space-1)",
  minWidth: 0,
};

function rowLabelStyle(real: boolean): CSSProperties {
  return {
    fontSize: "var(--text-base)",
    fontWeight: "var(--weight-medium)" as CSSProperties["fontWeight"],
    // Real label reads as primary ink; the "Vault N" fallback is demoted
    // to italic + secondary ink (SYNC-3 — never as prominent as a name).
    color: real ? "var(--ink-1)" : "var(--ink-2)",
    fontStyle: real ? "normal" : "italic",
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
  };
}

const ROW_META_STYLE: CSSProperties = {
  fontSize: "var(--text-sm)",
  fontWeight: "var(--weight-regular)" as CSSProperties["fontWeight"],
  color: "var(--ink-3)",
};

const CHEVRON_STYLE: CSSProperties = {
  color: "var(--ink-3)",
  flexShrink: 0,
};

// ── Create-another affordance (divider + chip-less accent action) ─────────

const DIVIDER_STYLE: CSSProperties = {
  height: 1,
  border: 0,
  margin: 0,
  background: "var(--line-1)",
};

const CREATE_LINK_STYLE: CSSProperties = {
  display: "flex",
  flexDirection: "row",
  alignItems: "center",
  gap: "var(--space-2)",
  alignSelf: "flex-start",
  background: "transparent",
  border: 0,
  padding: "var(--space-2) var(--space-1)",
  borderRadius: "var(--radius-2)",
  fontFamily: "var(--font-sans)",
  fontSize: "var(--text-base)",
  fontWeight: "var(--weight-medium)" as CSSProperties["fontWeight"],
  color: "var(--accent)",
  cursor: "pointer",
};

/** Card chrome shared by every render state (loading / failed / loaded). */
function PickerCard({ children }: { children: ReactNode }) {
  return (
    <div style={ROOT_STYLE} data-testid="picker.root">
      <div style={CARD_STYLE}>
        <div style={BRAND_ROW_STYLE}>
          <MyneMark size={36} />
          <span style={WORDMARK_STYLE}>Myne</span>
        </div>
        <h1 style={HEADING_STYLE}>Choose a vault</h1>
        {children}
      </div>
    </div>
  );
}

/** One accent-tinted picker action link (create / restore share the style). */
function PickerActionLink({
  onClick,
  icon,
  label,
  testId,
}: {
  onClick: () => void;
  icon: Parameters<typeof Icon>[0]["name"];
  label: string;
  testId: string;
}) {
  const [hovered, setHovered] = useState(false);
  return (
    <button
      type="button"
      onClick={onClick}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      onFocus={() => setHovered(true)}
      onBlur={() => setHovered(false)}
      data-testid={testId}
      style={{
        ...CREATE_LINK_STYLE,
        background: hovered ? "var(--accent-soft)" : "transparent",
      }}
    >
      <Icon name={icon} size={16} />
      <span>{label}</span>
    </button>
  );
}

/** The divider + picker actions — shared by loaded + failed. "Restore from
 *  backup" sits next to "Create another vault" (SYNC-5 KeepBoth door:
 *  restoring an additional vault must not require unlocking one first). */
function CreateAnother({
  onClick,
  onRestoreBackup,
}: {
  onClick: () => void;
  onRestoreBackup: () => void;
}) {
  return (
    <>
      <hr style={DIVIDER_STYLE} />
      <PickerActionLink
        onClick={onClick}
        icon="plus"
        label="Create another vault"
        testId="picker.create-cta"
      />
      <PickerActionLink
        onClick={onRestoreBackup}
        icon="arrow-down"
        label="Restore from backup"
        testId="picker.restore-cta"
      />
    </>
  );
}

/** A single vault row. Hover/focus lifts fill + stroke (no transform). */
function VaultRow({
  vault,
  label,
  meta,
  onSelect,
}: {
  vault: VaultSummary;
  label: string;
  meta: string;
  onSelect: (vaultId: VaultId) => void;
}) {
  const [hovered, setHovered] = useState(false);
  const real = vault.label != null;
  return (
    <button
      type="button"
      onClick={() => onSelect(vault.id)}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      onFocus={() => setHovered(true)}
      onBlur={() => setHovered(false)}
      data-testid="picker.vault-row"
      data-vault-id={vault.id}
      style={rowStyle(hovered)}
    >
      <span style={ROW_LEFT_STYLE}>
        <span style={CHIP_STYLE}>
          <span style={dotStyle(real)} aria-hidden="true" />
        </span>
        <span style={LABEL_COL_STYLE}>
          <span style={rowLabelStyle(real)}>{label}</span>
          {meta !== "" && <span style={ROW_META_STYLE}>{meta}</span>}
        </span>
      </span>
      <Icon name="chevron-right" size={16} style={CHEVRON_STYLE} />
    </button>
  );
}

/**
 * Relative-time suffix for a row, e.g. "opened 2 hours ago". Reuses the
 * shared `formatRelativeTime` helper (sidebar/BottomBar) for one honest,
 * coarse format; a never-unlocked vault shows nothing here.
 */
function lastUnlockText(lastUnlock: number | null): string {
  if (lastUnlock == null) return "";
  const rel = formatRelativeTime(new Date(lastUnlock));
  return rel === "" ? "" : `opened ${rel}`;
}

export function VaultPicker({ onSelect, onCreateAnother,
  onRestoreBackup }: VaultPickerProps) {
  const [state, dispatch] = useReducer(reducer, { kind: "loading" });
  // Subscribe to the shared 30s tick so the row timestamps stay live.
  useTick();

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const result = await listVaults();
      if (cancelled) return;
      if ("ok" in result) {
        dispatch({ type: "loaded", vaults: orderByLastUnlock(result.ok) });
      } else {
        // List-level IO failure. The picker is reached only at ≥2 vaults
        // (the boot probe already saw them), so this is a transient
        // re-read failure — show a soft empty surface rather than a hard
        // fail-closed screen.
        dispatch({ type: "failed" });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  if (state.kind === "loading") {
    return (
      <PickerCard>
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: "var(--space-2)",
            color: "var(--ink-3)",
          }}
        >
          <Spinner size={14} style={{ borderWidth: 2 }} />
          <span style={SUBLINE_STYLE}>Loading your vaults…</span>
        </div>
      </PickerCard>
    );
  }

  if (state.kind === "failed" || state.vaults.length === 0) {
    // Defensive empty surface: the boot probe only routes here at ≥2
    // vaults, so an empty/failed list is an exotic transient state. Offer
    // the create path so the user is never stranded.
    return (
      <PickerCard>
        <p style={SUBLINE_STYLE}>No vaults could be loaded right now.</p>
        <CreateAnother onClick={onCreateAnother} onRestoreBackup={onRestoreBackup} />
      </PickerCard>
    );
  }

  return (
    <PickerCard>
      <p style={SUBLINE_STYLE}>
        You have more than one vault on this device. Pick one to unlock.
      </p>
      <div style={LIST_STYLE}>
        {state.vaults.map((vault, index) => (
          <VaultRow
            key={vault.id}
            vault={vault}
            label={rowLabel(vault, index)}
            meta={lastUnlockText(vault.last_unlock)}
            onSelect={onSelect}
          />
        ))}
      </div>
      <CreateAnother onClick={onCreateAnother} onRestoreBackup={onRestoreBackup} />
    </PickerCard>
  );
}
