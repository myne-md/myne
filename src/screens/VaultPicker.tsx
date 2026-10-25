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
import type { InvitesUnavailable } from "../lib/personAccount";
import type { TFunction } from "i18next";
import { Icon } from "../components/primitives/Icon";
import { fillingScrollRegionStyle, useScrollEdges } from "../hooks/useScrollEdges";
import { AuthHeading, AuthShell } from "./AuthShell";
import { HOVER_TRANSITION } from "../components/primitives/hoverSurface";
import { NEUTRAL_PRESS_BG, usePressSurface } from "../components/primitives/pressSurface";
import { Button } from "../components/primitives/Button";
import { Spinner } from "../components/Spinner";
import { formatRelativeTime, useTick } from "../notes/components/relativeTime";
import {
  listVaults,
  orderByLastUnlock,
} from "../lib/vault-list";
import { vaultDisplayName, vaultDisplayNameById } from "../lib/vaultDisplayName";
import {
  listAccounts,
  moveVault,
  splitVault,
  accountHeading,
  accountIdForVault,
  accountCommandErrorKind,
  groupVaultsByAccount,
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
  /**
   * How many invitations addressed to this identity are still unaccepted
   * (myne-md/myne#911 follow-up). Zero renders nothing: an invitation that does
   * not exist is not a notification.
   *
   * It is a count rather than the list because the list lives in the dialog,
   * which owns the two wizards and their error states.
   *
   * `invitesUnavailable` is the other half, and it is what keeps the row on
   * screen when the count CANNOT be known: an invitation is addressed to a
   * registered person account, so an identity this device created but never
   * registered cannot list what was sent to it. Without this arm the invitee
   * waits forever with no surface saying why, which is the report this pair of
   * props exists to answer (myne-md/myne#911 follow-up).
   */
  inviteCount: number;
  invitesUnavailable?: InvitesUnavailable | null;
  /** Open the invitations dialog. */
  onInvites: () => void;
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
 * The heading for a group: the names of the vaults inside it, in the order the
 * list holds them (`docs/decisions/ui/0728` removed the user-set account name;
 * a group is identified by its own contents instead). The neutral "Account"
 * fallback survives for the one case that has nothing to name: every member
 * vault failed to enumerate.
 */
function accountLabel(
  account: AccountView | null,
  vaults: readonly VaultSummary[],
  t: TFunction,
): string {
  if (account === null) return "";
  return accountHeading(
    account,
    (id) => vaultDisplayNameById(id, vaults, t),
    t("vaultPicker.accountFallback"),
  );
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
/** One vault row's fixed height, shared by the row and the list's cap. */
const ROW_HEIGHT = 60;

/** Rows shown before the list scrolls. Past four the screen stops being a
 *  short choice and the actions row drifts toward the fold, so the list caps
 *  there and scrolls; a short window still shrinks it below the cap. */
export const VISIBLE_VAULT_ROWS = 4;

const LIST_STYLE: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: "var(--space-2)",
  ...fillingScrollRegionStyle,
  // `flex: 1 1 auto` from the filling style lets it grow to the content; the
  // cap is what stops a fifth row showing. Account group headers are not in
  // the arithmetic, so a grouped list shows slightly fewer than four rows,
  // which errs on the side of scrolling.
  maxHeight: `calc(${VISIBLE_VAULT_ROWS} * ${ROW_HEIGHT}px + ${VISIBLE_VAULT_ROWS - 1} * var(--space-2))`,
  // The scrollbar's own gutter, outside the rows. Padding on the scroll side
  // gives the bar a lane of its own, and the equal negative margin hands that
  // lane back to the page, so the rows keep the column's width (and line up
  // with the actions below) while the bar sits beside them, not over them.
  paddingInlineEnd: "var(--space-3)",
  marginInlineEnd: "calc(var(--space-3) * -1)",
  flexShrink: 1,
  flexGrow: 0,
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
function rowStyle(hovered: boolean, pressed: boolean): CSSProperties {
  return {
    display: "flex",
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    width: "100%",
    height: ROW_HEIGHT,
    boxSizing: "border-box",
    padding: "var(--space-3) var(--space-4)",
    borderRadius: "var(--radius-2)",
    // Press outranks hover: the row is by definition still hovered while it is
    // being pressed, and a press is the more specific fact.
    background: pressed
      ? NEUTRAL_PRESS_BG
      : hovered
        ? "var(--accent-soft)"
        : "var(--paper)",
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

// The row's caption line: the last-unlock time and, when the vault has never
// been published, the device-only marker. One line rather than two, because a
// row is 60px and a second caption would push the label out of its own rhythm.
const ROW_META_LINE_STYLE: CSSProperties = {
  ...ROW_META_STYLE,
  display: "flex",
  alignItems: "baseline",
  gap: "var(--space-2)",
  minWidth: 0,
};

// The account group header: a small, secondary-ink label above a group of
// vault rows. Standalone vaults (no account) render no header, so the header
// only ever names a real grouping.
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
      {actions != null && (
        <div
          data-testid="picker.actions"
          style={{
            // Three equal columns spanning the list's own width, so the row
            // reads as the list's footer rather than as loose links under it.
            display: "grid",
            gridTemplateColumns: "repeat(3, minmax(0, 1fr))",
            gap: "var(--space-2)",
            flexShrink: 0,
          }}
        >
          {actions}
        </div>
      )}
    </AuthShell>
  );
}


/** The divider + picker actions — shared by loaded + failed. "Restore from
 *  backup" sits next to "Create another vault" (SYNC-5 KeepBoth door:
 *  restoring an additional vault must not require unlocking one first), and
 *  "Add this device to an account" beside both (myne#221: the join door has to
 *  be offered wherever creation is, or it is reachable on a fresh machine and
 *  nowhere else). */
/** Each action fills its column, label centred and on one line. */
const ACTION_STYLE: CSSProperties = {
  width: "100%",
  justifyContent: "center",
  whiteSpace: "nowrap",
};

/**
 * The three ways to get a vault onto this device, as one row of labelled accent
 * buttons directly under the vault list, together as wide as a vault row.
 *
 * They were icon-only buttons in the shell's top-right corner for a round,
 * which kept them out of the list's way but made three unlabelled glyphs the
 * only door to creating, joining or restoring, far from the list they add to.
 * Under the list, labelled, and spanning its width, they read as the list's
 * footer: the ways to add to what is above them.
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
      <Button
        variant="primary"
        icon="plus"
        onClick={onClick}
        title={t("vaultPicker.createAnother")}
        data-testid="picker.create-cta"
        style={ACTION_STYLE}
      >
        {t("vaultPicker.createShort")}
      </Button>
      <Button
        variant="primary"
        icon="link"
        onClick={onJoinDevice}
        title={t("vaultPicker.joinDevice")}
        data-testid="picker.join-cta"
        style={ACTION_STYLE}
      >
        {t("vaultPicker.joinShort")}
      </Button>
      <Button
        variant="primary"
        icon="download"
        onClick={onRestoreBackup}
        title={t("vaultPicker.restoreFromBackup")}
        data-testid="picker.restore-cta"
        style={ACTION_STYLE}
      >
        {t("vaultPicker.restoreShort")}
      </Button>
    </>
  );
}

/**
 * The invitation notice, above the vault list (myne-md/myne#911 follow-up).
 *
 * Deliberately a row rather than a toast or a badge on a button that does not
 * exist yet: the picker is where a returning user lands, and an invitation is
 * not a transient event to be missed while the window was closed.
 *
 * Renders NOTHING at zero, which is what keeps an uninvited user's picker
 * exactly as it was before this feature.
 */
/**
 * The invitations row of the picker: a count when the list is readable, and the
 * reason plus the door when it is not.
 *
 * Both arms open the same dialog, and both are buttons: the second is not a
 * notification, it is the one surface that says "an invitation to this identity
 * cannot be listed until you register it". A `reserved` or `pending` identity is
 * a normal first-run state, not a fault, so the row states the wait rather than
 * an error.
 */
function InvitesNotice({
  count,
  unavailable,
  onOpen,
}: {
  count: number;
  unavailable?: InvitesUnavailable | null;
  onOpen: () => void;
}) {
  const { t } = useTranslation();
  const unreadable =
    unavailable === "not-enrolled" || unavailable === "pending" ? unavailable : null;
  if (count <= 0 && unreadable === null) return null;
  return (
    <Button
      variant="secondary"
      onClick={onOpen}
      data-testid="picker.invites-notice"
      data-invites={count > 0 ? "count" : unreadable}
      style={NOTICE_STYLE}
    >
      {count > 0
        ? t("invites.notice", { count })
        : t(
            unreadable === "pending"
              ? "invites.noticePending"
              : "invites.noticeUnregistered",
          )}
    </Button>
  );
}

const NOTICE_STYLE: CSSProperties = {
  width: "100%",
  justifyContent: "flex-start",
  marginBottom: "var(--space-2)",
};

/** A single vault row. Hover/focus lifts fill + stroke (no transform). */
function VaultRow({
  vault,
  label,
  meta,
  publishNote,
  onSelect,
  onContextMenu,
  rowRef,
}: {
  vault: VaultSummary;
  label: string;
  meta: string;
  /** "Device only" for a vault that exists nowhere but here; empty once
   *  published, because the normal state does not need a badge
   *  (myne-md/myne#911 task 8). */
  publishNote: string;
  onSelect: (vaultId: VaultId) => void;
  onContextMenu: (vault: VaultSummary, pos: { x: number; y: number }) => void;
  rowRef: (vaultId: VaultId, el: HTMLButtonElement | null) => void;
}) {
  const [hovered, setHovered] = useState(false);
  // The fill is computed from state, so the press fact is folded into it rather
  // than mutating the style: a DOM mutation would be erased by the next render.
  // `usePressSurface` carries the same value the class layer uses.
  const { pressed, handlers } = usePressSurface();
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
      {...handlers}
      data-testid="picker.vault-row"
      data-vault-id={vault.id}
      style={rowStyle(hovered, pressed)}
    >
      <span style={ROW_LEFT_STYLE}>
        <span style={LABEL_COL_STYLE}>
          <span style={rowLabelStyle(real)}>{label}</span>
          {(meta !== "" || publishNote !== "") && (
            <span style={ROW_META_LINE_STYLE}>
              {meta !== "" && <span>{meta}</span>}
              {publishNote !== "" && (
                <span data-testid="picker.vault-row-publish">{publishNote}</span>
              )}
            </span>
          )}
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
  onRestoreBackup, onJoinDevice, inviteCount, invitesUnavailable,
  onInvites }: VaultPickerProps) {
  const { t } = useTranslation();
  const [state, dispatch] = useReducer(reducer, { kind: "loading" });
  // The last account-grouping failure, shown as a banner. `null` is no error.
  // Grouping failures never strand the picker: the list renders standalone.
  const [accountsError, setAccountsError] = useState<string | null>(null);
  // Whether some vault is unlocked. Account mutations (move/split) are
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
  // The open row context menu (move / split), or null when closed.
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
      >
        <InvitesNotice
          count={inviteCount}
          unavailable={invitesUnavailable}
          onOpen={onInvites}
        />
      </PickerCard>
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
  // (no account, keychain-less device, or hidden names) has no account to move
  // from, and every command would answer VaultNotFound, so offering them is
  // offering a guaranteed failure.
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
  // The loaded list, for the display names a move destination's heading is
  // built from. Empty while loading, which is also when the menu offers nothing.
  const loadedVaults = state.kind === "loaded" ? state.vaults : [];
  const menuItems: ContextMenuItem[] =
    menu !== null && menuAccount !== null && unlocked
      ? [
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
          // the backend needs the TARGET VAULT id, and a name can never be one.
          // Each child names its account by that account's own vaults and
          // anchors on the first member.
          ...(moveDestinations.length > 0
            ? [
                {
                  id: "picker.account-move",
                  label: t("vaultPicker.moveToAccount"),
                  children: moveDestinations.map((a, i) => ({
                    id: `picker.account-move-to-${i}`,
                    label: accountLabel(a, loadedVaults, t),
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
      <InvitesNotice
          count={inviteCount}
          unavailable={invitesUnavailable}
          onOpen={onInvites}
        />
      {/* The fade is applied here rather than baked into LIST_STYLE because it
          is conditional on scroll position; see `useScrollEdges.ts` for why a
          fixed mask on both edges is wrong at rest. */}
      <div ref={listRef} style={LIST_STYLE} {...listFade}>
        {groups.map((group) => (
          <Fragment key={group.account?.id ?? "__standalone__"}>
            {group.vaults.map((vault) => (
              <VaultRow
                key={vault.id}
                vault={vault}
                label={vaultDisplayName(vault, state.vaults, t)}
                meta={lastUnlockText(vault.last_unlock, t)}
                publishNote={
                  vault.published ? "" : t("vaultPicker.deviceOnly")
                }
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
