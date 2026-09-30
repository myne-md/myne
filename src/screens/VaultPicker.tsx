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
// hex (`src/AGENTS.md` design-token discipline).

import {
  Fragment,
  useEffect,
  useReducer,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from "react";
import { useTranslation } from "react-i18next";
import { useRevealAfterIdleLock } from "../hooks/useRevealAfterIdleLock";
import type { TFunction } from "i18next";
import { Icon } from "../components/primitives/Icon";
import { fillingScrollRegionStyle, useScrollEdges } from "../hooks/useScrollEdges";
import { AuthHeading, AuthShell } from "./AuthShell";
import { HOVER_TRANSITION } from "../components/primitives/hoverSurface";
import { IconButton } from "../components/primitives/IconButton";
import { Spinner } from "../components/Spinner";
import { formatRelativeTime, useTick } from "../notes/components/relativeTime";
import {
  listVaults,
  orderByLastUnlock,
} from "../lib/vault-list";
import { vaultDisplayName } from "../lib/vaultDisplayName";
import {
  listAccounts,
  renameAccount,
  moveVault,
  splitVault,
  accountIdForVault,
  accountCommandErrorKind,
  groupVaultsByAccount,
  truncateLabelToBytes,
} from "../lib/account";
import type { AccountView, AccountCommandErrorKind } from "../lib/account";
import { isVaultUnlocked } from "../lib/vault-unlock";
import { ContextMenu, type ContextMenuItem } from "../notes/components/ContextMenu";
import type { VaultId } from "../lib/stage";
import type { VaultSummary } from "../types/vault-summary";
import { MyneMark } from "../components/primitives/MyneMark";

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
  | { kind: "loaded"; vaults: VaultSummary[]; accounts: AccountView[] }
  | { kind: "failed" };

type PickerAction =
  | { type: "loaded"; vaults: VaultSummary[]; accounts: AccountView[] }
  | { type: "failed" };

function reducer(state: PickerState, action: PickerAction): PickerState {
  switch (action.type) {
    case "loaded":
      return { kind: "loaded", vaults: action.vaults, accounts: action.accounts };
    case "failed":
      return { kind: "failed" };
    default:
      return state;
  }
}


/**
 * The account label for a group header, or `null` when the vaults in that group
 * are standalone (no account). An account with an empty label shows the neutral
 * "Account" fallback, exactly as a vault with no name shows "Vault N".
 */
function accountLabel(account: AccountView | null, t: TFunction): string {
  if (account === null) return "";
  return account.label === "" ? t("vaultPicker.accountFallback") : account.label;
}

/**
 * Grouping lives in `../lib/account` (`groupVaultsByAccount`, shared with the
 * recovery select and the mobile picker); this file keeps only the label.
 */

/**
 * User-facing copy for an account-grouping failure. The narrowed kinds get
 * their own sentence; everything else (Io, Backend, VaultNotFound, unknown)
 * shares the generic one, because the picker renders standalone either way.
 */
function accountErrorCopy(
  kind: AccountCommandErrorKind | null,
  t: TFunction,
): string {
  if (kind === "Hidden") return t("vaultPicker.accountHidden");
  if (kind === "LabelTooLong") return t("vaultPicker.labelTooLong");
  if (kind === "RecordUnreadable") return t("vaultPicker.accountUnreadable");
  return t("vaultPicker.accountError");
}

// ── Card chrome ──────────────────────────────────────────────────────────
// CenteredCard family (same envelope as the Unlock card) but pinned to the
// frame's 440px width + 24px section gap, so this is a local card rather
// than the shared <CenteredCard> (which is 480px / `--space-4` gap).

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

/**
 * A vault row. Hover rings it in the ACCENT (myne-md/myne#773) rather than
 * stepping the neutral border from `--line-1` to `--line-2`.
 *
 * The neutral step was a change nobody could see: two adjacent greys, on a
 * 60px row, behind a fill that was also changing. On this screen the row is
 * the only thing to press, and the accent is the app's one "this is the
 * live one" colour — so the row under the pointer should wear it, the same
 * way every other selectable thing in the app does.
 *
 * The border is a BORDER at both states rather than a box-shadow ring,
 * deliberately: a shadow ring would change the row's optical size on hover and
 * a 60px row in a scrolling list would appear to breathe as the pointer moved
 * down it. The colour changes; the geometry does not.
 */
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
    background: hovered ? "var(--accent-soft)" : "var(--paper)",
    border: `1px solid ${hovered ? "var(--accent)" : "var(--line-1)"}`,
    cursor: "pointer",
    textAlign: "start",
    fontFamily: "var(--font-sans)",
    transition: HOVER_TRANSITION,
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

// The account group header: a small, secondary-ink label above a group of
// vault rows. Standalone vaults (no account) render no header, so the header
// only ever names a real grouping.
const GROUP_HEADER_STYLE: CSSProperties = {
  flexShrink: 0,
  margin: 0,
  fontSize: "var(--text-sm)",
  lineHeight: "var(--leading-normal)",
  fontWeight: "var(--weight-medium)" as CSSProperties["fontWeight"],
  color: "var(--ink-3)",
  padding: "var(--space-2) var(--space-1) 0",
};

// Account-grouping failure banner: danger ink on the danger wash, so a
// grouping failure reads as an error and never as a second subline.
const ACCOUNTS_ERROR_STYLE: CSSProperties = {
  flexShrink: 0,
  margin: 0,
  fontSize: "var(--text-sm)",
  lineHeight: "var(--leading-normal)",
  color: "var(--danger)",
  background: "var(--danger-soft)",
  borderRadius: "var(--radius-2)",
  padding: "var(--space-2) var(--space-3)",
};

// Inline rename form: one row, input growing, two buttons. Tokens only.
const RENAME_FORM_STYLE: CSSProperties = {
  flexShrink: 0,
  margin: 0,
  display: "flex",
  gap: "var(--space-2)",
  alignItems: "center",
};

const RENAME_INPUT_STYLE: CSSProperties = {
  flexGrow: 1,
  minWidth: 0,
  fontSize: "var(--text-base)",
  lineHeight: "var(--leading-normal)",
  color: "var(--ink-1)",
  background: "var(--paper)",
  border: "1px solid var(--line-2)",
  borderRadius: "var(--radius-2)",
  padding: "var(--space-2) var(--space-3)",
};

const RENAME_SAVE_STYLE: CSSProperties = {
  flexShrink: 0,
  fontSize: "var(--text-sm)",
  fontWeight: "var(--weight-medium)" as CSSProperties["fontWeight"],
  color: "var(--paper)",
  background: "var(--accent)",
  border: "none",
  borderRadius: "var(--radius-2)",
  padding: "var(--space-2) var(--space-3)",
  cursor: "pointer",
};

const RENAME_CANCEL_STYLE: CSSProperties = {
  flexShrink: 0,
  fontSize: "var(--text-sm)",
  color: "var(--ink-2)",
  background: "transparent",
  border: "1px solid var(--line-2)",
  borderRadius: "var(--radius-2)",
  padding: "var(--space-2) var(--space-3)",
  cursor: "pointer",
};

const CHEVRON_STYLE: CSSProperties = {
  color: "var(--ink-3)",
  flexShrink: 0,
};

// ── Create-another affordance (divider + chip-less accent action) ─────────


/** Card chrome shared by every render state (loading / failed / loaded). */
/**
 * The picker's page (myne-md/myne#773). Deboxed: the wordmark and the three
 * actions are page chrome in the shell's top bar, and the middle holds the
 * heading and the vault list and nothing else.
 *
 * `actions` is optional because two of the three callers below are degenerate
 * states — loading, and "no vaults loaded" — and offering "create another"
 * beside a spinner would be offering a second thing to do before the first has
 * resolved. The empty state passes them, because there it is the ONLY thing to
 * do and a user with no vaults and no create button is stranded.
 */
function PickerCard({
  children,
  actions,
  subline,
}: {
  /** The body under the heading. Optional: the empty state is its heading and
   *  its subline and nothing else — a list of nothing is not a list. */
  children?: ReactNode;
  actions?: ReactNode;
  /** The line under "Choose a vault". Rendered INSIDE the heading group so it
   *  sits against the title it explains rather than a section-gap away from
   *  it — it was a sibling of the list, which put it as far from the heading
   *  as the whole list was from both. Three callers, three different lines:
   *  the roster's subline, the empty state's, and the loading state, which
   *  passes none because a spinner is not a description. */
  subline?: ReactNode;
}) {
  const { t } = useTranslation();
  return (
    <AuthShell
      testId="picker.root"
      // Leaving a vault for the list is going BACK, and the vault picker is
      // where a lock, an auto-lock and the unlock screen's back control all
      // arrive. The one route in that is not a step backwards — cold boot —
      // has nothing on screen before it to move away from.
      enter="back"
      actions={actions}
      // The mark sits centred above the question, as on Unlock and Welcome, so
      // the three screens a returning user meets share one shape.
      brand={false}
    >
      <div style={{ display: "flex", justifyContent: "center" }}>
        <MyneMark size={56} />
      </div>
      <AuthHeading centered title={t("vaultPicker.heading")}>
        {subline}
      </AuthHeading>
      {children}
    </AuthShell>
  );
}


/** The divider + picker actions — shared by loaded + failed. "Restore from
 *  backup" sits next to "Create another vault" (SYNC-5 KeepBoth door:
 *  restoring an additional vault must not require unlocking one first), and
 *  "Add this device to an account" beside both (myne#221: the join door has to
 *  be offered wherever creation is, or it is reachable on a fresh machine and
 *  nowhere else). */
/**
 * The three ways to get a vault onto this device, as top-right page chrome.
 *
 * They were a divider and three full-width accent links under the vault list,
 * which put three calls to action below the one list the screen exists to
 * present — and on a device with enough vaults to scroll, they sat below the
 * fold of the thing they were competing with. As icon buttons in the top bar
 * they are available without arguing with the list, which is the trade a
 * secondary action should make.
 *
 * Icon-only, so each carries its label as a tooltip AND as its accessible
 * name: `tooltip` on `<IconButton>` is the convention that keeps those two the
 * same string rather than two strings that drift.
 */
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
      <IconButton
        icon="plus"
        label={t("vaultPicker.createAnother")}
        tooltip
        onClick={onClick}
        testId="picker.create-cta"
      />
      <IconButton
        icon="link"
        label={t("vaultPicker.joinDevice")}
        tooltip
        onClick={onJoinDevice}
        testId="picker.join-cta"
      />
      <IconButton
        icon="download"
        label={t("vaultPicker.restoreFromBackup")}
        tooltip
        onClick={onRestoreBackup}
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
  onContextMenu,
  rowRef,
}: {
  vault: VaultSummary;
  label: string;
  meta: string;
  onSelect: (vaultId: VaultId) => void;
  onContextMenu: (vault: VaultSummary, pos: { x: number; y: number }) => void;
  rowRef: (vaultId: VaultId, el: HTMLButtonElement | null) => void;
}) {
  const [hovered, setHovered] = useState(false);
  const real = vault.label != null;
  return (
    <button
      type="button"
      ref={(el) => rowRef(vault.id, el)}
      onClick={() => onSelect(vault.id)}
      onContextMenu={(e) => {
        e.preventDefault();
        onContextMenu(vault, { x: e.clientX, y: e.clientY });
      }}
      onKeyDown={(e) => {
        // Keyboard path to the same menu: the ContextMenu key, or
        // Shift+F10, opens it anchored under the row. A control
        // reachable only by right-click strands keyboard users.
        if (e.key === "ContextMenu" || (e.shiftKey && e.key === "F10")) {
          e.preventDefault();
          const rect = e.currentTarget.getBoundingClientRect();
          onContextMenu(vault, { x: rect.left + 24, y: rect.bottom + 4 });
        }
      }}
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
  // The last account-grouping failure, shown as a banner. `null` is no error.
  // Grouping failures never strand the picker: the list renders standalone.
  const [accountsError, setAccountsError] = useState<string | null>(null);
  // Inline rename form state. `null` is no form; the menu closes when it opens.
  const [renaming, setRenaming] = useState<{ vault: VaultSummary; draft: string } | null>(null);
  // Whether some vault is unlocked. Account mutations (rename/move/split) are
  // refused while locked (backend `Locked`), so the menu offers them only
  // when unlocked; the locked picker stays a read surface.
  const [unlocked, setUnlocked] = useState(false);
  // Row buttons by vault id, so closing the menu can return focus to the row
  // that opened it (keyboard path).
  const rowRefs = useRef(new Map<VaultId, HTMLButtonElement>());
  // Soft top/bottom edges on the vault list once it outgrows the card.
  const { ref: listRef, fadeProps: listFade } = useScrollEdges<HTMLDivElement>();
  // Subscribe to the shared 30s tick so the row timestamps stay live.
  useTick();
  // The open row context menu (rename / move / split), or null when closed.
  const [menu, setMenu] = useState<{
    vault: VaultSummary;
    x: number;
    y: number;
  } | null>(null);

  // MYND-628 — re-show the window after an idle-lock hid it. This screen is a
  // locked boot surface exactly like `Unlock`, and at TWO OR MORE vaults it is
  // the one the post-lock reload actually lands on (`initialStageFromProbe`
  // routes ≥2 vaults to `picker`, SYNC-7a). Only `Unlock` carried the reveal,
  // so every multi-vault user lost the window on every idle auto-lock and had
  // to click the dock icon or relaunch to get it back.
  useRevealAfterIdleLock();

  const reload = () => {
    let cancelled = false;
    void (async () => {
      const vaultsPromise = listVaults();
      // A grouping failure is NOT a list failure. Only KeychainUnavailable
      // (no keychain, no record, no grouping by design) degrades silently to
      // standalone; every other failure surfaces the banner while the vaults
      // still render.
      const accountsPromise = listAccounts().then(
        (accounts) => ({ ok: true as const, accounts }),
        (error: unknown) => ({ ok: false as const, error }),
      );
      const [vaultsResult, accountsOutcome] = await Promise.all([
        vaultsPromise,
        accountsPromise,
      ]);
      if (cancelled) return;
      // A probe the host cannot answer (web, or a partial test mock) reads as
      // locked, which is the safe direction: the mutation menu stays hidden
      // rather than offering an action the backend will refuse.
      void isVaultUnlocked()
        .then((ok) => {
          if (!cancelled) setUnlocked(ok);
        })
        .catch(() => {});
      let accounts: AccountView[] = [];
      if (accountsOutcome.ok) {
        accounts = accountsOutcome.accounts;
        setAccountsError(null);
      } else if (
        accountCommandErrorKind(accountsOutcome.error) === "KeychainUnavailable"
      ) {
        setAccountsError(null);
      } else {
        setAccountsError(
          accountErrorCopy(
            accountCommandErrorKind(accountsOutcome.error),
            t,
          ),
        );
      }
      if ("ok" in vaultsResult) {
        dispatch({
          type: "loaded",
          vaults: orderByLastUnlock(vaultsResult.ok),
          accounts,
        });
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
  };

  useEffect(reload, []);

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
      <PickerCard
        subline={t("vaultPicker.noneLoaded")}
        actions={
          <CreateAnother
            onClick={onCreateAnother}
            onRestoreBackup={onRestoreBackup}
            onJoinDevice={onJoinDevice}
          />
        }
      />
    );
  }

  const groups = groupVaultsByAccount(state.vaults, state.accounts);

  // Run an account mutation, then reload truth. Failures surface the banner;
  // a failed write is never silent and never leaves stale grouping on screen.
  const runAccountAction = (fn: () => Promise<unknown>) => {
    setAccountsError(null);
    void (async () => {
      try {
        await fn();
      } catch (e) {
        setAccountsError(accountErrorCopy(accountCommandErrorKind(e), t));
      }
      reload();
    })();
  };

  const closeMenuAndRefocusRow = (vaultId: VaultId) => {
    setMenu(null);
    rowRefs.current.get(vaultId)?.focus();
  };

  // Account actions are offered only for member vaults. A standalone vault
  // (no account, keychain-less device, or hidden names) has no account to
  // rename or move from, and every command would answer VaultNotFound, so
  // offering them is offering a guaranteed failure.
  const menuAccountId =
    menu !== null && state.kind === "loaded"
      ? accountIdForVault(state.accounts, menu.vault.id)
      : null;
  const menuAccount =
    menuAccountId !== null && state.kind === "loaded"
      ? (state.accounts.find((a) => a.id === menuAccountId) ?? null)
      : null;
  const moveDestinations =
    state.kind === "loaded"
      ? state.accounts.filter(
          (a) => a.id !== menuAccountId && a.vaults.length > 0,
        )
      : [];
  const menuItems: ContextMenuItem[] =
    menu !== null && menuAccount !== null && unlocked
      ? [
          {
            id: "picker.account-rename",
            label: t("vaultPicker.renameAccount"),
            onSelect: () => {
              const vault = menu.vault;
              setMenu(null);
              setRenaming({ vault, draft: menuAccount.label });
              setAccountsError(null);
            },
          },
          {
            id: "picker.account-move-new",
            label: t("vaultPicker.moveToNewAccount"),
            onSelect: () => {
              const vault = menu.vault;
              setMenu(null);
              runAccountAction(() => splitVault(vault.id));
            },
          },
          // The destination is chosen from the other accounts, never typed:
          // the backend needs the TARGET VAULT id, and a typed label can
          // never be one. Each child anchors on its account's first member.
          ...(moveDestinations.length > 0
            ? [
                {
                  id: "picker.account-move",
                  label: t("vaultPicker.moveToAccount"),
                  children: moveDestinations.map((a, i) => ({
                    id: `picker.account-move-to-${i}`,
                    label: accountLabel(a, t),
                    onSelect: () => {
                      const vault = menu.vault;
                      setMenu(null);
                      runAccountAction(() => moveVault(vault.id, a.vaults[0] as VaultId));
                    },
                  })),
                  onSelect: () => {},
                } satisfies ContextMenuItem,
              ]
            : []),
        ]
      : [];

  const commitRename = (e?: { preventDefault: () => void }) => {
    e?.preventDefault();
    const target = renaming;
    if (target === null || target.draft.trim() === "") return;
    const label = target.draft.trim();
    setRenaming(null);
    runAccountAction(() => renameAccount(target.vault.id, label));
  };

  return (
    <PickerCard
      subline={t("vaultPicker.subline")}
      actions={
        <CreateAnother
          onClick={onCreateAnother}
          onRestoreBackup={onRestoreBackup}
          onJoinDevice={onJoinDevice}
        />
      }
    >
      {accountsError !== null && (
        <p
          role="alert"
          data-testid="picker.account-error"
          style={ACCOUNTS_ERROR_STYLE}
        >
          {accountsError}
        </p>
      )}
      {/* The fade is applied here rather than baked into LIST_STYLE because it
          is conditional on scroll position; see `useScrollEdges.ts` for why a
          fixed mask on both edges is wrong at rest. */}
      <div ref={listRef} style={LIST_STYLE} {...listFade}>
        {groups.map((group) => (
          <Fragment key={group.account?.id ?? "__standalone__"}>
            {group.account !== null && (
              <p style={GROUP_HEADER_STYLE} data-testid="picker.account-header">
                {accountLabel(group.account, t)}
              </p>
            )}
            {group.vaults.map((vault) => (
              <VaultRow
                key={vault.id}
                vault={vault}
                label={vaultDisplayName(vault, state.vaults, t)}
                meta={lastUnlockText(vault.last_unlock, t)}
                onSelect={onSelect}
                onContextMenu={(v, pos) => setMenu({ vault: v, x: pos.x, y: pos.y })}
                rowRef={(id, el) => {
                  if (el === null) rowRefs.current.delete(id);
                  else rowRefs.current.set(id, el);
                }}
              />
            ))}
          </Fragment>
        ))}
      </div>
      {renaming !== null && (
        <form onSubmit={commitRename} style={RENAME_FORM_STYLE}>
          <input
            // eslint-disable-next-line jsx-a11y/no-autofocus
            autoFocus
            value={renaming.draft}
            maxLength={512}
            placeholder={t("vaultPicker.renamePlaceholder")}
            aria-label={t("vaultPicker.renameAccount")}
            data-testid="picker.rename-input"
            style={RENAME_INPUT_STYLE}
            onChange={(e) =>
              setRenaming({
                vault: renaming.vault,
                // 512 UTF-8 bytes, the backend `ACCOUNT_LABEL_MAX_LEN`: a
                // multibyte draft can pass `maxLength` and still trip
                // `LabelTooLong`, so truncate here instead of failing there.
                draft: truncateLabelToBytes(e.target.value, 512),
              })
            }
            onKeyDown={(e) => {
              if (e.key === "Escape") {
                e.preventDefault();
                setRenaming(null);
              }
            }}
          />
          <button
            type="submit"
            disabled={renaming.draft.trim() === ""}
            data-testid="picker.rename-save"
            style={RENAME_SAVE_STYLE}
          >
            {t("vaultPicker.renameSave")}
          </button>
          <button
            type="button"
            data-testid="picker.rename-cancel"
            style={RENAME_CANCEL_STYLE}
            onClick={() => setRenaming(null)}
          >
            {t("vaultPicker.renameCancel")}
          </button>
        </form>
      )}
      {menu !== null && menuItems.length > 0 && (
        <ContextMenu
          x={menu.x}
          y={menu.y}
          items={menuItems}
          onClose={() => closeMenuAndRefocusRow(menu.vault.id)}
        />
      )}
    </PickerCard>
  );
}
