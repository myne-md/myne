import {
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import { PendingApproval } from "./screens/PendingApproval";
import { Welcome } from "./screens/Welcome";
import { FirstRun } from "./screens/FirstRun";
import { IdentityHome } from "./screens/IdentityHome";
import { formatPersonAccountNumber } from "@myne/client-core/person-account";
import { RestoreBackup } from "./screens/RestoreBackup";

import { Unlock } from "./screens/Unlock";
import { VaultPicker } from "./screens/VaultPicker";
import {
  initialStageFromProbe,
  transition,
  type Action,
  type SlotMap,
  type Stage,
  type StageVaultStatus,
  type SuspicionReason,
  type VaultId,
} from "./lib/stage";
import {
  dormancyForLock,
  initializePlainFiles,
  restoreDormant,
  usePlainFileState,
} from "./plain/store";
import { OpenFileConfirm } from "./plain/OpenFileConfirm";
import {
  OPEN_FILE_EVENT,
  consumePendingOpenFile,
  type OpenFileRequest,
} from "./plain/openFileDeepLink";
import { PairingDialog } from "./components/PairingDialog";
import { ScreenCaptureEscape } from "./components/ScreenCaptureEscape";
import { SkipToContent } from "./components/SkipToContent";
import { Toaster } from "./components/toast/Toaster";
import { UpdateNotice } from "./components/update/UpdateNotice";
import { UpdatingScreen } from "./screens/UpdatingScreen";
import { InvitesDialog } from "./components/sync/InvitesDialog";
import { unclaimedInvites } from "./hooks/usePendingInvites";
import { usePendingInvites } from "./hooks/usePendingInvites";
import { resetPersonIdentityState, setPersonIdentityState } from "./components/sync/personIdentityState";
import { has } from "./platform/capabilities";
import { listVaults } from "./lib/vault-list";
import { personAccountNumber, personStatus } from "./lib/personAccount";
import { probeSlotKind } from "./lib/vault-slot-kind";
import { lockVault } from "./lib/vault-unlock";
import { useIdleAutoLock } from "./hooks/useIdleAutoLock";
import { effectiveAutoLockSecs } from "@myne/client-core";
import { awaitingApprovalVerdict } from "./lib/pending-approval";
import { leaveActiveVault, switchVault } from "./lib/vault-switch";
import { prefsRead } from "./lib/prefs";
import { applyTheme, applyCustomTheme } from "./lib/theme";
import { applyAccent, readAccent } from "./lib/accentColor";
import { useStageRoute } from "./lib/routing";
import { installCloseInterceptor } from "./lib/close-request";
import { useUpdateAvailable } from "./hooks/useUpdateAvailable";
import { HAS_NATIVE_TITLE_BAR, dragRegionProps } from "./screens/titlebar";
import { readCustomTheme } from "./lib/themes";
import { useThemesNonce } from "./lib/themesSignal";
import { detachedNoteId as readDetachedNoteId } from "./lib/detachedWindow";

// Editor (the post-unlock workspace) is the app's heaviest screen — CodeMirror,
// the shared @myne/editor engine, and every code-block language grammar hang off
// it, and it is only ever shown AFTER unlock. A React.lazy boundary keeps that
// whole graph out of the first-load bundle (web bundle budget; same precedent as
// GraphView → GraphCanvas, the app's other lazy boundary).
const Editor = lazy(() =>
  import("./screens/Editor").then((m) => ({ default: m.Editor })),
);

/** Lazy for the same reason as `Editor`: the surface mounts `@myne/editor`, and
 *  a static import would pull the whole engine into the first-load bundle of
 *  every stage (web bundle budget, `check-web-bundle-budget.mjs`). */
const PlainFileScreen = lazy(() =>
  import("./plain/PlainFileScreen").then((m) => ({
    default: m.PlainFileScreen,
  })),
);

/**
 * Lazy since 2026-08-15, when the creation flow started shipping to the web
 * client too.
 *
 * Eager was defensible while this was desktop-only code that a browser never
 * downloaded. Now it is first-load weight on a bundle whose trust story is that
 * it is small enough for someone to read the hashes of, and it is weight almost
 * nobody pays: creation runs once per account, and the BIP-39 wordlist behind it
 * is dead bytes on every later visit. `Suspense fallback={null}` matches the
 * Editor's — this route is entered by a click, not by boot.
 */
const CreateVault = lazy(() =>
  import("./screens/CreateVault").then((m) => ({ default: m.CreateVault })),
);

/**
 * Lazy for exactly the reason `CreateVault` above is, and it is the second door
 * the same change opened.
 *
 * Splitting the creation flow out and leaving this one eager took the wordlist
 * out of first load through one route and put it back through the other, which
 * is why the bundle budget went over its cap on the merge rather than on either
 * change alone. Recovery is the rarest route in the product: a user reaches it
 * once, after forgetting a password, and every other visit pays for it.
 */
const VaultRecover = lazy(() =>
  import("./screens/VaultRecover").then((m) => ({ default: m.VaultRecover })),
);

// Synthetic key for the single-entry boot `SlotMap` (MYND-204 SYNC-4).
// `initialStageFromProbe` routes on the slot KIND only — it scans
// `Object.values(slotMap)` and never reads a key — so this string is
// purely structural and carries no meaning. Under SYNC-1 (one vault
// unlocked at a time) at most one slot is non-`Empty`, and the Rust
// runtime owns "which vault is active", so the boot probe maps the lone
// active-slot kind under this fixed key rather than building a per-vault
// map. A correctness-under-SYNC-1 constant, NOT a transitional sentinel.
const ACTIVE_SLOT_KEY = "active-slot";

function App() {
  // myne#678 render (epic #173): the note id this window was popped out for, or
  // null in the main window / on web / on mobile (no OS window is spawned there).
  // Read once from the host-injected global; stable for the window's lifetime.
  // When set, the editor stage renders a single-note, sidebar-collapsed surface
  // (see `<Editor detachedNoteId>`). The rest of the boot machine is unchanged:
  // the detached window still probes and, with the backend already unlocked by
  // the main window, routes to `editor` (and #679 destroys it on lock).
  const detachedId = readDetachedNoteId();

  // Initial stage is `null` until the boot probe resolves (loading
  // shim renders blank). Production has no shortcut to bypass the
  // probe — MYND-80 acceptance forbids prod-guard bypass even in dev,
  // so the previous `?test-stage=` URL parameter shortcut is gone
  // (would have let dev users mount editor with an empty
  // VaultRuntimeState slot, defeating the editor mount guard).
  const [stage, setStage] = useState<Stage | null>(null);

  // Transient "saving…" flag for the multi-vault switch (MYND-205). True
  // only while `switchVault`'s param-less `vault_lock()` IPC is in flight
  // (the prior vault's `flushIfDirty` + four-surface teardown); cleared once
  // the lock settles and the `editor.switch-vault` Stage action is
  // dispatched. The switcher dropdown (sub-feature 4 task 5) renders the
  // "saving…" affordance off this; App.tsx also shows a lightweight overlay
  // so the state is visible even before the dropdown lands. No confirm-
  // discard dialog — `vault_lock()`'s flush covers unsaved edits.
  const [switching, setSwitching] = useState(false);

  // The invitations dialog (myne-md/myne#911 follow-up): the ONE surface on
  // which an invitation can be accepted by a device that already holds a vault.
  // It is a modal over whatever is showing, like the join, because its two
  // entries (the picker's notice row and the switcher's) land differently.
  const [invitesOpen, setInvitesOpen] = useState(false);
  // Identity-only home (myne-md/myne#711): at zero vaults, if this device
  // already holds a person account, show the identity home instead of Welcome.
  // Probe-only state; a failed probe leaves `false` (the pre-B2B Welcome path).
  const [personEnrolled, setPersonEnrolled] = useState(false);
  const [personAccountState, setPersonAccountState] = useState<
    "reserved" | "pending" | "enrolled" | null
  >(null);
  // `person_id_hex` is read off the same probe and deliberately NOT kept: the
  // identity home used to print it above the invite code, which is an unlabeled
  // 32-byte blob a user can neither read nor act on (myne-md/myne#869). The
  // public material that IS actionable is `identity_code`.
  const [identityCode, setIdentityCode] = useState<string | null>(null);
  // The person account number, DISPLAY form, for the identity home
  // (myne-md/myne#911 review). Read from the backend's derived value and
  // formatted through the shared presentation module, so the grouping matches
  // every client.
  const [personAccountNumberValue, setPersonAccountNumberValue] = useState<string | null>(null);

  // Unaccepted invitations, read once per process and shared by the picker's
  // notice row, the switcher's, and the dialog itself. Gated on the lifecycle
  // rather than firing blind: an invitation cannot exist for an identity the
  // server has never seen, and the hook says so without a request.
  //
  // This is the one client-side call that talks to the sync server BEFORE any
  // vault is unlocked. It is the same call the identity home already makes when
  // it is the landing screen, and it carries only the device token: no vault
  // key, no note, nothing that needs `root_key`.
  const pendingInvites = usePendingInvites(personAccountState === "enrolled");
  const inviteCount = unclaimedInvites(pendingInvites.invites).length;

  // Boot-time multi-vault probe pair (MYND-204 SYNC-4): `vault_list`
  // (disk enumeration) + `vault_slot_kind(None)` (the active runtime
  // slot). Issued in parallel via `Promise.all` — both are cheap (each
  // vault.meta is 345 bytes; the slot peek is microseconds) and
  // independent, so the boot blocking-time is bounded by the slower of
  // the two. The `probed` ref guards against React 18 StrictMode
  // double-effect in dev. Also re-fires when `reprobe()` resets `stage`
  // to null (Editor mount guard's "Lock" CTA → fail-closed → re-route).
  //
  // Slot-priority routing applies: a `Recovering` or `Unlocked` runtime
  // slot pins the boot stage to `recover(password-reset)` or `editor`
  // regardless of disk state / vault count (`initialStageFromProbe`
  // scans the slot map first). Post-WebView-reload (Cmd+R / HMR — the
  // Tauri host outlives the JS runtime), the lone non-`Empty` slot is
  // how we detect a mid-flow vault.
  const probed = useRef(false);
  useEffect(() => {
    if (stage !== null) return; // already-resolved probe
    if (probed.current) return; // StrictMode second invocation
    probed.current = true;
    void (async () => {
      // Build the `(vaultList, slotMap)` pair `initialStageFromProbe`
      // consumes. `listVaults()` enumerates every `vaults/<id>/` on disk;
      // `probeSlotKind()` (no `vaultId` → the active/sole vault) reports
      // the one live slot.
      //
      // **Single-entry SlotMap is correct under SYNC-1, not a stopgap.**
      // SYNC-1 guarantees AT MOST ONE vault holds a non-`Empty` slot, so
      // a per-vault probe loop over every discovered vault would be
      // wasted IPC for zero routing benefit — boot routing only needs
      // "the active slot's kind", which the Rust runtime owns ("which
      // vault is active" is resolved host-side). The `None`-arg
      // `vault_slot_kind` path is **Recovering-aware**: it resolves via
      // `active_vault_or_recovering_for_probe` (Unlocked first, else
      // Recovering, else Empty — `src-tauri/.../commands.rs`
      // `vault_slot_kind_inner` + `state.rs`
      // `active_or_recovering_vault_id`), so a post-reload mid-recovery
      // slot is detected and routes to `recover`. Routing keys only on
      // the slot KIND, never the vault id (the runtime owns active-vault
      // identity), so the synthetic key below is purely structural.
      // Two probes, not three. MYND-635 added an `isPendingApproval()` read
      // here and myne-md/myne#535 removed it, because the question it asked
      // cannot be answered before the vault is unlocked: on the web client an
      // approved device whose session token died with the tab
      // (`design-notes/clients/0363`) is on disk indistinguishable from one
      // nobody has approved. Routing on it sent every reload to a screen that
      // asks for no password, and the only exit from pending needs `root_key`.
      // The verdict is taken after unlock instead, where the screen it routes to
      // can actually make progress: `awaitingApprovalVerdict` below.
      const [vaultList, activeSlotKind, person, accountNumberCanonical] = await Promise.all([
        listVaults(),
        probeSlotKind(),
        // A vault-less identity probe. It only changes what the ZERO-VAULT
        // (`welcome`) arm renders; every other route is decided by the vault
        // probes, so a failure here degrades to the pre-B2B Welcome screen
        // rather than blocking boot.
        personStatus().catch(() => ({
          enrolled: false,
          state: null,
          identity_unlocked: false,
          person_id_hex: null,
          identity_code: null,
          sealed_keypair_present: false,
        })),
        // `null` for a device with no identity, which is every device that has
        // not created one; the identity home is the only surface that reads it.
        personAccountNumber().catch(() => null),
      ]);
      const slotMap: SlotMap = { [ACTIVE_SLOT_KEY]: activeSlotKind };
      // Any identity state lands the zero-vault arm on the identity home, not
      // only `enrolled` (myne-md/myne#911): a `reserved` identity has no token by
      // definition, and offering it the Welcome screen would offer a Create that
      // cannot open the frame the device already holds.
      //
      // The booleans stay as a fallback so a status payload that predates the
      // `state` field routes correctly instead of reading `undefined` as an
      // identity: `state != null` is false for both `null` and absent.
      setPersonEnrolled(
        person.state != null || person.enrolled || person.sealed_keypair_present,
      );
      setPersonAccountState(person.state ?? (person.enrolled ? "enrolled" : null));
      setIdentityCode(person.identity_code);
      setPersonAccountNumberValue(
        accountNumberCanonical ? formatPersonAccountNumber(accountNumberCanonical) : null,
      );
      setPersonIdentityState({
        ready: person.identity_unlocked,
        ownerCode: person.identity_code,
      });
      setStage(initialStageFromProbe(vaultList, slotMap));
    })();
  }, [stage]);

  // The awaiting-approval verdict (myne-md/myne#535), the probe that used to
  // ride in the `Promise.all` above, moved to where it can be answered.
  //
  // It runs on ENTERING the editor rather than at boot, and the reason is the
  // SCREEN rather than the reads. Both reads the verdict makes are device-local
  // and neither needs `root_key`, so the question itself is askable earlier; the
  // wait it routes to is not reachable earlier. The only exit from pending is
  // `try_claim_token`, which runs inside a sync cycle, and the cycle refuses on a
  // locked vault before it reaches the claim. A pre-unlock wait screen therefore
  // cannot make progress, which is exactly the deadlock MYND-635's boot arm
  // shipped. What boot genuinely cannot do is tell the two devices apart:
  // `design-notes/clients/0363` makes the web token session-scoped, so before
  // unlock an approved device and an unapproved one present the identical
  // identity-present + token-absent pair. See `src/lib/pending-approval.ts` for
  // the two reads and why their order is load-bearing.
  //
  // The per-client difference lives INSIDE the verdict, not here. A desktop
  // device can be pending too, and evicting it from a vault that opens perfectly
  // well would be a regression there. That rule belongs with the module
  // that owns what each answer means, where a capability-substitution test can
  // reach it. It used to sit in `initialStageFromProbe`, covered per client by
  // the stage harness; putting it in this effect instead would have moved the
  // one behaviour that still differs between the clients into the one place
  // nothing asserts.
  //
  // `setStage` functionally rather than through `dispatch`, which is defined
  // below the loading-shim early return and so is not in scope here. The
  // functional form is also what keeps this race-free: a lock or a switch that
  // lands between the verdict being asked for and coming back leaves `prev` on
  // some other stage, and `transition` rejects the action rather than dragging
  // the user back out of it.
  // The app's ONE close path (myne-md/myne#945 item 05). Installed here rather
  // than by the screen that flushes something, because the failure it fixes is
  // per-screen: Tauri `prevent_close()`s the native control the moment any JS
  // listener exists for `tauri://close-requested`, so a listener that belonged to
  // a screen which is no longer mounted left the window unclosable, measured on
  // the quick-unlock screen, which registers no listener of its own and so has no
  // way to finish a close another screen started. A listener that lives exactly
  // as long as the process has no such state to lose, and screens contribute
  // guards instead (see `src/lib/close-request.ts`).
  useEffect(() => {
    installCloseInterceptor();
  }, []);

  // Hoisted out of the effect so the dep array can name it: `stage` is a union
  // and the narrowing the guard performs does not reach the deps expression.
  const editorVaultId = stage?.name === "editor" ? stage.vaultId : undefined;

  useEffect(() => {
    if (stage?.name !== "editor") return;
    let cancelled = false;
    void awaitingApprovalVerdict().then((awaiting) => {
      if (cancelled || !awaiting) return;
      setStage((prev) =>
        prev?.name === "editor" ? transition(prev, { type: "editor.awaiting-approval" }) : prev,
      );
    });
    return () => {
      cancelled = true;
    };
  }, [stage?.name, editorVaultId]);

  // Out-of-band stage reset for fail-closed recovery (Q5β-1
  // belt+suspenders). Bypasses the transition fn intentionally — the
  // transition fn is for explicit user-driven flow transitions, while
  // "reset to whatever vault_status now says" is a recovery path that
  // doesn't fit a (prev, action) → next mapping. Resets the `probed`
  // ref so the boot-probe useEffect re-runs.
  // Stable identity: `useStageRoute` re-subscribes to the back button whenever
  // this changes, and a per-render function would re-arm the listener on every
  // render for no reason.
  const reprobe = useCallback(() => {
    probed.current = false;
    setStage(null);
  }, []);

  // Out-of-band stage set with a fully-known target — sibling to
  // `reprobe()`. Used by post-event handlers (today: change-password
  // modal's force-relock callback) where the post-event Stage is
  // already known from the error variant; re-probing would re-issue
  // `vault_status` + `vault_slot_kind` IPCs and could subtly race
  // (low probability, but the goal of the suspicion path is to surface
  // unusual state — a probe race could hide it). Direct atomic Stage
  // set: one transition, one render, no IPC roundtrip.
  //
  // `suspicionReason` is the optional one-shot signal carried on the
  // resulting `unlock` stage's payload (`<Unlock>` reads it and
  // renders `<SuspicionBanner>` above the password form). See
  // `decisions.md` 2026-05-08 "`Stage.unlock.suspicionReason?` field".
  const setStageWithSuspicion = useCallback(
    (status: StageVaultStatus, suspicionReason?: SuspicionReason) => {
      resetPersonIdentityState();
      // Functional set: read the CURRENT stage so the force-relock
      // unlock stays addressed at the vault that was just relocked
      // (MYND-219 / SYNC-17 — the editor stage carries the active
      // vault's id; at ≥2 vaults the sole-vault `None` fallback would
      // be ambiguous).
      setStage((curr) => ({
        name: "unlock",
        initialStatus: status,
        suspicionReason,
        vaultId: curr?.name === "editor" ? curr.vaultId : undefined,
      }));
    },
    [],
  );

  // Where an accepted invitation LANDS. A member vault arrives PENDING: another
  // device has to approve this one, and until it does the vault holds nothing to
  // show. `sync-protocol.md` §6.3 requires the head-fingerprint compare on that
  // bootstrap, and the compare lives on the approval wait, so a landing that
  // reprobes puts the user in an editor that is empty and a compare that is
  // skipped. That is the same hole the mobile client had, and the same fix: hold
  // the device on `pending-approval`.
  //
  // Desktop answers `false` from `awaitingApprovalVerdict` on purpose, so this
  // cannot be an inference after unlock: a desktop vault may be the only copy,
  // and locking its owner out of a vault that opens locally is worse than an
  // unexplained empty one. The join KNOWS, which is why it says so here, and a
  // refresh during the wait still falls back to the editor, where the Settings
  // sync panel reports the wait and offers the enrolment surface.
  //
  // An undefined id keeps the old behaviour for a caller that installed nothing
  // itself.
  const landOnInstalledVault = useCallback((vaultId?: string) => {
    if (vaultId === undefined) {
      reprobe();
      return;
    }
    setStage({ name: "pending-approval" });
  }, [reprobe]);

  // Window-level Cmd/Ctrl+F native-find SUPPRESSION (MYND-175). This listener's
  // sole remaining job is `preventDefault` on the literal Cmd+F, app-wide on
  // every stage: the WebView's native find scans the rendered DOM — a different
  // text than the note's canonical markdown — so it must never appear, and that
  // is true regardless of what the user rebinds "Find in note" to. OPENING the
  // find bar moved to the rebindable `find.open` engine command (#184 track C,
  // editor stage), so this no longer imports find-session. It stays OUT of the CM
  // keymap on purpose (a keymap only fires when the editor is focused — native
  // find would leak everywhere else).
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey)) return;
      if (e.key !== "f" && e.key !== "F") return;
      if (e.shiftKey || e.altKey) return; // leave Cmd+Shift+F / Cmd+Alt+F alone
      e.preventDefault();
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, []);

  // Theme application chokepoint (MYND-110). `App` is the single owner of
  // `<html data-theme>` across stage transitions. On the editor stage (the
  // only post-unlock stage) read the stored theme from the encrypted
  // vault.prefs and apply it; on ANY other stage — boot loading, every
  // pre-unlock screen, and lock (editor → unlock) — remove the attribute so
  // the UI follows the OS `prefers-color-scheme`. This keeps the invariant
  // "data-theme present ⟺ vault unlocked & explicit pref" (the UI-layer image
  // of zeroize-on-lock, A6): a locked vault never shows the user's chosen
  // theme, and the post-lock Unlock screen is identical to the cold-boot one.
  // In-session changes from Settings → Appearance call `applyTheme` directly
  // (disk-first), so this effect only handles the stage-transition path.
  const stageName = stage?.name;

  // The idle auto-lock for the ONE post-unlock stage that is not the editor
  // (myne-md/myne#535).
  //
  // `editor.awaiting-approval` deliberately leaves the vault unlocked, because
  // the wait exists so the sync cycle can claim a token and the claim needs
  // `root_key`. But the stage renders `PendingApproval`, not `Editor`, and on
  // the web client the only idle auto-lock there is lives inside `Editor`
  // (`useIdleAutoLock`, mounted at its bottom). So without this the transition
  // routes a user to a screen holding live keys where no timer will ever fire,
  // and the wait has no outbound transition of its own: `threat-model.md` §1 A6
  // rates the stolen-unlocked-device case mitigated ON auto-lock zeroizing those
  // keys, and its per-client clause qualifies the web timer as weaker, never as
  // absent on a whole screen.
  //
  // It is also the reachable-by-the-server half of the same fact. The verdict
  // asks the network nothing, but the state it reads is one a server controls: a
  // device holds no adopted head for exactly as long as the server withholds
  // approval, and TB5 assumes a server that may refuse service. So a server that
  // simply never approves parks every browser on this screen with a live
  // `root_key` in RAM. A timer that runs on the stage removes the value of doing
  // that.
  //
  // `enabled` is left to the hook's own default, which is "wherever
  // `osIdleAutoLock` is absent", so desktop is untouched and the two clocks
  // never race. The timeout is the same `auto_lock_seconds` pref the editor
  // uses, through the same shared clamp, so no stored value can disable the
  // lock. A failed READ still falls back to `0`, and that stays deliberate: an
  // unreadable prefs blob is not a prefs value, and inventing a deadline for a
  // screen that holds no plaintext would be worse than leaving the timer off.
  const [pendingIdleSecs, setPendingIdleSecs] = useState(0);
  useEffect(() => {
    if (stageName !== "pending-approval") {
      setPendingIdleSecs(0);
      return;
    }
    let cancelled = false;
    void prefsRead()
      .then((prefs) => {
        // Clamped through the shared envelope for the reason
        // `src/screens/Editor.tsx` states at its own call: on web this is the
        // timer that fires, and a `null` pref meant no lock at all.
        if (!cancelled) {
          setPendingIdleSecs(effectiveAutoLockSecs(prefs.auto_lock_seconds ?? null));
        }
      })
      .catch(() => {
        /* leave it disabled rather than inventing a deadline */
      });
    return () => {
      cancelled = true;
    };
  }, [stageName]);
  useIdleAutoLock({
    timeoutSecs: pendingIdleSecs,
    onIdle: () => {
      // Nothing to flush here: this screen edits nothing. Lock, then re-probe,
      // which lands on the password form because the slot is empty again.
      //
      // **The `catch` is not a best-effort lock, and the earlier comment here
      // said it was.** It read: "if the lock IPC rejects, the slot stays
      // unlocked, the reprobe reads it, and the user lands in the EDITOR, which
      // holds the same live keys." That failure is not reachable, and a comment
      // understating a guarantee is the same defect as one overstating it: the
      // next reader either adds a control for nothing or stops trusting a
      // guarantee that holds (myne-md/myne#540).
      //
      // `lock_with_state` takes the slot and returns `Ok(())` with no fallible
      // step after the take, and `lock_from_host`'s only `?` is on that call, so
      // the command cannot report a failure while leaving the slot unlocked. On
      // web the reachable rejections are: a FATAL Worker, which is the side
      // holding the keys, so its death is what the lock was for; `unsupported`,
      // which `scripts/check-web-command-coverage.mjs` holds closed; and a
      // structured-clone throw while posting, which needs a payload this command
      // does not take. On desktop the Tauri IPC can fail transport-side, but
      // desktop's auto-lock is the Rust timer in `auto_lock.rs` and never comes
      // through here at all.
      //
      // So the `catch` exists to keep the `finally` reachable, not to absorb a
      // half-locked vault. `teardownStep` (`lib/vault-unlock.ts`) is the guard
      // that matters on this path: it stops a throwing pre-lock reset from
      // skipping the lock IPC entirely.
      void lockVault()
        .catch(() => {
          /* see above: no reachable rejection leaves the slot unlocked */
        })
        .finally(() => reprobe());
    },
  });

  // The plain-file surface (myne-md/myne#788). Rendered OVER the vault stage
  // whenever files are open, in every vault state: a locked vault and a device
  // with no vault both still open the user's own files. The vault stays exactly
  // where it was behind it, and closing the last tab reveals it again.
  //
  // These hooks sit ABOVE the `stage === null` early return below, and that is
  // load-bearing: a hook declared after a conditional return renders more hooks
  // on the second pass than on the first, which React rejects. The boot probe
  // makes that first pass the common one.
  //
  // Lock/unlock parks the tabs in RAM (`dormancyForLock`, after the flush) and
  // brings them back on unlock; a restart restores nothing, which is the
  // zero-trace rule. The Rust-side handles stay alive through dormancy, because
  // the frontend holds no path with which it could re-open them.
  const plainState = usePlainFileState();
  const plainScreen = plainState.files.length > 0;
  // Subscribe and drain ONCE per process, at App level rather than inside the
  // surface: the surface renders only when a file is already open, so an
  // initialization living there could never deliver the first one. The listener
  // stays installed for the process lifetime (the store guards re-entry).
  useEffect(() => {
    void initializePlainFiles();
  }, []);
  // The `myne://open-file` confirmation (myne-md/myne#788 task 12). The handler
  // latches an already-resolved canonical path and fires a bare event; App owns
  // the one slot because the dialog must be able to appear over ANY vault stage,
  // including locked. Same drain shape as ThemeInstallDialog, deliberately.
  const [openFileRequest, setOpenFileRequest] = useState<OpenFileRequest | null>(null);
  useEffect(() => {
    const drain = () => {
      const next = consumePendingOpenFile();
      if (next) setOpenFileRequest(next);
    };
    drain();
    window.addEventListener(OPEN_FILE_EVENT, drain);
    return () => window.removeEventListener(OPEN_FILE_EVENT, drain);
  }, []);
  const prevStageRef = useRef(stage?.name ?? null);
  useEffect(() => {
    const current = stage?.name ?? null;
    const previous = prevStageRef.current;
    prevStageRef.current = current;
    if (previous === "editor" && current !== "editor") {
      void dormancyForLock();
    } else if (previous !== "editor" && current === "editor") {
      restoreDormant();
    }
  }, [stage?.name]);

  // myne#943: the PAINT path below has no refresh boundary other than a stage
  // transition, so a theme deleted or edited on another device kept painting here
  // until the user locked and came back. There is no second subscription for it:
  // `Editor` is mounted for exactly the stage this effect acts on, and its bridge
  // already advances the shared nonce, so reading that nonce is the whole wire.
  const themesNonce = useThemesNonce();

  useEffect(() => {
    if (stageName !== "editor") {
      applyTheme(null);
      // A6: clear the custom accent on lock / every non-editor stage too, so the
      // locked screen never shows the user's chosen accent (device-local UI pref
      // applied only while unlocked — see `lib/accentColor.ts`).
      applyAccent(null);
      return;
    }
    // Paint the device-local accent while unlocked. In-session changes from
    // Settings → Appearance call `applyAccent` directly; this covers the
    // stage-transition path (unlock / vault switch).
    applyAccent(readAccent());
    let cancelled = false;
    void prefsRead()
      .then(async (prefs) => {
        if (cancelled) return;
        // A selected custom theme takes precedence over the built-in
        // Light/Dark/System choice (MYND-297). Read + apply its palette via the
        // CSSOM; on any failure (missing / renamed / invalid file) fall back to
        // the built-in theme rather than leaving the UI un-themed.
        // The custom palette is vault content (`MYT1`). The plain surface
        // renders built-in palettes only, so while it owns the window the
        // custom theme is skipped and the built-in choice is painted instead.
        if (prefs.custom_theme && !plainScreen) {
          try {
            const palette = await readCustomTheme(prefs.custom_theme);
            if (!cancelled) applyCustomTheme(palette);
            return;
          } catch {
            // fall through to the built-in theme
          }
        }
        if (!cancelled) applyTheme(prefs.theme);
      })
      .catch(() => {
        // prefs_read should not reject on the editor stage (slot is unlocked),
        // but if it does, fall back to OS-follow rather than a stale attribute.
        if (!cancelled) applyTheme(null);
      });
    return () => {
      cancelled = true;
    };
  }, [stageName, plainScreen, themesNonce]);

  // Desktop self-update (myne-md/myne#870). Mounted HERE rather than in the
  // editor because the flow outlives the editor: the confirm locks the vault,
  // which moves the Stage off `editor`, and the install's own state has to
  // survive that.
  //
  // `enabled` gates the CHECK, and it is `editor` alone. The flow's own state
  // (`phase`, `view`) is `useState` and survives the move to `updating` on its
  // own, so naming that stage here would be an inert clause a reader has to
  // reason about for nothing.
  //
  // What this gate does NOT reproduce is the three fail-closed takeovers
  // `Editor.tsx` returns instead of its chrome (`StorageLost`, `DeviceRevoked`,
  // the invalid-state guard): those are Editor-internal, so a check can start
  // while one is on screen, where the banner's own mount could not. Destination,
  // payload, cadence and the device-local toggle are unchanged, and
  // `docs/threat-model.md` §7 records the ordinary case ("ten seconds after the
  // editor mounts"), which is what the stage gate is keyed to.
  // The stage as of this render, for the one callback that has to read it
  // synchronously: `onUpdateLocked` computes the transition itself so it can
  // report a refusal rather than assume it landed.
  const stageRef = useRef(stage);
  stageRef.current = stage;
  const onUpdateLocked = useCallback(() => {
    const prev = stageRef.current;
    if (prev === null) return false;
    const next = transition(prev, { type: "editor.update-start" });
    // The transition table refuses this pair from anything but `editor`, and the
    // refusal is reported rather than swallowed: something else left `editor`
    // during the flush (an idle lock, a vault switch), so there is no updating
    // screen to put an install on and the flow must not start one.
    if (next.name !== "updating") return false;
    setStage(next);
    return true;
  }, []);
  const update = useUpdateAvailable({
    enabled: !plainScreen && stage?.name === "editor",
    onLocked: onUpdateLocked,
  });

  // Stage ↔ address bar (MYND-574 task 64). On desktop every call inside is a
  // seam no-op — a window has no back button and opens where the boot probe
  // says, never where a URL says. On web this is what makes back/forward stay
  // inside the app and a note view survive a reload. `src/lib/routing.ts` holds
  // the rules (what pushes, what only replaces, and why a back press is never
  // allowed to un-unlock a vault).
  //
  // `updating` is deliberately handed `null` rather than added to `RouteName`:
  // it is desktop-only (the `selfUpdate` capability is what reaches it), the
  // process is about to be replaced, and a name no client can boot into does
  // not belong in the web client's addressable set. `null` is the hook's
  // "nothing to record" input, so the address bar is simply left alone.
  useStageRoute(
    stage?.name === "updating" ? null : (stage?.name ?? null),
    reprobe,
  );

  if (stage === null) {
    // Loading shim — vault_status probe in flight (~ms on warm disk).
    // Returning null avoids a flash-of-welcome before existing-vault
    // users get routed to unlock.
    return null;
  }

  const dispatch = (action: Action) =>
    setStage((prev) => (prev ? transition(prev, action) : prev));

  const onCreateAutoUnlockSuccess = (vaultId: string | null) => {
    resetPersonIdentityState();
    dispatch({
      type: "create-vault.auto-unlock-success",
      vaultId: vaultId ?? undefined,
    });
  };

  const onCreateAutoUnlockFailed = (vaultId: string | null) => {
    resetPersonIdentityState();
    dispatch({
      type: "create-vault.commit-success",
      vaultId: vaultId ?? undefined,
    });
  };

  // Multi-vault switch handler (MYND-205). Fires the param-less
  // `vault_lock()` (four-surface teardown + `flushIfDirty`, SYNC-8) then
  // dispatches `editor.switch-vault` → `unlock(Exists, vaultId: target)`, so
  // the user lands on the TARGET's unlock screen and types its password
  // (the vault-addressed unlock IPC runs there, SYNC-6). `switchVault` toggles
  // the `switching` "saving…" flag around the lock IPC. Passed to the Editor
  // for the account-chip dropdown (sub-feature 4 task 5) to invoke.
  const onSwitchVault = (targetVaultId: VaultId) => {
    void switchVault(targetVaultId, { onSavingChange: setSwitching, dispatch });
  };

  // The switcher's invitations door (myne-md/myne#911 follow-up). Same teardown
  // and for the same reason `onJoinDeviceFromEditor` states: accepting an
  // invitation materializes and UNLOCKS a member vault, and SYNC-1 zeroizes the
  // open one on the way, so a dialog left over a mounted editor would sit on
  // plaintext whose keys are already gone.
  //
  // Unlike the join, the dialog is not tied to one stage: cancelling it leaves
  // the user on the unlock screen they were just routed to, which is coherent
  // (retype the password), and accepting re-probes, which is the one place that
  // knows whether the new member vault makes this a picker or a single-vault
  // device.
  const onInvitesFromEditor = () => {
    void (async () => {
      await leaveActiveVault({ onSavingChange: setSwitching });
      dispatch({ type: "editor.lock" });
      setInvitesOpen(true);
    })();
  };

  /**
   * The identity home, rendered from BOTH zero-vault stages.
   *
   * `welcome` is the desktop/mobile empty state ("make something"), and
   * `account-entry` is the web one ("tell me which account to pull"). An
   * identity makes the second question moot: a vault born under the person plane
   * has no account number to type, so a browser holding one must land on the
   * home rather than on a sign-in form whose only input it does not have
   * (myne-md/myne#911 task 13). One definition, so the two stages cannot drift.
   */
  const identityHome = () => (
    <IdentityHome
      identityCode={identityCode}
      accountNumber={personAccountNumberValue}
      accountState={personAccountState}
      // A device that holds an identity creating a vault is a FULLY KNOWN
      // destination, so this is the sanctioned out-of-band stage set rather than
      // a transition: the stage table's `create-vault.start` arm means "make an
      // identity", which on the web client's `account-entry` stage sent the user
      // back into the ceremony they had just finished (myne-md/myne#911 review).
      // Ownership is already established here, which is the precondition the
      // ceremony exists to reach.
      onCreateVault={() => setStage({ name: "create-vault", briefing: true })}
      onAccepted={landOnInstalledVault}
      onForgotten={reprobe}
      onRegistered={() => void reprobe()}
    />
  );

  const screen = (() => {
    switch (stage.name) {
      case "account-entry":
        // The web client's zero-vault stage, and since `decisions/sync/0767`
        // it renders the SAME screen desktop does. It used to render
        // `AccountBootstrap`: an account-number field and a password, joined
        // against `sync_join_account`. That door is gone on every client, because a
        // vault arrives by invitation, accepted from the identity home. So the
        // browser's entry is the three identity doors (make one, I was invited,
        // restore a backup) and nothing here asks for an account number.
        //
        // The stage name stays because boot routing and the transition table
        // key on it; what changed is the surface, not the routing question.
        if (personEnrolled) return identityHome();
        return (
          <Welcome
            onStart={() => dispatch({ type: "welcome.start" })}
            // Omitted where the client cannot restore (web answers `Unsupported`
            // to the backup commands), so the row is absent rather than greyed
            // (`decisions.md` 2026-07-26).
            onRestoreBackup={
              has("backup") ? () => dispatch({ type: "welcome.restore-backup" }) : undefined
            }
            onInvited={() => dispatch({ type: "welcome.invited-start" })}
          />
        );
      case "pending-approval":
        // The same screen, entered already-pending (MYND-635). Not a second
        // component: the wait, its approval poll and its SAS comparison are one
        // flow, and splitting them would mean two implementations of "has an
        // approval landed" — which is how the two halves would drift.
        //
        // What this stage adds is that the wait SURVIVES A REFRESH. It used to
        // be React state on this screen, so reloading erased it and boot — which
        // routes on `vault.meta` existence, and the join writes that meta before
        // it enrols — offered the unlock form. The password worked, because the
        // meta is the account's real one, and the vault opened empty.
        return <PendingApproval onSettled={() => void reprobe()} />;
      case "welcome":
        // Identity-only home (myne-md/myne#711): a device that already holds a
        // person account lands here instead of Welcome, so a vault-less member
        // sees their identity and pending invites. Creating a vault is still
        // reachable from the home.
        if (personEnrolled) return identityHome();
        return (
          <Welcome
            // The ONE create door (myne-md/myne#911 task 6). It opens the first
            // run, which creates the identity first and the vault after it; the
            // welcome screen no longer decides between the two.
            onStart={() => dispatch({ type: "welcome.start" })}
            onRestoreBackup={
              has("backup") ? () => dispatch({ type: "welcome.restore-backup" }) : undefined
            }
            // The invited door: the same ceremony, landing on the identity home
            // so the invitation is listed and can be accepted without creating a
            // vault of one's own (myne-md/myne#911 follow-up).
            onInvited={() => dispatch({ type: "welcome.invited-start" })}
          />
        );
      case "first-run":
        // The identity, its one phrase and its type-back, then vault creation
        // (myne-md/myne#911 task 6). Both exits are deliberately different
        // kinds: finishing is a stage action, leaving is a reprobe, because the
        // identity the user just created exists on disk and only boot routing
        // knows what a device holding one should see next.
        return (
          <FirstRun
            // Which door opened the ceremony decides its landing, and only that:
            // the create door continues into vault creation, the invited door
            // re-probes into the identity home (where invitations are listed).
            // `after` is fixed at dispatch time, so this is a constant per mount.
            onIdentityCreated={
              stage.after === "identity-home"
                ? () => void reprobe()
                : () => dispatch({ type: "create-vault.start" })
            }
            onAbandon={() => void reprobe()}
          />
        );
      case "create-vault":
        return (
          <Suspense fallback={null}>
            <CreateVault
              // First-run safety briefing (MYND-114): shown only on the
              // welcome entry (`stage.briefing`), not picker/switcher
              // "create another" — a returning user has acknowledged the
              // recovery model once already.
              withBriefing={stage.briefing ?? false}
              // Back-from-create is reprobe-based (MYND-219 / SYNC-16):
              // boot routing decides the return surface — welcome at 0
              // vaults, the lone vault's unlock at 1, the picker at ≥2.
              onBack={reprobe}
              onAutoUnlockSuccess={onCreateAutoUnlockSuccess}
              onAutoUnlockFailed={onCreateAutoUnlockFailed}
            />
          </Suspense>
        );
      case "unlock":
        return (
          <Unlock
            initialStatus={stage.initialStatus}
            vaultId={stage.vaultId}
            // Back-to-picker affordance. Always wired (the `unlock.back-to-picker`
            // transition is unconditional); <Unlock> itself only SHOWS the link
            // when ≥2 vaults exist, so it also reaches the vault selector after a
            // MANUAL lock or auto-lock — not just when the unlock was picker-
            // reached (`fromPicker`). Previously gated on `fromPicker`, which
            // stranded a multi-vault user on the locked vault's unlock screen with
            // no way back to the picker.
            onBack={() => dispatch({ type: "unlock.back-to-picker" })}
            onUnlocked={() => dispatch({ type: "unlock.success" })}
            onStartRecovery={() => dispatch({ type: "unlock.start-recovery" })}
            onResumeRecovery={() =>
              dispatch({ type: "unlock.resume-recovery" })
            }
            // Post-delete routing is reprobe-based (MYND-219 / SYNC-16):
            // boot routing decides the return surface by remaining vault
            // count — welcome at 0, the lone vault's unlock at 1, the
            // picker at ≥2. A hardcoded `→ welcome` stranded multi-vault
            // users on the create screen. The delete IPC has already
            // resolved (dir gone, slot Empty) before this fires, so the
            // reprobe's `listVaults()` sees the post-delete disk state.
            onDeleteVaultSuccess={reprobe}
            onRestoreBackup={() => dispatch({ type: "unlock.restore-backup" })}
            suspicionReason={stage.suspicionReason}
          />
        );
      case "editor":
        return (
          <Suspense fallback={null}>
            <Editor
              // myne#678: in a detached (pop-out) window this is the one note the
              // window opens (single pane, sidebars collapsed); null in the main
              // window and on web/mobile, where the editor is the full workspace.
              detachedNoteId={detachedId}
              // #250: the authoritative target for every vault-scoped surface
              // inside the editor. `undefined` only on the boot-probe
              // slot-priority entry, where Editor asks the runtime slot
              // directly rather than ordering a best-effort disk cache.
              vaultId={stage.vaultId}
              onResetRequested={reprobe}
              onLock={() => dispatch({ type: "editor.lock" })}
              onForceRelock={setStageWithSuspicion}
              // Reprobe-based post-delete routing (MYND-219 / SYNC-16) — see
              // the Unlock screen's `onDeleteVaultSuccess` above. Deleting the
              // active vault from Settings leaves the slot Empty, so reprobe
              // routes by remaining count (picker at ≥2, unlock at 1, welcome
              // at 0) instead of always landing on the create screen.
              onDeleteVaultSuccess={reprobe}
              onSwitchVault={onSwitchVault}
              // The FIFTH `vaultCreation`-as-proxy site, and the one the
              // 2026-08-15 regate below missed. It is a second-vault door, so
              // it takes `localOnlyVault`'s predicate.
              //
              // Left ungated it became reachable rather than merely wrong: the
              // switcher renders the row whenever this prop is defined, it is
              // not substituted on web, and until this change the row led to
              // the `CreateVault` "unavailable here" stub. Now it leads into
              // the real flow, on a client whose vault id is the constant
              // `paths::web_single_vault_id()`, so the user answers the
              // briefing, types a password, waits out a full Argon2id
              // derivation and is then told `VaultArtifactsPresent`.
              onCreateAnother={
                has("localOnlyVault")
                  ? () => dispatch({ type: "editor.create-vault" })
                  : undefined
              }
              // The invitation notice needs no capability of its own: the hook
              // is gated on `personIdentity` internally and renders no row where
              // that is absent. Passed only with its opener, so a count can never
              // render without a door.
              inviteCount={inviteCount}
              invitesUnavailable={pendingInvites.unavailable}
              onInvites={onInvitesFromEditor}
              onRestoreBackup={() =>
                dispatch({ type: "editor.restore-backup" })
              }
              switching={switching}
            />
          </Suspense>
        );
      case "recover":
        return (
          <Suspense fallback={null}>
            <VaultRecover
              initialSubStep={stage.subStep}
              onCancel={(vaultId) =>
                dispatch({ type: "recover.cancel", vaultId })
              }
              onCompleteSuccess={(vaultId) =>
                dispatch({ type: "recover.complete-success", vaultId })
              }
              // Reprobe-based post-delete routing (MYND-219 / SYNC-16) — see
              // the Unlock screen's `onDeleteVaultSuccess` above.
              onDeleteVaultSuccess={reprobe}
            />
          </Suspense>
        );
      case "picker":
        // ≥2-vault startup surface (MYND-204). The picker fetches its
        // own vault list from `vault_list()` (the `picker` Stage is
        // payload-free). Selecting a row threads the chosen `vaultId`
        // into `picker.select-vault` → unlock(Exists) for that vault; the
        // id rides on the resulting unlock Stage's payload and `<Unlock>`
        // passes it to the vault-addressed `unlock` IPC (task 8, SYNC-6).
        // Under SYNC-1 the backend evicts any prior `Unlocked` entry —
        // lock-on-pick is enforced at the IPC layer, not via an extra
        // Stage hop. "Create another" → `picker.create-vault` → create flow.
        return (
          <VaultPicker
            onSelect={(vaultId) =>
              dispatch({ type: "picker.select-vault", vaultId })
            }
            onCreateAnother={() => dispatch({ type: "picker.create-vault" })}
            onRestoreBackup={() => dispatch({ type: "picker.restore-backup" })}
            inviteCount={inviteCount}
            invitesUnavailable={pendingInvites.unavailable}
            onInvites={() => setInvitesOpen(true)}
          />
        );
      case "updating":
        // The install is running or has failed. `version` is never null here:
        // the stage's only inbound edge is the notice's confirm, which exists
        // only once the check has reported one.
        return (
          <UpdatingScreen
            phase={update.phase === "failed" ? "failed" : "working"}
            version={update.version ?? ""}
            progress={update.progress}
            onRetry={update.retry}
            // Reprobe-based exit (myne-md/myne#870): the vault was locked before
            // the install, so boot routing answers `unlock` on its own and there
            // is no second action to keep in step.
            onBackToUnlock={reprobe}
          />
        );
      case "restore-backup":
        // Pre-unlock-class restore flow (MYND-56). Exit (cancel AND done)
        // is reprobe-based — boot routing decides the return surface, so a
        // successful restore lands on the picker with the new vault row.
        return <RestoreBackup entry={stage.entry} onExit={reprobe} />;
    }
  })();

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100vh" }}>
      {/* The escape hatch from screen-capture protection (myne-md/myne#482).
          FIRST in DOM order, deliberately: it is a skip link, off-screen until
          focused, so being first is what puts it one Tab from a cold launch and
          one Shift+Tab from the autofocused password field on `Unlock`. On
          Windows the protection genuinely works, which is what leaves a
          remote-desktop or magnifier user looking at a black rectangle with the
          account number, the recovery-phrase ceremony and the device-join QR
          behind it.

          Mounted once and WITHOUT a stage predicate. The first revision used
          `stage.name !== "editor"`, reasoning that after unlock the Privacy
          panel carries the same control. That is false on the three screens
          `Editor.tsx` returns before `EditorChrome` (`DeviceRevoked`,
          `StorageLost`, `FailClosedError`), none of which mounts
          `SettingsModal`, and the last of which renders with the vault LOCKED
          and protection forced back on. A predicate kept in step with a screen
          roster nobody enumerates is the failure `useRevealAfterIdleLock` was
          consolidated to fix; unconditional costs one invisible tab stop on the
          editor. Renders nothing where the capability is absent (web has no
          capture affinity to lose). */}
      <ScreenCaptureEscape />
      {/* Skip to content (myne#728, WCAG 2.4.1). SECOND, deliberately: the
          capture escape above keeps the first slot because on Windows that
          window can be a black rectangle whose only way out is that control.
          Editor stage only, and that is not the roster-predicate failure the
          comment above warns about: the target is a REGION, and regions exist
          only on this stage by construction. A pre-unlock screen is one form
          with no chrome to skip past. */}
      {stage.name === "editor" && <SkipToContent />}
      {/* macOS overlay-mode title bar — `tauri.conf.json` sets
          `titleBarStyle: "Overlay"` so the webview extends under the
          traffic-light area. Non-editor stages get this plain 38px window-drag
          strip; the EDITOR owns its own top row (MYND-166): the per-pane tab
          strips + the persistent sidebar ribbon sit in the title-bar row, so
          App renders no strip there.

          Drag uses Tauri's `data-tauri-drag-region` attribute, NOT the
          Chromium-only `-webkit-app-region: drag` (unsupported in WKWebView /
          WebKitGTK); the data attribute is intercepted on all platforms. */}
      {stage.name !== "editor" && HAS_NATIVE_TITLE_BAR && (
        <div
          {...dragRegionProps()}
          style={{
            height: 38,
            flexShrink: 0,
            background: "var(--bg-2)",
            borderBottom: "1px solid var(--line-1)",
            WebkitUserSelect: "none",
            userSelect: "none",
          }}
        />
      )}
      <div
        style={{
          flex: 1,
          minHeight: 0,
          display: "flex",
          flexDirection: "column",
        }}
      >
        {plainScreen ? (
          <Suspense fallback={null}>
            <PlainFileScreen />
          </Suspense>
        ) : (
          screen
        )}
      </div>
      {/* Browser-extension pairing prompt (ext-foundation-handoff task 4,
          TB10). Mounted globally so a connect request from the extension
          surfaces over whatever stage is showing; renders nothing unless the
          core has a pending pairing session. */}
      {/* The single toast surface (#238), hoisted here from `Editor.tsx` by
          myne-md/myne#390. Renders every toast from the central store as one
          shared collapsed stack, and is mounted exactly once, the count has not
          changed, only the depth.

          The depth is the fix. Inside `Editor.tsx` it existed only AFTER unlock,
          so a `toast(...)` from vault creation, from unlock, or from a
          fail-closed takeover drew nothing and reported nothing about having
          drawn nothing. Every pre-unlock surface that wanted to tell the user
          something had therefore grown its own label swap or its own silence,
          which is most of what the clipboard audit found. Above the stage switch,
          those surfaces have somewhere to render. */}
      <Toaster />
      {/* The desktop update notice (myne-md/myne#870). Gated on the editor
          stage rather than mounted by it, for the reason the `useUpdateAvailable`
          call above gives, and it renders nothing once the offer is dismissed or
          the client cannot self-update. */}
      {stage.name === "editor" && !plainScreen && update.view !== null && (
        <UpdateNotice
          view={update.view}
          version={update.version ?? ""}
          notes={update.notes}
          working={update.working}
          blocked={update.blocked}
          onRequestUpdate={update.request}
          onConfirm={update.confirm}
          onCancel={update.cancel}
          onLater={update.later}
          onReopen={update.reopen}
        />
      )}
      <PairingDialog />
      {/* The `myne://open-file` confirmation. Nothing opens until Confirm, and
          the path it shows is the host-resolved canonical one; gate-off links
          never reach the latch, so this renders nothing for them. */}
      {openFileRequest !== null && (
        <OpenFileConfirm
          path={openFileRequest.path}
          onClose={() => setOpenFileRequest(null)}
        />
      )}
      {/* The invitations dialog (myne-md/myne#911 follow-up): the ONE surface on
          which a device that already holds a vault can accept an invitation.
          Mounted over whatever stage is showing, like the join above, because
          its two entries (the picker's row and the switcher's) land differently:
          the picker needs no teardown, the switcher has already run one. */}
      {invitesOpen && (
        <InvitesDialog
          open
          invites={pendingInvites.invites}
          loading={pendingInvites.loading}
          unavailable={pendingInvites.unavailable}
          onClose={() => setInvitesOpen(false)}
          onRetry={pendingInvites.reload}
          onAccepted={(vaultId) => {
            setInvitesOpen(false);
            // The member vault is on disk and unlocked by the accept. The row
            // that was just accepted is dropped by the reload either way.
            pendingInvites.reload();
            landOnInstalledVault(vaultId);
          }}
        />
      )}
      {/* The browser-extension clip dispatch listener (desktop-ingest, MYND-442,
          TB10) is NOT mounted here. It lives inside `Editor.tsx` — within the
          workspace providers — so the success notice's "view" affordance can
          open the newly-clipped note via the workspace note-open. Clips only
          land when the vault is unlocked (the Rust relay short-circuits a locked
          vault before emitting), i.e. exactly when the Editor is mounted, so the
          listener never needs to exist pre-unlock. */}
    </div>
  );
}

export default App;
