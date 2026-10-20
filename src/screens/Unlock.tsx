// Vault unlock screen — task 7 of `app-state-machine`, extended with
// recovery-flow entry affordances per `recovery-from-phrase-ui` Task 8
// and the MYND-108-bis lost-credentials cul-de-sac escape.
//
// Mounts when Stage = `unlock`. Two rendering modes driven by
// `initialStatus`:
//   - `Exists`               → normal mode: password form
//   - `Corrupted` / `IoError` → corrupted mode: <FailClosedError />
//
// Normal-mode reducer state machine: `idle` (with optional banner from
// the prior failed attempt — password retained across the
// decrypting → idle bounce) | `decrypting` (input + submit disabled) |
// `recovery-in-progress` (Rust slot is `Recovering`; password form is
// suppressed in favor of an info banner + "Continue" resume CTA;
// CTA dispatches `unlock.resume-recovery` to App.tsx, routing the
// user into recover(password-reset)) | `delete-vault` (MYND-108-bis:
// user clicked the tertiary "Lost both password and recovery phrase?
// Delete vault and start over" link; the password form is replaced
// by `<DeleteVaultConfirmForm>` for the typed-DELETE gate).
//
// `InvalidVaultMeta` mid-attempt switches the component into the same
// fail-closed surface as a boot-time corrupted vault — one-way, no
// return to the form within the session.
//
// **One credential at a time (MYND-558).** Orthogonal to the reducer
// above, `idle`/`decrypting` render exactly one credential surface,
// picked by the derived `surface` union: `"pending"` while the
// `quick_unlock_status` probe is in flight (NEITHER field is rendered —
// the probe is a local IPC that settles in milliseconds, and showing the
// password form first would flash exactly the double-prompt this fixes);
// `"quick"` when quick-unlock is redeemable and the user has not opted
// out, which gives the PIN / Touch ID surface the screen; `"password"`
// otherwise, unchanged from before. `passwordRevealed` is the user's own
// override — the "Use password instead" link swaps a redeemable
// quick-unlock for the password form, and a matching "Unlock with PIN
// instead" link swaps back, so neither side is a cul-de-sac.
//
// This screen owns the probe rather than `<QuickUnlockEntry>`, because
// the answer decides the layout: a child that probed for itself would
// have to report upward and would re-probe (rendering an empty card in
// the gap) every time the user toggled back to it. The child's one
// upward signal is `onUnavailable` — the credential just proved dead
// mid-session (attempts exhausted), which drops to the password form
// permanently, with no way back.
//
// **Cold-start recovery link.** In `idle` mode (Exists), a ghost-style
// "Forgot your password? Unlock with recovery phrase" link below the
// primary CTA dispatches `unlock.start-recovery` → App routes Stage
// to `recover(phrase-entry)`. The link is suppressed during
// `decrypting`, `recovery-in-progress`, fail-closed, and delete-vault
// states.
//
// **Lost-credentials delete link (MYND-108-bis).** Below the recovery
// link, a danger-tinted "Lost both password and recovery phrase?
// Delete vault and start over" link switches the component to the
// `delete-vault` sub-view. On Submit the IPC accepts via
// `Slot::Empty + vault.meta-exists` (backend `delete_vault_files_no_zeroize`
// no-keys arm); on Ok or PartialDelete-Continue the parent reprobes and
// boot routing picks the return surface by remaining vault count.
// See `decisions.md` 2026-05-26 entry "MYND-108-bis vault_delete
// extended to accept Slot::Empty + vault.meta-exists".

import { invoke } from "../platform/core";
import {
  useEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
  type CSSProperties,
  type FormEvent,
} from "react";
import { useTranslation } from "react-i18next";
import { useRevealAfterIdleLock } from "../hooks/useRevealAfterIdleLock";
import i18n from "../i18n";
import { DestructiveBanner } from "../components/DestructiveBanner";
import { DeleteVaultConfirmForm } from "../components/DeleteVaultConfirmForm";
import { FailClosedError } from "../components/FailClosedError";
import { QuickUnlockEntry } from "../components/QuickUnlockEntry";
import {
  CARD_BODY_STYLE,
  CARD_TITLE_STYLE,
  CenteredCard,
  ctaInteraction,
  ctaStyle,
} from "../components/primitives/CenteredCard";
import { AuthHeading, AuthShell } from "./AuthShell";
import { MyneMark } from "../components/primitives/MyneMark";
import { Button } from "../components/primitives/Button";
import { Icon } from "../components/primitives/Icon";
import { CredentialField } from "../components/primitives/CredentialField";
import { MemberVaultUnlockCard } from "../components/sync/MemberVaultUnlockCard";
import { SuspicionBanner } from "../components/SuspicionBanner";
import { failClosedExit, FAIL_CLOSED_EXIT_LABEL_KEY } from "../platform/app-exit";
import { ioBanner } from "../lib/io-banner";
import { quickUnlockStatus, type QuickUnlockMethod } from "../lib/quick-unlock";
import { listVaults, soleVaultId } from "../lib/vault-list";
import { vaultDisplayNameById } from "../lib/vaultDisplayName";
import type { VaultSummary } from "../types/vault-summary";
import { memberVaultStatus } from "../lib/personAccount";
import { UNLOCK_NON_DISTINGUISHING_BANNER } from "../lib/load-bearing-copy";
import type { StageVaultStatus, SuspicionReason, VaultId } from "../lib/stage";
import { failClosedCode } from "../lib/global-failure";
import {
  deleteVault,
  mapDeleteVaultError,
  vaultDirDisplayPath,
  type DeleteVaultPartialFailContext,
  type VaultDeleteError,
} from "../lib/vault-delete";
import type { VaultUnlockError } from "../types/vault-unlock-error";

interface UnlockProps {
  initialStatus: StageVaultStatus;
  /**
   * Optional vault-targeting id (MYND-204, multi-vault sub-feature 3, task 8).
   * Carried on the `unlock` Stage when the screen was reached by an explicit
   * vault choice (`picker.select-vault`, or the single-vault boot arm). Threaded
   * into the vault-addressed `unlock` IPC (SYNC-6): `Some(id)` opens exactly
   * `vaults/<id>/vault.meta`; `undefined` falls through to the param-less /
   * `None` sole-vault unlock (unchanged single-vault behavior). The backend
   * evicts any prior `Unlocked` vault on a switch (SYNC-1 lock-then-unlock), so
   * picking a vault opens THAT vault with no other vault concurrently unlocked.
   */
  vaultId?: VaultId;
  onUnlocked: () => void;
  /**
   * Back-to-picker affordance. App.tsx always wires this (the
   * `unlock.back-to-picker` transition is unconditional); the link itself
   * renders in idle mode only when ≥2 vaults exist (probed here), so it also
   * reaches the vault selector after a MANUAL lock or auto-lock — not just a
   * picker-reached unlock. Dispatches `unlock.back-to-picker` → `picker`.
   */
  onBack?: () => void;
  /** Cold-start recovery entry. Dispatched by the "Recovery phrase ile
   *  aç" link in idle mode. App.tsx sends `unlock.start-recovery` →
   *  Stage transitions to `recover(phrase-entry)`. */
  onStartRecovery: () => void;
  /** Resume recovery entry. Dispatched by the "Continue" CTA on the
   *  `VaultRecoveryInProgress` info banner. App.tsx sends
   *  `unlock.resume-recovery` → Stage transitions to
   *  `recover(password-reset)`. */
  onResumeRecovery: () => void;
  /**
   * Fired on `vault_delete` IPC Ok from the `delete-vault` sub-view
   * (MYND-108-bis lost-credentials cul-de-sac escape) OR on the user's
   * Continue click after a PartialDelete/Io banner. App.tsx reprobes;
   * boot routing picks the return surface by remaining vault count
   * (picker at ≥2, unlock at 1, welcome at 0). Backend accepts via
   * `Slot::Empty + vault.meta-exists` no-keys arm per `decisions.md`
   * 2026-05-26 entry "MYND-108-bis vault_delete extended to accept
   * Slot::Empty + vault.meta-exists".
   */
  onDeleteVaultSuccess: () => void;
  /** Corrupted-state repair door → `unlock.restore-backup` (MYND-56). */
  onRestoreBackup: () => void;
  /**
   * Optional one-shot signal carried via `Stage.unlock.suspicionReason`
   * — set only by the change-password modal's force-relock callback
   * (Task 13's plumbing). Renders `<SuspicionBanner>` above the
   * password form. Two values: `"vault-meta-changed-externally"` (red
   * severity, CAS mismatch) and `"vault-locked-during-change"`
   * (informational gray, user-initiated lock during Argon2id). The
   * banner has no dismiss affordance — it informs, doesn't gate.
   * App.tsx implicitly clears the field on stage exit (next mount of
   * Unlock from boot probe or from a different transition won't carry
   * it). See `decisions.md` 2026-05-08 "`Stage.unlock.suspicionReason?`"
   * entry.
   */
  suspicionReason?: SuspicionReason;
}

type UnlockState =
  | { kind: "idle"; password: string; error: string | null }
  | { kind: "decrypting"; password: string }
  | { kind: "corrupted-after-unlock" }
  | { kind: "recovery-in-progress" }
  | {
      kind: "delete-vault";
      inFlight: boolean;
      partialFail: DeleteVaultPartialFailContext | null;
    };

type UnlockAction =
  | { type: "set-password"; value: string }
  | { type: "submit" }
  | { type: "fail"; error: string }
  | { type: "fail-corrupted" }
  | { type: "fail-recovery-in-progress" }
  | { type: "success" }
  | { type: "request-delete-vault" }
  | { type: "cancel-delete-vault" }
  | { type: "delete-vault-in-flight" }
  | { type: "delete-vault-partial-fail"; context: DeleteVaultPartialFailContext }
  | { type: "delete-vault-bug-canary" };

function reducer(state: UnlockState, action: UnlockAction): UnlockState {
  switch (action.type) {
    case "set-password":
      if (state.kind !== "idle") return state;
      return { ...state, password: action.value, error: null };
    case "submit":
      if (state.kind !== "idle" || state.password.length === 0) return state;
      return { kind: "decrypting", password: state.password };
    case "fail":
      if (state.kind !== "decrypting") return state;
      return { kind: "idle", password: state.password, error: action.error };
    case "fail-corrupted":
      return { kind: "corrupted-after-unlock" };
    case "fail-recovery-in-progress":
      // Slot was `Recovering` at unlock-attempt time. Switch the
      // component to a banner + "Continue" surface; the password form
      // is suppressed (typing a password while the slot is recovering
      // is meaningless — the user must complete A8f first).
      return { kind: "recovery-in-progress" };
    case "success":
      // Stay in `decrypting` until parent transitions Stage → editor
      // and this component unmounts. Switching to a `success` variant
      // would briefly render an idle-empty state before unmount.
      return state;
    case "request-delete-vault":
      // Permitted only from idle mode (no in-flight password attempt,
      // no recovery-in-progress). Resets any pending partial-fail
      // context from a stale prior attempt.
      if (state.kind !== "idle") return state;
      return { kind: "delete-vault", inFlight: false, partialFail: null };
    case "cancel-delete-vault":
      // Cancel back to idle. Permitted only when NOT inFlight
      // (the form's Cancel button is hidden during the IPC window).
      if (state.kind !== "delete-vault" || state.inFlight) return state;
      return { kind: "idle", password: "", error: null };
    case "delete-vault-in-flight":
      if (state.kind !== "delete-vault") return state;
      return { ...state, inFlight: true };
    case "delete-vault-partial-fail":
      if (state.kind !== "delete-vault") return state;
      return { ...state, inFlight: false, partialFail: action.context };
    case "delete-vault-bug-canary":
      // Bug-canary error (VaultBusyAuth / VaultNotUnlocked /
      // VaultNotFound). Clear inFlight, stay in the form so the
      // user can retry or cancel. No user-visible banner.
      if (state.kind !== "delete-vault") return state;
      return { ...state, inFlight: false };
    default:
      return state;
  }
}

const INITIAL_STATE: UnlockState = { kind: "idle", password: "", error: null };

type BannerOutcome =
  | { kind: "banner"; text: string }
  | { kind: "corrupted" }
  | { kind: "recovery-in-progress" };

function unlockErrorOutcome(e: VaultUnlockError): BannerOutcome {
  switch (e.kind) {
    case "InvalidCredentialOrVault":
      // §7.3 LITERAL compound — UI does NOT collapse to "Wrong password"
      // alone (would silently weaken the non-distinguishing posture).
      // Canonical literal lives in `lib/load-bearing-copy.ts` (E2E
      // asserts it by full-string equality).
      return {
        kind: "banner",
        text: UNLOCK_NON_DISTINGUISHING_BANNER,
      };
    case "InvalidVaultMeta":
      return { kind: "corrupted" };
    case "IoError":
      return { kind: "banner", text: ioBanner(e.detail.io_error_kind) };
    case "VaultNotFound":
      return {
        kind: "banner",
        text: i18n.t("unlock.errors.vaultNotFound"),
      };
    case "VaultAlreadyUnlocked":
      // Stays a banner, and myne-md/myne#535 is the reason it is worth saying
      // why rather than leaving it looking like an oversight.
      //
      // That change routed this variant ON instead, arguing that the vault is
      // already open so there is no credential to retype. The argument was
      // wrong in the one direction that matters: the variant comes from the
      // slot-peek guard BEFORE any derivation, so nothing the user typed is
      // examined, and the claim that made it safe ("auto-lock empties the slot,
      // so a locked vault cannot reach this branch") does not hold.
      // `handleLockFlushed` swallows a `vault_lock` rejection and routes to this
      // screen regardless, on both clients and behind the web idle auto-lock. A
      // failed lock would therefore have produced a lock screen that opens on
      // any one-character password, turning a fail-closed surface into a
      // fail-open one for exactly the adversary `threat-model.md` §1 A6
      // describes and rates as mitigated.
      //
      // The web sign-in dead end this was written for is closed a layer up
      // instead: `vault_slot_kind` is ported, so boot sees the open slot that
      // `sync_join_account` produced and routes to the editor rather than here.
      //
      // myne-md/myne#461 asked for the same thing again, from the desktop
      // migration-settle path, and the answer is the same and for the same
      // reason. That issue proposed re-probing here so the open slot routes to
      // the editor, which is #535's design under another name: a re-probe reads
      // the slot, sees `Unlocked`, and routes on. The case that makes it unsafe
      // is not the one either issue was written about. `lock_with_state` cannot
      // half-fail (`decisions.md` 0520), but a lock IPC that never REACHES it
      // can, and `handleLockFlushed` swallows that rejection and routes here
      // regardless. Re-probing would then open the vault on any keystroke, on a
      // screen the user reached by pressing Lock. #461's real defect is that the
      // frontend routed here at all after a confirm, and that is fixed where it
      // happened, in `SettleMigrationBlock` and `SyncPanel`.
      return { kind: "banner", text: i18n.t("unlock.errors.alreadyUnlocked") };
    case "UnlockInProgress":
      return { kind: "banner", text: i18n.t("unlock.errors.inProgress") };
    case "VaultRecoveryInProgress":
      // Slot is in Slot::Recovering — user must complete the
      // password-reset chained step (recovery-flow.md §4.1) before any
      // unlock attempt. Switch into the `recovery-in-progress` mode so
      // the user can dispatch `unlock.resume-recovery` via the
      // "Continue" CTA.
      return { kind: "recovery-in-progress" };
    case "JoinFailure":
      return {
        kind: "banner",
        text: i18n.t("unlock.errors.unexpected"),
      };
    case "KdfMemoryExceedsHostCapability":
      // A plain banner, deliberately NOT the `corrupted` mode. The vault is
      // intact and opens on desktop — routing to "restore from a backup" would
      // send the user to destroy a working vault over a client limitation.
      // The copy names desktop as the way in, which is the only action that
      // resolves this (phase3-web-client task 31).
      return {
        kind: "banner",
        text: i18n.t("unlock.errors.kdfMemoryExceedsHost", {
          required: e.detail.required_mib,
          available: e.detail.available_mib,
        }),
      };
    case "VaultUpgradedUnsupported":
      // §10.5 anti-downgrade: the vault is on a newer major this build does not
      // implement. NOT `corrupted` — the vault is fine, this app is too old, so
      // the CTA is "update this app", never "restore a backup".
      return { kind: "banner", text: i18n.t("unlock.errors.vaultUpgraded") };
    case "VaultOpenAsImportSource":
      // A vault-import run holds this vault open as its read-only source
      // (myne-md/myne#464). Retryable by the user's own action, so the copy
      // names the action rather than telling them to try again: the import has
      // to finish, be cancelled, or time out first.
      return {
        kind: "banner",
        text: i18n.t("unlock.errors.openAsImportSource"),
      };
    case "NoActiveVaultToImportInto":
      // Not reachable from an UNLOCK: the host returns it only from
      // `import_source_open`, and this screen never calls that. The arm exists
      // because the switch is exhaustive over the shared error type, and
      // falling through would render nothing at all while `tsc` stayed quiet
      // about the reason. Answered with the generic banner rather than copy of
      // its own, because copy for a state a user cannot reach is copy nobody
      // will ever check.
      return {
        kind: "banner",
        text: i18n.t("unlock.errors.unexpected"),
      };
  }
}

/** The password form: the field and its arrow, then the error under them.
 *  No surrounding card: the field is the one thing on screen to do, and a box
 *  around a single row only drew a second outline around the first. */
const FORM_STYLE: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: "var(--space-3)",
  marginTop: "var(--space-2)",
};

// Info-style banner used for `recovery-in-progress` mode — distinct
// from the destructive `<DestructiveBanner>` used for idle-error.
// The user has not made a mistake; the flow was simply paused.
const INFO_BANNER_STYLE: CSSProperties = {
  background: "var(--info-soft)",
  border: "1px solid var(--info)",
  borderRadius: "var(--radius-2)",
  padding: "var(--space-3) var(--space-4)",
  fontSize: "var(--text-base)",
  lineHeight: "var(--leading-normal)",
  color: "var(--info)",
};

// Danger-tinted clone of RECOVER_LINK_STYLE — same shape (link-style
// transparent button) but rendered in `--danger` to telegraph the
// terminal-destructive nature of the affordance without escalating to
// the full Button danger variant (which would compete visually with
// the primary Unlock CTA).
const DELETE_VAULT_LINK_STYLE: CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  gap: "var(--space-2)",
  background: "transparent",
  border: 0,
  padding: 0,
  fontFamily: "var(--font-sans)",
  // Small and regular-weight: a last resort behind a confirmation, so it is
  // findable without competing with Unlock. The trash glyph and the colour
  // carry "destructive" together, never the colour alone.
  fontSize: "var(--text-xs)",
  color: "var(--danger)",
  cursor: "pointer",
  textAlign: "center",
};


/**
 * The secondary actions under the field, one per line (myne-md/myne#773,
 * #772).
 *
 * They were three centred links at near-identical weight, then one wrapping
 * row, where two sentences side by side read as a single run of link text with
 * no seam between them. One per line keeps them apart; each carries the
 * `myne-text-link` underline on hover so it reads as a link when the pointer
 * arrives. Deleting the vault is not among them: it sits below the rule.
 */
const ALT_ROW_STYLE: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  alignItems: "center",
  gap: "var(--space-2)",
  marginTop: "var(--space-2)",
};


const RECOVER_LINK_STYLE: CSSProperties = {
  background: "transparent",
  border: 0,
  padding: 0,
  fontFamily: "var(--font-sans)",
  fontSize: "var(--text-sm)",
  fontWeight: "var(--weight-medium)" as CSSProperties["fontWeight"],
  color: "var(--accent)",
  cursor: "pointer",
};

/**
 * The last-resort zone, below a hairline.
 *
 * Deleting the vault is not a third way to open it, and a red link sitting an
 * equal gap under two blue ones said that it was. The rule is the whole
 * device: it separates a destructive act from the alternatives above it
 * without shouting, and it is a `--line-1` hairline because that is the only
 * way a surface earns division here.
 */
const DANGER_ZONE_STYLE: CSSProperties = {
  display: "flex",
  justifyContent: "center",
  marginTop: "var(--space-2)",
  paddingTop: "var(--space-4)",
  borderTop: "1px solid var(--line-1)",
};

export function Unlock({
  initialStatus,
  vaultId,
  onUnlocked,
  onBack,
  onStartRecovery,
  onResumeRecovery,
  onDeleteVaultSuccess,
  onRestoreBackup,
  suspicionReason,
}: UnlockProps) {
  const { t } = useTranslation();
  const [state, dispatch] = useReducer(reducer, INITIAL_STATE);
  /**
   * The redeemable quick-unlock method (MYND-558). `undefined` = the status
   * probe below is still in flight; a method = quick-unlock owns the screen;
   * `null` = it is offering nothing, so the password form does.
   */
  const [quickMethod, setQuickMethod] = useState<QuickUnlockMethod | null | undefined>(
    undefined,
  );
  /** User traded a redeemable quick-unlock for the password form. */
  const [passwordRevealed, setPasswordRevealed] = useState(false);
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  // Show the back-to-picker link whenever ≥2 vaults exist — so a manual lock or
  // auto-lock reaches the vault selector too, not only a picker-reached unlock.
  // Probed on mount (fresh after any lock; the picker is a meaningful
  // destination only with another vault to switch to).
  const [vaults, setVaults] = useState<readonly VaultSummary[]>([]);
  useEffect(() => {
    let cancelled = false;
    void listVaults().then(
      (res) => {
        if (!cancelled) setVaults("ok" in res ? res.ok : []);
      },
      () => {
        if (!cancelled) setVaults([]);
      },
    );
    return () => {
      cancelled = true;
    };
  }, []);
  /**
   * The name of the vault being opened, or `null`.
   *
   * **The heading names it rather than asking for "your vault".** You arrive
   * here from a list of named vaults and the screen forgot which one you
   * picked — the one question it exists to ask was the only thing on it that
   * did not say what it was about.
   *
   * `null` is a real state and not a defensive branch: the sole-vault path
   * reaches this screen with no `vaultId` at all, and a list that failed to
   * load is empty. Both keep the generic title, because a screen that invents
   * a number is worse than one that does not name the vault.
   *
   * Most users will read the FALLBACK ("Vault 4") rather than a stored name:
   * `VaultSummary.label` is null for a vault this session has not unlocked,
   * and null again when "hide vault names" is on. That is the correct
   * outcome in both cases and needs no branch here — the option erases the
   * name at the source rather than leaving it for a surface to filter.
   */
  const vaultName = useMemo(
    () => vaultDisplayNameById(vaultId, vaults, t),
    [vaultId, vaults, t],
  );

  // A B2B member vault has no password of its own: it is opened from the member's
  // recovery phrase (myne-md/myne#711 task 25), or from a device-local password
  // the member set (`vault.member-unlock`, decisions/protocol/0653). Probed once;
  // when true the password form is replaced by the member card, which offers the
  // password or the phrase. A failed probe leaves `false` (the pre-B2B password
  // path).
  const [memberVault, setMemberVault] = useState(false);
  useEffect(() => {
    let cancelled = false;
    if (!vaultId) {
      setMemberVault(false);
      return;
    }
    // `Promise.resolve` so a test mock that answers an unknown command with
    // `undefined` degrades to "not a member vault" instead of throwing.
    void Promise.resolve(memberVaultStatus(vaultId)).then(
      (isMember) => {
        if (!cancelled) setMemberVault(isMember === true);
      },
      () => {
        if (!cancelled) setMemberVault(false);
      },
    );
    return () => {
      cancelled = true;
    };
  }, [vaultId]);

  // MYND-558 — which credential surface owns the screen. `available` (not
  // `configured`) is the gate: on a cold start the credential exists but the
  // spring-loaded session gate is closed, so redeeming would fail
  // `RequiresFullPassword`. Resolving to `null` there is what makes a fresh
  // launch show only the password form; the PIN field returns after the first
  // full unlock + an auto-lock in the same session.
  //
  // A rejected or garbled probe is a "no quick-unlock" answer, not a dead end —
  // settling in BOTH arms is what keeps the card from sitting in `"pending"`
  // with no credential field at all.
  useEffect(() => {
    let alive = true;
    // Re-probing means the target vault changed, so the previous vault's answer
    // is stale: drop back to `pending` rather than offering its surface for the
    // length of the new probe. Unreachable today (`stage.ts` has no
    // unlock → unlock transition, so a vault switch remounts this screen), and
    // cheap insurance for whoever adds one.
    setQuickMethod(undefined);
    setPasswordRevealed(false);
    quickUnlockStatus(vaultId)
      .then((s) => {
        if (alive) setQuickMethod(s.available && s.method != null ? s.method : null);
      })
      .catch(() => {
        if (alive) setQuickMethod(null);
      });
    return () => {
      alive = false;
    };
  }, [vaultId]);

  // MYND-121 — re-show the window after an idle-lock hid it. Gating the show on
  // REACHING this screen is the safety property: a hung renderer never reloads
  // to here, so it never re-exposes plaintext. Shared with `VaultPicker`, the
  // other locked boot surface (MYND-628) — see the hook for why both need it.
  useRevealAfterIdleLock();

  // MYND-108-bis delete-vault sub-view. Mounts when the user clicks
  // the tertiary "Lost both password and recovery phrase? Delete vault
  // and start over" link below the recovery link. The IPC accepts via
  // `Slot::Empty + vault.meta-exists` (backend's no-keys arm).
  if (state.kind === "delete-vault") {
    const handleDeleteSubmit = () => {
      dispatch({ type: "delete-vault-in-flight" });
      void (async () => {
        try {
          // Required target since #250. The screen already holds the chosen
          // vault's id; the single-vault entry that carries none resolves the
          // sole vault from disk. At ≥2 vaults with no id there is no
          // unambiguous answer — refuse rather than erase a guess.
          const target = vaultId ?? (await soleVaultId());
          if (!mountedRef.current) return;
          if (target == null) {
            if (import.meta.env.DEV) {
              // eslint-disable-next-line no-console
              console.warn("[Unlock] vault_delete refused: ambiguous target");
            }
            dispatch({ type: "delete-vault-bug-canary" });
            return;
          }
          await deleteVault(target);
          if (!mountedRef.current) return;
          // Resolve = full success. Slot stayed Empty (no state change);
          // vault directory recursively removed. Parent reprobes; boot
          // routing picks the return surface by remaining vault count,
          // this component unmounts.
          onDeleteVaultSuccess();
        } catch (raw) {
          if (!mountedRef.current) return;
          const e = raw as VaultDeleteError;
          const vaultDirPath = await vaultDirDisplayPath(vaultId ?? null);
          if (!mountedRef.current) return;
          const mapping = mapDeleteVaultError(e, vaultDirPath);
          if (mapping.kind === "partial-fail") {
            dispatch({
              type: "delete-vault-partial-fail",
              context: mapping.context,
            });
            return;
          }
          // Bug-canary: VaultBusyAuth / VaultNotUnlocked / VaultNotFound.
          // VaultNotUnlocked is unreachable from current backend paths
          // (MYND-108-bis lifted that arm) but we treat it as bug-canary
          // for defense-in-depth.
          if (import.meta.env.DEV) {
            // eslint-disable-next-line no-console
            console.warn(
              "[Unlock] vault_delete rejected (UI/router bug indicator):",
              e,
            );
          }
          dispatch({ type: "delete-vault-bug-canary" });
        }
      })();
    };

    return (
      <CenteredCard>
        {suspicionReason && <SuspicionBanner reason={suspicionReason} />}
        <DeleteVaultConfirmForm
          onSubmit={handleDeleteSubmit}
          onCancel={() => dispatch({ type: "cancel-delete-vault" })}
          onContinueAfterPartial={() => {
            // Same terminal effect as the happy-path Submit.
            onDeleteVaultSuccess();
          }}
          inFlight={state.inFlight}
          partialFailContext={state.partialFail}
          variant={memberVault ? "member" : "owner"}
        />
      </CenteredCard>
    );
  }

  // Boot-time corrupted/IoError mode: render <FailClosedError /> from
  // the first frame; password form never mounts.
  if (initialStatus.kind === "Corrupted") {
    return (
      <FailClosedError
        reason={{ kind: "corrupted-vault" }}
        code={failClosedCode("corrupted-vault")}
        onCtaClick={() => void failClosedExit()}
        ctaLabelKey={FAIL_CLOSED_EXIT_LABEL_KEY}
        onRestoreBackup={onRestoreBackup}
      />
    );
  }
  if (initialStatus.kind === "IoError") {
    return (
      <FailClosedError
        reason={{ kind: "io-error", ioKind: initialStatus.ioKind }}
        code={failClosedCode("io-error")}
        onCtaClick={() => void failClosedExit()}
        ctaLabelKey={FAIL_CLOSED_EXIT_LABEL_KEY}
      />
    );
  }

  // Post-attempt corrupted mode: an `InvalidVaultMeta` mid-flight
  // switches the component to the same fail-closed surface as boot.
  if (state.kind === "corrupted-after-unlock") {
    return (
      <FailClosedError
        reason={{ kind: "corrupted-vault" }}
        code={failClosedCode("corrupted-vault")}
        onCtaClick={() => void failClosedExit()}
        ctaLabelKey={FAIL_CLOSED_EXIT_LABEL_KEY}
        onRestoreBackup={onRestoreBackup}
      />
    );
  }

  // Recovery-in-progress mode: an unlock attempt returned
  // `VaultRecoveryInProgress`. Render an info banner + "Continue" CTA;
  // password form is suppressed.
  if (state.kind === "recovery-in-progress") {
    return (
      <CenteredCard>
        <h1 style={CARD_TITLE_STYLE}>{t("unlock.recoveryInterruptedTitle")}</h1>
        <p style={CARD_BODY_STYLE}>{t("unlock.recoveryInterruptedBody")}</p>
        <div
          role="alert"
          data-testid="unlock.recovery-in-progress-banner"
          style={INFO_BANNER_STYLE}
        >
          {t("unlock.recoveryInterruptedBanner")}
        </div>
        <button
          type="button"
          onClick={onResumeRecovery}
          style={ctaStyle(false)}
          {...ctaInteraction(false)}
          data-testid="unlock.resume-cta"
        >
          <span>{t("unlock.continue")}</span>
        </button>
      </CenteredCard>
    );
  }

  const decrypting = state.kind === "decrypting";
  const password = state.password;
  const error = state.kind === "idle" ? state.error : null;
  const submitDisabled = decrypting || password.length === 0;

  // MYND-558 one-credential-at-a-time split. `"pending"` renders NEITHER field:
  // for the few milliseconds the probe is in flight the card shows its heading
  // alone rather than flashing a password form it is about to replace.
  const surface: "pending" | "quick" | "password" =
    quickMethod === undefined
      ? "pending"
      : quickMethod !== null && !passwordRevealed
        ? "quick"
        : "password";

  const onSubmit = (ev: FormEvent) => {
    ev.preventDefault();
    if (submitDisabled) return;
    dispatch({ type: "submit" });
    void (async () => {
      try {
        // SYNC-6 vault-addressed unlock: `vaultId` opens exactly that vault's
        // `vaults/<id>/vault.meta`; `undefined` (the Tauri arg is then omitted)
        // falls through to the backend's sole-vault `None` path. Tauri maps the
        // `vaultId` camelCase key to the command's `vault_id: Option<String>`
        // param. On a switch the backend locks the prior `Unlocked` vault first
        // (SYNC-1), so no other vault stays unlocked.
        await invoke<void>("plugin:vault-unlock|unlock", { vaultId, password });
        dispatch({ type: "success" });
        onUnlocked();
      } catch (raw) {
        const outcome = unlockErrorOutcome(raw as VaultUnlockError);
        if (outcome.kind === "corrupted") {
          dispatch({ type: "fail-corrupted" });
        } else if (outcome.kind === "recovery-in-progress") {
          dispatch({ type: "fail-recovery-in-progress" });
        } else {
          dispatch({ type: "fail", error: outcome.text });
        }
      }
    })();
  };

  // A member vault is opened from the recovery phrase, not a password
  // (myne-md/myne#711 task 25). It is a BODY inside this shell rather than its
  // own screen (Aşama 2b): the early return it used to be gave a member a
  // different screen from an owner — no mark, no heading, no way to say which
  // vault was being opened — and none of the shell's slots, so a member had no
  // back link at any vault count.
  return (
    <AuthShell
      testId="unlock.root"
      // A short, fixed form: the upper third rather than dead centre. Unlike
      // the picker there is no list here, so nothing on this screen can grow
      // to fill a centred region.
      align="upper"
      // The mark is centred above the question instead (the Welcome screen's
      // shape), so the corner copy would draw the brand twice.
      brand={false}
      // The way back to the vault picker, in the top-left corner where a back
      // control is looked for, now that the corner holds no brand. Shown
      // whenever `onBack` is wired, which App does unconditionally, and withdrawn
      // during `decrypting` so an in-flight unlock is never abandoned mid-IPC.
      //
      // It used to need ≥2 vaults, and that threshold was the dead end the audit
      // opened on: with a single vault the picker — and with it create, join and
      // restore — was unreachable, so a user whose one vault would not open had
      // no door but quitting. `VaultPicker` renders its three doors at any count,
      // including one, so the threshold was the whole of the problem.
      leading={
        onBack && !decrypting ? (
          <Button
            type="button"
            variant="ghost"
            icon="arrow-left"
            onClick={onBack}
            data-testid="unlock.back-to-picker"
          >
            {t("unlock.backToPicker")}
          </Button>
        ) : undefined
      }
      // Arriving here is going FORWARD from the picker. The back link below
      // sends the user the other way, and the picker states its own direction.
      enter="forward"
    >
      {suspicionReason && <SuspicionBanner reason={suspicionReason} />}
      <div style={{ display: "flex", justifyContent: "center" }}>
        <MyneMark size={56} />
      </div>
      {/* Method-aware subtitle: the PIN / Touch ID surface must not tell the user
          to "enter your password" (MYND — the primary surface is not a password
          when quick-unlock owns the screen). */}
      <AuthHeading
        centered
        title={
          vaultName === null
            ? t("unlock.title")
            : t("unlock.titleNamed", { vault: vaultName })
        }
      >
        {memberVault
          ? t("unlock.memberSubtitle")
          : t(
              surface === "quick"
                ? quickMethod === "biometric"
                  ? "unlock.subtitleBiometric"
                  : "unlock.subtitlePin"
                : "unlock.subtitle",
            )}
      </AuthHeading>
      {/* A member vault's credential is not a password, so the two surfaces share
          this shell and differ only in the body. The heading, the mark and the
          back link above are the same on both — which is the point: the question
          this screen asks is "which vault, and what opens it", and the answer to
          the first half is the same for everyone. */}
      {memberVault && vaultId ? (
        <MemberVaultUnlockCard vaultId={vaultId} onUnlocked={onUnlocked} />
      ) : (
        <>
      {/* Quick-unlock (PIN / Touch ID) — the primary surface when the probe
          above says it is redeemable and the user hasn't opted out (MYND-329,
          MYND-558). The password escape hatch sits one click below it:
          quick-unlock is a convenience gate, not a replacement, so a user who
          has forgotten the PIN reaches the master password without restarting
          the app. */}
      {surface === "quick" && quickMethod != null && (
        <>
          <QuickUnlockEntry
            vaultId={vaultId}
            method={quickMethod}
            onUnlocked={onUnlocked}
            onUnavailable={() => setQuickMethod(null)}
          />
        </>
      )}
      {/* `data-vault-id` mirrors the picker-row idiom (SYNC-8): the
          vault-addressed unlock target threaded from the Stage payload,
          observable to the E2E suite (MYND-127 story 2). Absent when the
          backend's sole-vault `None` path applies. */}
      {surface === "password" && (
        <form
          style={FORM_STYLE}
          onSubmit={onSubmit}
          noValidate
          data-testid="unlock.form"
          data-vault-id={vaultId}
        >
          <CredentialField
            value={password}
            onChange={(value) => dispatch({ type: "set-password", value })}
            busy={decrypting}
            invalid={error != null}
            ariaLabel={t("unlock.passwordLabel")}
            placeholder={t("unlock.passwordPlaceholder")}
            submitLabel={t("unlock.submit")}
            busyLabel={t("unlock.decrypting")}
            testId="unlock.password-input"
            submitTestId="unlock.submit"
            reveal={{ show: t("password.input.show"), hide: t("password.input.hide") }}
            inputProps={{
              type: "password",
              // eslint-disable-next-line jsx-a11y/no-autofocus
              autoFocus: true,
              autoComplete: "current-password",
            }}
            footer={
              error != null ? (
                <DestructiveBanner testId="unlock.error-banner">{error}</DestructiveBanner>
              ) : undefined
            }
          />
        </form>
      )}
      {/* The alternatives to the credential on screen, on one row, under
          either surface: the PIN / Touch ID screen and the password screen are
          the same screen with a different field, so they share this row and the
          delete zone below it. Swapping between them changes only the field.
          The way back to the quick surface is offered only while quick-unlock is
          still redeemable, so an exhausted credential is never re-offered. */}
      {surface !== "pending" && !decrypting && (
        <div style={ALT_ROW_STYLE} data-testid="unlock.alt-row">
          {surface === "quick" ? (
            <button
              type="button"
              onClick={() => setPasswordRevealed(true)}
              style={RECOVER_LINK_STYLE}
              className="myne-text-link"
              data-testid="unlock.use-password-link"
            >
              {t("unlock.usePasswordInstead")}
            </button>
          ) : (
            quickMethod != null && (
              <button
                type="button"
                onClick={() => setPasswordRevealed(false)}
                style={RECOVER_LINK_STYLE}
                className="myne-text-link"
                data-testid="unlock.use-quick-unlock-link"
              >
                {quickMethod === "biometric"
                  ? t("unlock.useBiometricInstead", {
                      biometric: t("settings.quickUnlock.methodTouchId"),
                    })
                  : t("unlock.unlockWithPinInstead")}
              </button>
            )
          )}
          <button
            type="button"
            onClick={onStartRecovery}
            style={RECOVER_LINK_STYLE}
            className="myne-text-link"
            data-testid="unlock.recovery-link"
          >
            {t("unlock.recoveryLink")}
          </button>
        </div>
      )}
        </>
      )}
      {/* Below the rule: destroying the vault is not a third way to open it,
          and neither is removing a shared vault from this device. This sits
          OUTSIDE the member/owner branch because the way out when the
          credential is gone is the same on both: the label and the confirm
          screen already branch on `memberVault`, and only the entry point was
          on the owner's side of the ternary. The `trash-2` glyph is the
          canon's own requirement rather than decoration — `PRODUCT.md` says
          colour is never the sole channel. */}
      {(memberVault || surface !== "pending") && !decrypting && (
        <div style={DANGER_ZONE_STYLE}>
          <button
            type="button"
            onClick={() => dispatch({ type: "request-delete-vault" })}
            style={DELETE_VAULT_LINK_STYLE}
            className="myne-text-link"
            data-testid="unlock.delete-link"
          >
            <Icon name="trash-2" size={14} />
            {memberVault ? t("unlock.memberRemoveLink") : t("unlock.deleteLink")}
          </button>
        </div>
      )}
    </AuthShell>
  );
}
