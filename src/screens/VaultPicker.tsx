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
// affordance → `onCreateAnother()` (→ `picker.create-vault` → create-vault),
// and beside it "add this device to an account" → `onJoinDevice()` (myne#221),
// which opens the `JoinDeviceModal` App.tsx mounts globally.
//
// **Pre-unlock enumeration policy (SYNC-7 / SYNC-3).** Rows show the real
// label ONLY when `vault_list()` returns one; a vault it has no name for shows
// the neutral fallback "Vault N", whose N is now a stable per-vault number
// rather than the row's position (see `rowLabel`). Rows are ordered by
// last-unlock, most-recent first (SYNC-7); the only pre-unlock leak is vault
// count + last-unlock times.
//
// **What "returns one" means changed with myne-md/myne#411**, and the change
// is the point of this screen existing in its current form: `vault_list` now
// resolves a name from the per-session RAM cache OR from this device's sealed
// label store (`MYL1`), so a vault this device has unlocked before carries its
// real name on a cold boot with nothing unlocked. A vault this device has
// never unlocked has no sealed file and still falls back, structurally. The
// device-wide hide-vault-names option erases that store, at which point every
// row falls back again.
//
// **Visual canon (MYND-204 tasks 4–6).** Refined to the approved Penpot
// frame `screen------unlock--vault-picker` on page "4a - Onboarding &
// Auth": a 440px CenteredCard-family card on the `--paper` canvas, brand
// row + "Choose a vault" heading + subline, an 8px-gap vault list of
// 60px rows (label/timestamp column + chevron — the leading icon-chip + dot
// were removed), and a divider-separated, accent-tinted "Create another
// vault" + "Restore from backup" action pair. Fallback "Vault N" rows carry
// the SYNC-3 demotion through the label alone (italic + secondary ink); no
// real labels or content for never-unlocked vaults. Tokens only — no raw
// hex (`src/CLAUDE.md` design-token discipline).

import {
  useEffect,
  useReducer,
  useState,
  type CSSProperties,
  type ReactNode,
} from "react";
import { useTranslation } from "react-i18next";
import { useRevealAfterIdleLock } from "../hooks/useRevealAfterIdleLock";
import type { TFunction } from "i18next";
import { Icon } from "../components/primitives/Icon";
import { MyneMark } from "../components/primitives/MyneMark";
import { fillingScrollRegionStyle, useScrollEdges } from "../hooks/useScrollEdges";
import { stageRootStyle } from "../components/primitives/stageRoot";
import { Spinner } from "../components/Spinner";
import { formatRelativeTime, useTick } from "../notes/components/relativeTime";
import {
  listVaults,
  orderByLastUnlock,
  stableVaultNumber,
} from "../lib/vault-list";
import type { VaultId } from "../lib/stage";
import type { VaultSummary } from "../types/vault-summary";

interface VaultPickerProps {
  /** Row select → App dispatches `picker.select-vault{vaultId}` → unlock. */
  onSelect: (vaultId: VaultId) => void;
  /** "Restore from backup" → `picker.restore-backup` → restore flow (MYND-56). */
  onRestoreBackup: () => void;
  /** "Create another" → App dispatches `picker.create-vault` → create-vault. */
  onCreateAnother: () => void;
  /**
   * "Add this device to an account" → App opens the `JoinDeviceModal` it mounts
   * globally (myne#221). The picker previously offered creation only, and the
   * modal's sole host was the welcome screen — which boot routing produces only
   * at ZERO vaults, so joining an existing account became unreachable the
   * moment this screen could appear at all.
   */
  onJoinDevice: () => void;
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
 * (`label !== null`: cached from a this-session unlock, or read from this
 * device's sealed label store, myne-md/myne#411); otherwise the neutral
 * fallback "Vault N".
 *
 * **N is a stable per-vault number, not the row's position.** It used to be
 * `index + 1` over a list ordered by last unlock, so the name a user was asked
 * to remember moved every time they opened a vault: unlock Vault 3 and it
 * becomes Vault 1. `stableVaultNumber` derives it from the `VaultId` instead
 * (see its docstring for the rule and what it costs). The fallback still
 * surfaces no vault-identifying string, and the LIST keeps its last-unlock
 * ordering (SYNC-7). Only the number stopped following it.
 *
 * The fallback string is resolved through the caller's `t` so it stays
 * reactive.
 */
function rowLabel(
  vault: VaultSummary,
  vaults: readonly VaultSummary[],
  t: TFunction,
): string {
  return (
    vault.label ??
    t("vaultPicker.vaultFallback", { n: stableVaultNumber(vaults, vault.id) })
  );
}

// ── Card chrome ──────────────────────────────────────────────────────────
// CenteredCard family (same envelope as the Unlock card) but pinned to the
// frame's 440px width + 24px section gap, so this is a local card rather
// than the shared <CenteredCard> (which is 480px / `--space-4` gap).

// The stage envelope is shared; `stageRoot.ts` carries the 38px reasoning and
// the ancestor contract it replaces `100vh` with.
const ROOT_STYLE: CSSProperties = {
  ...stageRootStyle,
  background: "var(--paper)",
  fontFamily: "var(--font-sans)",
  padding: "var(--space-6)",
};

const CARD_STYLE: CSSProperties = {
  width: 440,
  maxWidth: "100%",
  // Never taller than the space it was given. Without this the card grows to fit
  // however many vaults exist and takes the overflow off-screen with it.
  maxHeight: "100%",
  minHeight: 0,
  background: "var(--paper-2)",
  border: "1px solid var(--line-1)",
  borderRadius: "var(--radius-2)",
  padding: "var(--space-6)",
  display: "flex",
  flexDirection: "column",
  gap: "var(--space-5)",
};

const BRAND_ROW_STYLE: CSSProperties = {
  // Fixed chrome: shrinks never, so the LIST absorbs the height pressure.
  flexShrink: 0,
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
  // Fixed chrome: shrinks never, so the LIST absorbs the height pressure.
  flexShrink: 0,
  margin: 0,
  fontSize: "var(--text-2xl)",
  lineHeight: "var(--leading-snug)",
  fontWeight: "var(--weight-semibold)" as CSSProperties["fontWeight"],
  color: "var(--ink-0)",
};

const SUBLINE_STYLE: CSSProperties = {
  // Fixed chrome: shrinks never, so the LIST absorbs the height pressure.
  flexShrink: 0,
  margin: 0,
  fontSize: "var(--text-base)",
  lineHeight: "var(--leading-normal)",
  fontWeight: "var(--weight-regular)" as CSSProperties["fontWeight"],
  color: "var(--ink-2)",
};

// ── Vault list + rows ────────────────────────────────────────────────────

// The ONLY scrolling region on this screen (myne-md/myne#565). The vault count is
// unbounded and this is a pre-unlock surface, so a card that outgrows the window
// is not a cosmetic overflow: it is a screen with no reachable "create another"
// and no reachable rows past the fold. Scrolling the LIST rather than the card
// keeps the brand row, the heading and the three actions on screen at any count.
//
// `minHeight: 0` is load-bearing: a flex item's default `min-height: auto`
// refuses to shrink below its content, which would leave `overflowY` with nothing
// to do and push the overflow back out to the card.
const LIST_STYLE: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: "var(--space-2)",
  ...fillingScrollRegionStyle,
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
    padding: "var(--space-3) var(--space-4)",
    borderRadius: "var(--radius-2)",
    background: hovered ? "var(--paper-3)" : "var(--paper)",
    border: `1px solid ${hovered ? "var(--line-2)" : "var(--line-1)"}`,
    cursor: "pointer",
    textAlign: "start",
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
  // Fixed chrome: shrinks never, so the LIST absorbs the height pressure.
  flexShrink: 0,
  height: 1,
  border: 0,
  margin: 0,
  background: "var(--line-1)",
};

const CREATE_LINK_STYLE: CSSProperties = {
  flexShrink: 0,
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
  const { t } = useTranslation();
  return (
    <div style={ROOT_STYLE} data-testid="picker.root">
      <div style={CARD_STYLE}>
        <div style={BRAND_ROW_STYLE}>
          <MyneMark size={36} />
          <span style={WORDMARK_STYLE}>Myne</span>
        </div>
        <h1 style={HEADING_STYLE}>{t("vaultPicker.heading")}</h1>
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
 *  restoring an additional vault must not require unlocking one first), and
 *  "Add this device to an account" beside both (myne#221: the join door has to
 *  be offered wherever creation is, or it is reachable on a fresh machine and
 *  nowhere else). */
function CreateAnother({
  onClick,
  onRestoreBackup,
  onJoinDevice,
}: {
  onClick: () => void;
  onRestoreBackup: () => void;
  onJoinDevice: () => void;
}) {
  const { t } = useTranslation();
  return (
    <>
      <hr style={DIVIDER_STYLE} />
      <PickerActionLink
        onClick={onClick}
        icon="plus"
        label={t("vaultPicker.createAnother")}
        testId="picker.create-cta"
      />
      <PickerActionLink
        onClick={onJoinDevice}
        icon="link"
        label={t("vaultPicker.joinDevice")}
        testId="picker.join-cta"
      />
      <PickerActionLink
        onClick={onRestoreBackup}
        icon="download"
        label={t("vaultPicker.restoreFromBackup")}
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
function lastUnlockText(lastUnlock: number | null, t: TFunction): string {
  if (lastUnlock == null) return "";
  const rel = formatRelativeTime(new Date(lastUnlock));
  return rel === "" ? "" : t("vaultPicker.openedRelative", { rel });
}

export function VaultPicker({ onSelect, onCreateAnother,
  onRestoreBackup, onJoinDevice }: VaultPickerProps) {
  const { t } = useTranslation();
  const [state, dispatch] = useReducer(reducer, { kind: "loading" });
  // Soft top/bottom edges on the vault list once it outgrows the card.
  const { ref: listRef, fadeProps: listFade } = useScrollEdges<HTMLDivElement>();
  // Subscribe to the shared 30s tick so the row timestamps stay live.
  useTick();

  // MYND-628 — re-show the window after an idle-lock hid it. This screen is a
  // locked boot surface exactly like `Unlock`, and at TWO OR MORE vaults it is
  // the one the post-lock reload actually lands on (`initialStageFromProbe`
  // routes ≥2 vaults to `picker`, SYNC-7a). Only `Unlock` carried the reveal,
  // so every multi-vault user lost the window on every idle auto-lock and had
  // to click the dock icon or relaunch to get it back.
  useRevealAfterIdleLock();

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
          <span style={SUBLINE_STYLE}>{t("vaultPicker.loading")}</span>
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
        <p style={SUBLINE_STYLE}>{t("vaultPicker.noneLoaded")}</p>
        <CreateAnother
          onClick={onCreateAnother}
          onRestoreBackup={onRestoreBackup}
          onJoinDevice={onJoinDevice}
        />
      </PickerCard>
    );
  }

  return (
    <PickerCard>
      <p style={SUBLINE_STYLE}>{t("vaultPicker.subline")}</p>
      {/* The fade is applied here rather than baked into LIST_STYLE because it
          is conditional on scroll position; see `useScrollEdges.ts` for why a
          fixed mask on both edges is wrong at rest. */}
      <div ref={listRef} style={LIST_STYLE} {...listFade}>
        {state.vaults.map((vault) => (
          <VaultRow
            key={vault.id}
            vault={vault}
            label={rowLabel(vault, state.vaults, t)}
            meta={lastUnlockText(vault.last_unlock, t)}
            onSelect={onSelect}
          />
        ))}
      </div>
      <CreateAnother
        onClick={onCreateAnother}
        onRestoreBackup={onRestoreBackup}
        onJoinDevice={onJoinDevice}
      />
    </PickerCard>
  );
}
