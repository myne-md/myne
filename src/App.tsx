import { lazy, Suspense, useCallback, useEffect, useRef, useState } from "react";
import { AccountBootstrap } from "./screens/AccountBootstrap";
import { Welcome } from "./screens/Welcome";
import { RestoreBackup } from "./screens/RestoreBackup";
import { CreateVault } from "./screens/CreateVault";
import { Unlock } from "./screens/Unlock";
import { VaultRecover } from "./screens/VaultRecover";
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
import { PairingDialog } from "./components/PairingDialog";
import { JoinDeviceModal } from "./components/sync/JoinDeviceModal";
import { has } from "./platform/capabilities";
import { listVaults } from "./lib/vault-list";
import { probeSlotKind } from "./lib/vault-slot-kind";
import { isPendingApproval } from "./lib/pending-approval";
import { leaveActiveVault, switchVault } from "./lib/vault-switch";
import { prefsRead } from "./lib/prefs";
import { applyTheme, applyCustomTheme } from "./lib/theme";
import { applyAccent, readAccent } from "./lib/accentColor";
import { useStageRoute } from "./lib/routing";
import { HAS_NATIVE_TITLE_BAR, dragRegionProps } from "./screens/titlebar";
import { readCustomTheme } from "./lib/themes";

// Editor (the post-unlock workspace) is the app's heaviest screen — CodeMirror,
// the shared @myne/editor engine, and every code-block language grammar hang off
// it, and it is only ever shown AFTER unlock. A React.lazy boundary keeps that
// whole graph out of the first-load bundle (web bundle budget; same precedent as
// GraphView → GraphCanvas, the app's other lazy boundary).
const Editor = lazy(() => import("./screens/Editor").then((m) => ({ default: m.Editor })));

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

  // "Add this device to an account" — the `JoinDeviceModal` overlay (myne#221).
  //
  // App-level rather than per-screen because three stages offer the same door
  // and the modal is one flow: welcome (the first-run entry, MYND-424), the
  // ≥2-vault picker, and the editor's account-chip switcher. It used to be
  // mounted only inside `Welcome`, and `initialStageFromProbe` produces
  // `welcome` only at ZERO vaults — so the first vault a user created closed
  // the join door for good, with deleting every vault as the sole way back.
  //
  // Kept OUT of the Stage union deliberately: it is a modal over whatever is
  // showing, not a screen, and each entry's landing differs (see `onJoined`).
  // Same shape as the globally-mounted `<PairingDialog />` below — and, like it,
  // substituted away in the web build, where the join door is `AccountBootstrap`
  // and an origin holds exactly one container.
  const [joinOpen, setJoinOpen] = useState(false);

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
      // The third probe (MYND-635) rides in the same `Promise.all` rather than
      // after it: it is another cheap read, independent of the other two, so
      // boot still blocks on the slowest single probe instead of their sum.
      // What it adds is the one fact the other two structurally cannot carry —
      // that a `vault.meta` on disk can belong to a device which has not been
      // approved yet and can therefore read nothing out of it.
      const [vaultList, activeSlotKind, pendingApproval] = await Promise.all([
        listVaults(),
        probeSlotKind(),
        isPendingApproval(),
      ]);
      const slotMap: SlotMap = { [ACTIVE_SLOT_KEY]: activeSlotKind };
      setStage(initialStageFromProbe(vaultList, slotMap, pendingApproval));
    })();
  }, [stage]);

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
        if (prefs.custom_theme) {
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
  }, [stageName]);

  // Stage ↔ address bar (MYND-574 task 64). On desktop every call inside is a
  // seam no-op — a window has no back button and opens where the boot probe
  // says, never where a URL says. On web this is what makes back/forward stay
  // inside the app and a note view survive a reload. `src/lib/routing.ts` holds
  // the rules (what pushes, what only replaces, and why a back press is never
  // allowed to un-unlock a vault).
  useStageRoute(stage?.name ?? null, reprobe);

  if (stage === null) {
    // Loading shim — vault_status probe in flight (~ms on warm disk).
    // Returning null avoids a flash-of-welcome before existing-vault
    // users get routed to unlock.
    return null;
  }

  const dispatch = (action: Action) => setStage((prev) => (prev ? transition(prev, action) : prev));

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

  // The switcher's device-join door (myne#221). Unlike the welcome and picker
  // entries this one runs with a vault OPEN, and the join cannot leave it that
  // way: `sync_join_account` bootstraps AND unlocks a different vault, and
  // SYNC-1 (`set_unlocked_locking_others`) zeroizes the active one on the way.
  // A modal left over a mounted editor would therefore sit on plaintext whose
  // keys are already gone — for the whole `join.pending` wait, which lasts
  // until another device approves.
  //
  // So it takes the same lock-then-route shape as a vault switch: flush +
  // `vault_lock()` behind the existing "saving…" overlay, route to the
  // just-locked vault's unlock screen, and open the modal over THAT. Cancelling
  // therefore lands somewhere coherent (retype the password), and success
  // dispatches `unlock.join-success`.
  const onJoinDeviceFromEditor = () => {
    void (async () => {
      await leaveActiveVault({ onSavingChange: setSwitching });
      dispatch({ type: "editor.lock" });
      setJoinOpen(true);
    })();
  };

  // Where a completed join lands, per the stage that opened the modal. One
  // action per source (the convention `*.create-vault` and `*.restore-backup`
  // already follow), each producing a vault-addressed `editor` stage — the
  // vault is already unlocked by `sync_join_account`, so there is no unlock hop.
  //
  // The default arm cannot be reached by any of the three doors; it reprobes
  // rather than dropping the user somewhere stale if a future entry forgets to
  // add its action.
  const onJoined = (vaultId: string) => {
    setJoinOpen(false);
    const id = vaultId as VaultId;
    switch (stage.name) {
      case "welcome":
        dispatch({ type: "welcome.join-success", vaultId: id });
        return;
      case "picker":
        dispatch({ type: "picker.join-success", vaultId: id });
        return;
      case "unlock":
        dispatch({ type: "unlock.join-success", vaultId: id });
        return;
      default:
        void reprobe();
    }
  };

  const screen = (() => {
    switch (stage.name) {
      case "account-entry":
        // The web client's first-run identity step (tasks 30 + 85). Desktop
        // never reaches this stage — `initialStageFromProbe` only produces it
        // where vault CREATION is absent, i.e. where an empty container means
        // "this browser has not been told which account to pull" rather than
        // "make a new vault".
        //
        // Exit is `reprobe()` rather than a stage action: once the bootstrap
        // has written a container, the flow comes back through the boot probe,
        // which is the same door every other out-of-band completion uses
        // (restore-backup, back-from-create). The probe then finds a `vault.meta`
        // and routes to unlock — or, if this device is still awaiting approval,
        // to `pending-approval` below. Either way this screen never has to know
        // what comes next, and boot routing stays the one place that decides.
        return <AccountBootstrap onBootstrapped={() => void reprobe()} />;
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
        return <AccountBootstrap onBootstrapped={() => void reprobe()} initiallyPending />;
      case "welcome":
        return (
          <Welcome
            onCreateVault={() => dispatch({ type: "create-vault.start" })}
            onRestoreBackup={() => dispatch({ type: "welcome.restore-backup" })}
            // The modal itself is mounted below, over every stage (myne#221) —
            // this screen only opens it. Nothing is unlocked here, so unlike the
            // switcher entry there is nothing to tear down first.
            onJoinDevice={() => setJoinOpen(true)}
          />
        );
      case "create-vault":
        return (
          <CreateVault
            // First-run safety briefing (MYND-114): shown only on the
            // welcome entry (`stage.briefing`), not picker/switcher
            // "create another" — a returning user has acknowledged the
            // recovery model once already.
            withBriefing={stage.briefing ?? false}
            // Back-from-create is reprobe-based (MYND-219 / SYNC-16):
            // boot routing decides the return surface — welcome at 0
            // vaults, the lone vault's unlock at 1, the picker at ≥2.
            // (The former `create-vault.back` → welcome arm stranded
            // picker/editor entrants on Welcome.)
            onBack={reprobe}
            onAutoUnlockSuccess={(vaultId) =>
              dispatch({
                type: "create-vault.auto-unlock-success",
                vaultId: vaultId ?? undefined,
              })
            }
            onAutoUnlockFailed={(vaultId) =>
              dispatch({
                type: "create-vault.commit-success",
                vaultId: vaultId ?? undefined,
              })
            }
          />
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
            onResumeRecovery={() => dispatch({ type: "unlock.resume-recovery" })}
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
              onCreateAnother={() => dispatch({ type: "editor.create-vault" })}
              // "Add this device to an account" in the switcher dropdown
              // (myne#221). Capability-gated here rather than in the switcher so
              // the descriptor is consulted once: a client that holds exactly
              // one container per origin cannot bootstrap a second vault, and
              // an absent capability is OMITTED, never greyed out
              // (`decisions.md` 2026-07-26).
              onJoinDevice={has("vaultCreation") ? onJoinDeviceFromEditor : undefined}
              onRestoreBackup={() => dispatch({ type: "editor.restore-backup" })}
              switching={switching}
            />
          </Suspense>
        );
      case "recover":
        return (
          <VaultRecover
            initialSubStep={stage.subStep}
            onCancel={(vaultId) => dispatch({ type: "recover.cancel", vaultId })}
            onCompleteSuccess={(vaultId) =>
              dispatch({ type: "recover.complete-success", vaultId })
            }
            // Reprobe-based post-delete routing (MYND-219 / SYNC-16) — see
            // the Unlock screen's `onDeleteVaultSuccess` above.
            onDeleteVaultSuccess={reprobe}
          />
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
            onSelect={(vaultId) => dispatch({ type: "picker.select-vault", vaultId })}
            onCreateAnother={() => dispatch({ type: "picker.create-vault" })}
            onRestoreBackup={() => dispatch({ type: "picker.restore-backup" })}
            // "Add this device to an account" (myne#221) — the door that was
            // previously welcome-only, i.e. unreachable the moment a vault
            // existed. Picking a row never unlocked anything, so the modal opens
            // straight over the picker.
            onJoinDevice={() => setJoinOpen(true)}
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
      <div style={{ flex: 1, minHeight: 0, display: "flex", flexDirection: "column" }}>
        {screen}
      </div>
      {/* Browser-extension pairing prompt (ext-foundation-handoff task 4,
          TB10). Mounted globally so a connect request from the extension
          surfaces over whatever stage is showing; renders nothing unless the
          core has a pending pairing session. */}
      <PairingDialog />
      {/* "Add this device to an account" (MYND-424; myne#221 opened it to the
          picker + switcher). Mounted here, over whatever stage is showing,
          because three stages offer the same door and each lands differently —
          see `onJoined` above. The web build substitutes the module away. */}
      {joinOpen && <JoinDeviceModal onCancel={() => setJoinOpen(false)} onJoined={onJoined} />}
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
