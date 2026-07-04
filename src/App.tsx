import { useCallback, useEffect, useRef, useState } from "react";
import { Welcome } from "./screens/Welcome";
import { RestoreBackup } from "./screens/RestoreBackup";
import { CreateVault } from "./screens/CreateVault";
import { Unlock } from "./screens/Unlock";
import { Editor } from "./screens/Editor";
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
import { listVaults } from "./lib/vault-list";
import { probeSlotKind } from "./lib/vault-slot-kind";
import { switchVault } from "./lib/vault-switch";
import { openInNoteFind } from "./editor/find/find-session";
import { prefsRead } from "./lib/prefs";
import { applyTheme, applyCustomTheme } from "./lib/theme";
import { readCustomTheme } from "./lib/themes";

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
      const [vaultList, activeSlotKind] = await Promise.all([
        listVaults(),
        probeSlotKind(),
      ]);
      const slotMap: SlotMap = { [ACTIVE_SLOT_KEY]: activeSlotKind };
      setStage(initialStageFromProbe(vaultList, slotMap));
    })();
  }, [stage]);

  // Out-of-band stage reset for fail-closed recovery (Q5β-1
  // belt+suspenders). Bypasses the transition fn intentionally — the
  // transition fn is for explicit user-driven flow transitions, while
  // "reset to whatever vault_status now says" is a recovery path that
  // doesn't fit a (prev, action) → next mapping. Resets the `probed`
  // ref so the boot-probe useEffect re-runs.
  const reprobe = () => {
    probed.current = false;
    setStage(null);
  };

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

  // Window-level Cmd/Ctrl+F → in-note find (MYND-175). Single owner of the
  // WebView's native-find suppression: preventDefault fires app-wide on every
  // stage (the native find scans the rendered DOM — a different text than the
  // note's canonical markdown — so it must never appear). Opening the bar is
  // gated to an active editor view (registered only on the editor stage), so on
  // non-editor stages the key is swallowed but opens nothing. Deliberately NOT
  // in the CM keymap (a keymap only fires when the editor is focused, leaking
  // native find otherwise) — this listener is the sole owner.
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey)) return;
      if (e.key !== "f" && e.key !== "F") return;
      if (e.shiftKey || e.altKey) return; // leave Cmd+Shift+F / Cmd+Alt+F alone
      e.preventDefault();
      openInNoteFind();
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
      return;
    }
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

  const screen = (() => {
    switch (stage.name) {
      case "welcome":
        return (
          <Welcome
            onCreateVault={() => dispatch({ type: "create-vault.start" })}
            onRestoreBackup={() => dispatch({ type: "welcome.restore-backup" })}
            onJoined={(vaultId) =>
              dispatch({
                type: "welcome.join-success",
                vaultId: vaultId as VaultId,
              })
            }
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
            // Back-to-picker affordance, shown only when this unlock was
            // reached by picking a row on the ≥2-vault picker (MYND-204
            // follow-up: the picker → unlock hop was one-way). Absent on every
            // other entry path — there is no picker to return to.
            onBack={stage.fromPicker ? () => dispatch({ type: "unlock.back-to-picker" }) : undefined}
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
          <Editor
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
            onRestoreBackup={() => dispatch({ type: "editor.restore-backup" })}
            switching={switching}
          />
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
      {stage.name !== "editor" && (
        <div
          data-tauri-drag-region
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
