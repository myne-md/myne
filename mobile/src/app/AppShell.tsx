import { useCallback, useEffect, useRef, useState } from "react";
import {
  transition,
  initialStageFromProbe,
  type Stage,
  type Action,
  type SlotMap,
  type VaultId,
} from "../lib/stage";
import { listVaults } from "../lib/vault-list";
import { probeSlotKind } from "../lib/vault-slot-kind";
import { lockVault } from "../lib/vault-unlock";
import { awaitingApprovalVerdict } from "../lib/pending-approval";
import { endAgentRun } from "../lib/agent-lifetime";
import { clearAwareness } from "@myne/awareness-store";
import { clearHandoffCaches } from "./vaultHandoff";
import { HAS_TAURI } from "../lib/app-window";
import { clearCustomTheme, paintSelectedCustomTheme } from "../lib/customTheme";
import { useDateTimeDisplaySync } from "../lib/useDateTimeDisplaySync";

import { WelcomeFlow } from "./flows/WelcomeFlow";
import { IdentityFlow } from "./flows/IdentityFlow";
import { JoinFlow } from "./flows/JoinFlow";
import { PendingApprovalFlow } from "./flows/PendingApprovalFlow";
import { CreateVaultFlow } from "./flows/CreateVaultFlow";
import { UnlockFlow } from "./flows/UnlockFlow";
import { RecoverFlow } from "./flows/RecoverFlow";
import { EditorFlow } from "./flows/EditorFlow";
import { PickerFlow } from "./flows/PickerFlow";
import { RestoreBackupFlow } from "./flows/RestoreBackupFlow";
import { Spinner } from "../components";
import { Screen, PhoneColumn } from "../components";
import { ToastHost } from "../components/ToastHost";

/** Synthetic slotMap key for the active (sole-Unlocked under SYNC-1) slot. */
const ACTIVE_SLOT = "active-slot";

/**
 * Which stage a join was launched from → the action its success dispatches
 * (myne-mobile#40). A lookup rather than a `${from}.join-success` template so
 * the three action names stay greppable and the mapping is checked by the
 * `Action` union rather than by contextual template-literal inference.
 */
const JOIN_SUCCESS = {
  welcome: "welcome.join-success",
  picker: "picker.join-success",
  editor: "editor.join-success",
} as const;

/** The stages that offer a door into `JoinFlow` (keys of `JOIN_SUCCESS`). */
type JoinEntry = keyof typeof JOIN_SUCCESS;

/**
 * The real, wired mobile app — a port of the desktop App.tsx Stage machine.
 * Boots from the vault-list + active-slot probes, dispatches `transition`
 * actions, and mounts the functional flow for the current stage. The static
 * design gallery is a separate dev route (see App.tsx).
 */
export function AppShell() {
  // Publish the date/time display settings into the shared store every
  // formatting surface reads (myne-md/myne#609). At the ROOT, and for the same
  // reason `ToastHost` is: `StageSwitch` returns early in several places, so a
  // hook mounted inside it would stop publishing on the stages that return
  // first, and a store that stops being written is indistinguishable from one
  // nobody ever wrote. That was the shape of the original defect.
  useDateTimeDisplaySync();
  return (
    <>
      <StageSwitch />
      {/* The mobile client's one toast surface (myne-md/myne#455), mounted at the
          ROOT rather than inside the editor flow. That placement is the point:
          the desktop client had its `<Toaster />` inside the post-unlock screen,
          so vault creation and unlock could not reach it and grew silences
          instead, and putting mobile's first host anywhere shallower would
          reproduce exactly that. `ShareImportToast` stays where it is, it is a
          single-purpose notice with its own trigger, not a general surface. */}
      <ToastHost />
    </>
  );
}

/**
 * The stage machine itself.
 *
 * Split out of {@link AppShell} only so a root-level surface can be mounted
 * beside it: this function returns early in several places (the join flow, the
 * boot shim) and then returns from a `switch`, so there is no single element to
 * hang a sibling off without restructuring every arm.
 */
function StageSwitch() {
  const [stage, setStage] = useState<Stage | null>(null);
  // The stage `dispatch` reduces from. It mirrors `stage` and is written
  // SYNCHRONOUSLY by `enterStage` — which the functional `setStage(prev => …)`
  // form cannot be, because entering the editor is awaited (the custom palette
  // is painted first), so the reducer's "previous" has to be readable outside
  // React's render cycle. Every write to `stage` goes through `enterStage`, so
  // the two never diverge.
  const stageRef = useRef<Stage | null>(null);
  const probed = useRef(false);
  // Sync-join overlay. Rendered full-screen WHILE the stage stays put; the
  // matching `*.join-success` arm lands the editor from there (MYND-424) — an
  // out-of-band local toggle, like recover's out-of-band entry. The value is the
  // stage the join was launched FROM, not a boolean: the door exists on three
  // surfaces (welcome, picker, the editor's vault switcher — myne-mobile#40) and
  // each dispatches its own success action. `null` = no join in flight.
  const [joinFrom, setJoinFrom] = useState<JoinEntry | null>(null);
  /** The identity-first overlay on the welcome arm (myne-md/myne#768). */
  const [identityOpen, setIdentityOpen] = useState(false);
  // Which step the identity flow opens on (myne-md/myne#932). The first-run
  // screen has two doors and they lead to different steps: create, or the fork
  // that brings an existing identity across. Reset by the overlay's own exit so a
  // later Settings entry lands on the gate it has always used.
  const [identityStart, setIdentityStart] = useState<"gate" | "join-fork" | "create">("gate");
  /**
   * A scanned member-vault QR awaiting the identity flow's join step. Held here
   * rather than inside `JoinFlow` because the join overlay CLOSES when it hands
   * off (see that flow's `onMemberJoin`), so the target has to outlive the flow
   * that read it. `null` = no member-vault QR in flight.
   */
  const [identityFromQr, setIdentityFromQr] = useState<{
    endpointUrl: string;
    accountHashHex: string;
  } | null>(null);
  /**
   * A scanned PERSON QR awaiting the identity flow's person-join step
   * (myne-md/myne#911 task 12). Held here for the same reason
   * `identityFromQr` is: the join overlay closes when it hands off, so the target
   * has to outlive the flow that read it. `null` = no person QR in flight.
   */
  const [personJoinFrom, setPersonJoinFrom] = useState<{
    endpointUrl: string;
    personIdHex: string;
  } | null>(null);

  /**
   * Land a stage — the single writer of `stage` and its ref mirror.
   *
   * **Every entry into the editor stage paints the vault's selected custom
   * palette first** (MYND-598), so the editor's first frame already wears it.
   * The gate lives here rather than on the unlock handler because `stage.ts`
   * reaches `{name:"editor"}` from six transitions — `unlock.success`,
   * `recover.complete-success`, the three `*.join-success` arms and
   * `create-vault.auto-unlock-success` — plus `initialStageFromProbe`'s
   * already-`Unlocked` short-circuit (a WebView reload over a live Rust slot).
   * Recovery in particular opens an EXISTING vault, which can carry both a
   * `custom_theme` selection and the themes it names. One gate covers all of
   * them, including the next route somebody adds.
   *
   * Non-editor stages never reach the `await`, so they still land
   * synchronously — the palette read is the only thing that ever defers a
   * transition.
   */
  const enterStage = useCallback(async (next: Stage | null) => {
    if (next?.name === "editor") await paintSelectedCustomTheme();
    stageRef.current = next;
    setStage(next);
  }, []);

  const boot = useCallback(async () => {
    if (!HAS_TAURI) {
      // Browser dev (pnpm dev, no Tauri host) — no IPC available. Land on
      // welcome so the flows are navigable; real IPC needs `pnpm tauri dev`.
      await enterStage({ name: "welcome" });
      return;
    }
    try {
      const [vaultList, slot] = await Promise.all([listVaults(), probeSlotKind()]);
      const slotMap: SlotMap = { [ACTIVE_SLOT]: slot };
      await enterStage(initialStageFromProbe(vaultList, slotMap));
    } catch {
      // Probe transport failure — fail-closed to welcome (the user can still
      // create/restore; a real vault would surface on the next probe).
      await enterStage({ name: "welcome" });
    }
  }, [enterStage]);

  useEffect(() => {
    if (probed.current) return;
    probed.current = true;
    void boot();
  }, [boot]);

  const dispatch = useCallback(
    (action: Action) => {
      const prev = stageRef.current;
      if (prev === null) return;
      const next = transition(prev, action);
      // `transition` returns `prev` unchanged for an illegal pair; re-landing it
      // would re-run the editor paint for a transition that did not happen.
      if (next === prev) return;
      void enterStage(next);
    },
    [enterStage],
  );

  /** Out-of-band re-probe (back-from-create, restore-backup exit). */
  const reprobe = useCallback(() => {
    void enterStage(null);
    void boot();
  }, [boot, enterStage]);

  /**
   * The approval wait's Cancel, and its idle auto-lock (both land here).
   *
   * Locks first, and that is the difference from the join OVERLAY's Cancel: an
   * overlay closes back to the stage underneath, while this stage has no stage
   * underneath to close to. It holds an unlocked vault, so leaving it without
   * locking would put the user in front of an editor whose keys nobody asked to
   * keep. `reprobe()` after the lock answers `unlock` for this vault, which is
   * exactly the state the device was in before this stage existed.
   *
   * The teardown itself rides `lockVault` (the mobile chokepoint
   * `scripts/check-frontend-lock-teardown.mjs` asserts), so nothing here clears
   * stores by hand.
   */
  const leaveApprovalWait = useCallback(() => {
    void lockVault("manual")
      .catch(() => {})
      .finally(() => reprobe());
  }, [reprobe]);

  // The awaiting-approval verdict (#535), asked ONCE per entry into the editor,
  // after unlock, because it cannot be answered before it: `sync_join_account`
  // writes the account's real meta and unlocks the vault before the enrolment
  // that comes back pending, so a device nobody has approved presents an
  // ordinary container. Routing on that at boot is the deadlock MYND-635 shipped
  // and 0519 removed.
  //
  // `dispatch` is a no-op when the pair is illegal, so a verdict that lands after
  // the user has already locked or switched leaves them where they went rather
  // than dragging them back into the wait.
  useEffect(() => {
    if (stage?.name !== "editor") return;
    let cancelled = false;
    void awaitingApprovalVerdict().then((awaiting) => {
      if (cancelled || !awaiting) return;
      dispatch({ type: "editor.awaiting-approval" });
    });
    return () => {
      cancelled = true;
    };
  }, [stage?.name, dispatch]);

  /**
   * The editor's "create another vault" exit, one of the two vault-leaving paths
   * that do NOT go through `lockVault`: the create -> auto-unlock chain locks the
   * current vault at the IPC layer instead. A named function rather than an inline
   * prop so `scripts/check-frontend-lock-teardown.mjs` can hold it (`mobile-create`)
   * the way it holds `lockVault`; as an inline arrow it was a leaving path no guard
   * could name (myne-md/myne#849 review, D9).
   */
  const leaveForCreateVault = () => {
    // The agent run, as on the join path below and for the #529 reason: the store
    // is module scope, so a proposal holding text copied out of THIS vault's notes
    // would otherwise render in the new vault's AI tab. This exit had the presence
    // clear and not this one, which is the one-path-short shape the guard exists for.
    endAgentRun("lock", "");
    // The presence store: module scope in `@myne/awareness-store`, so without this
    // the previous vault's peers stay resident into the new vault's session.
    clearAwareness();
    // The editor caches that are re-derivable from the vault being left (see
    // `vaultHandoff.ts`): the guard's blanket handoff exemption now covers only
    // the staged conversation write, which the cancelled-join path must keep.
    clearHandoffCaches();
    dispatch({ type: "editor.create-vault" });
  };

  /**
   * The editor's "join an account" exit, the other leaving path that skips
   * `lockVault`: `sync_join_account` unlocks the vault it bootstraps, which evicts
   * this one at the IPC layer (SYNC-1). Named for the guard (`mobile-join`), for
   * the reason `leaveForCreateVault` gives.
   */
  const leaveForJoinAccount = () => {
    endAgentRun("lock", "");
    // The presence store too: this path ends the session at the IPC layer without
    // going through `lockVault`, and a module-scope store outlives every unmount, so
    // the previous vault's peers would otherwise stay resident into the joined one.
    clearAwareness();
    clearHandoffCaches();
    setJoinFrom("editor");
  };

  if (stage === null) {
    return (
      <PhoneColumn>
        <Screen style={{ alignItems: "center", justifyContent: "center" }}>
          <Spinner />
        </Screen>
      </PhoneColumn>
    );
  }

  // The join flow runs full-screen while the stage underneath stays put; on a
  // successful bootstrap it dispatches that stage's `*.join-success` arm →
  // editor, addressed at the joined vault.
  //
  // It sits ABOVE the switch because the door is not a Welcome-only affordance
  // (myne-mobile#40): scoping the overlay to `case "welcome"` made joining an
  // existing account unreachable the moment the device held any vault, since
  // `initialStageFromProbe` only produces `welcome` at zero vaults.
  //
  // Cancel closes the overlay back to the stage it was opened from. It is
  // deliberately NOT `reprobe()`, tempting as the back-from-create precedent is:
  // the SAS-mismatch exit calls `syncResetLocal()`, which clears this device's
  // enrollment but never touches `vault.meta` (see the command's doc in
  // `core/src/plugins/sync/commands.rs`), so a re-probe would route the user
  // straight into the editor of the vault they had just rejected.
  if (joinFrom !== null) {
    return (
      <PhoneColumn>
        <JoinFlow
          onComplete={(vaultId) => {
            setJoinFrom(null);
            dispatch({ type: JOIN_SUCCESS[joinFrom], vaultId });
          }}
          // A recovery-phrase join leaves the vault `Recovering`, so the editor
          // would be a fail-closed screen: land on the chained password reset
          // instead, addressed at the vault this join just bootstrapped.
          onRecovering={(vaultId) => {
            setJoinFrom(null);
            void enterStage({ name: "recover", subStep: "password-reset", vaultId });
          }}
          onCancel={() => setJoinFrom(null)}
          // A scanned member-vault code: this overlay has nothing more to show
          // (no account number to confirm), so it closes and the identity flow
          // opens at the join step for the vault the code named.
          onMemberJoin={(target) => {
            setJoinFrom(null);
            setIdentityFromQr(target);
          }}
          // A scanned person code: same shape, one step over. The credential is
          // the identity phrase and the device lands pending until an existing
          // device approves it, so the wizard for it lives in the identity flow
          // (myne-md/myne#911 task 12).
          onPersonJoin={(target) => {
            setJoinFrom(null);
            setPersonJoinFrom(target);
          }}
        />
      </PhoneColumn>
    );
  }

  // A scanned member-vault QR: the join overlay closed and handed the target
  // here, and the identity flow opens at the join step for that vault. Rendered
  // ABOVE the switch for the same reason the join overlay above is, and the same
  // reason is load-bearing: the door is reachable from picker and editor too, so
  // scoping it to `case "welcome"` would make it unreachable on a device that
  // already holds vaults. `identityOpen` and this never coexist: this returns
  // first, and the welcome arm's own `identityOpen` overlay is untouched.
  if (identityFromQr !== null) {
    return (
      <PhoneColumn>
        <IdentityFlow
          fromQr={identityFromQr}
          onCancel={() => setIdentityFromQr(null)}
          // The member vault is on disk and unlocked by the time the join wizard
          // completes, so close and re-probe exactly as the welcome arm's identity
          // overlay does; the probe decides where the user lands.
          onAccepted={() => {
            setIdentityFromQr(null);
            reprobe();
          }}
        />
      </PhoneColumn>
    );
  }

  // A scanned PERSON QR: the identity flow's person-join wizard, which takes the
  // phrase and waits for an existing device to approve this one
  // (myne-md/myne#911 task 12). Rendered ABOVE the switch for the same reason the
  // two overlays above are: the door is reachable from the picker and the editor
  // too, so scoping it to `case "welcome"` would make it unreachable on a device
  // that already holds vaults.
  if (personJoinFrom !== null) {
    return (
      <PhoneColumn>
        <IdentityFlow
          fromPersonQr={personJoinFrom}
          onCancel={() => setPersonJoinFrom(null)}
          // The join listed the account's vaults and wrote their frames locally,
          // so the probe is what decides where the user lands: the picker when
          // several arrived, that vault's unlock when one did.
          onAccepted={() => {
            setPersonJoinFrom(null);
            reprobe();
          }}
        />
      </PhoneColumn>
    );
  }

  // Every stage except the editor renders inside <PhoneColumn> — on tablets the
  // single-column flows stay a centered phone-width column (no-op on phones);
  // the editor is the adaptive multi-pane surface and fills the window.
  switch (stage.name) {
    case "welcome":
      if (identityOpen) {
        return (
          <PhoneColumn>
            <IdentityFlow
              initialStep={identityStart}
              // The fork's "scan the code" arm hands control back here: the scanner
              // owns the decode and re-enters this flow with `fromPersonQr`.
              onScanCode={() => {
                setIdentityOpen(false);
                setJoinFrom("welcome");
              }}
              // The fork's third row: the account-and-password join this screen's
              // second button used to open directly, kept reachable because a
              // pre-identity account is not an identity (myne-md/myne#932).
              onJoinAccount={() => {
                setIdentityOpen(false);
                setJoinFrom("welcome");
              }}
              onCancel={() => {
                setIdentityOpen(false);
                setIdentityStart("gate");
              }}
              // The identity home's create-vault action, and the exit of the
              // first run (myne-md/myne#911 task 12): the identity exists by the
              // time this is reachable, so the next step of the same chain is the
              // vault. Passed ONLY here, because this is the one entry that knows
              // the device has zero vaults; the Settings entry below leaves it
              // undefined so a device with vaults does not get a second door.
              onCreateVault={() => {
                setIdentityOpen(false);
                dispatch({ type: "create-vault.start" });
              }}
              // An invite was accepted, this device named itself, and the
              // member vault is on disk and unlocked: close the overlay and
              // re-probe, which is how the stage machine decides what the user
              // opens next rather than the identity flow guessing
              // (myne-md/myne#851 tasks 14 and 15). The name step withholds this
              // until a name is saved, so a vault cannot arrive here unnamed.
              onAccepted={() => {
                setIdentityOpen(false);
                reprobe();
              }}
            />
          </PhoneColumn>
        );
      }
      return (
        <PhoneColumn>
          <WelcomeFlow
            // Both doors open the identity flow, at different steps
            // (myne-md/myne#932). The create door keeps the gate it has always
            // had, because the gate is also the only path to "use this device
            // only"; the second door opens the fork that offers the two
            // credentials an existing identity comes with (24 words, or a code
            // from a device that has it). What changed is the LABEL on that second
            // door: it used to say "Connect to my account" and open the QR scanner
            // alone, so a returning user had to walk into the create flow to find
            // their own identity.
            onIdentity={() => {
              setIdentityStart("gate");
              setIdentityOpen(true);
            }}
            onHaveIdentity={() => {
              setIdentityStart("join-fork");
              setIdentityOpen(true);
            }}
          />
        </PhoneColumn>
      );

    case "create-vault":
      return (
        <PhoneColumn>
          <CreateVaultFlow
            briefing={stage.briefing}
            onCancel={reprobe}
            onCommitSuccess={(vaultId?: VaultId) => dispatch({ type: "create-vault.commit-success", vaultId })}
            onAutoUnlockSuccess={(vaultId?: VaultId) => dispatch({ type: "create-vault.auto-unlock-success", vaultId })}
            onAutoUnlockFailed={(vaultId?: VaultId) => dispatch({ type: "create-vault.commit-success", vaultId })}
          />
        </PhoneColumn>
      );

    case "unlock":
      return (
        <PhoneColumn>
          <UnlockFlow
            initialStatus={stage.initialStatus}
            vaultId={stage.vaultId}
            suspicionReason={stage.suspicionReason}
            fromPicker={stage.fromPicker}
            // All three unlock routes — password, PIN, biometric — land here.
            // The custom palette is painted before the editor stage lands; that
            // is `enterStage`'s job, for every route rather than this one.
            onUnlocked={() => dispatch({ type: "unlock.success" })}
            onStartRecovery={() => dispatch({ type: "unlock.start-recovery" })}
            onBackToPicker={stage.fromPicker ? () => dispatch({ type: "unlock.back-to-picker" }) : undefined}
            // The corrupted screen's restore route (audit T6.8). Legal only from
            // `unlock` by the transition table; the FailClosed surface renders the
            // button only on the corrupted case.
            onRestoreBackup={() => dispatch({ type: "unlock.restore-backup" })}
            // #45: reprobe, not a hardcoded → welcome. Boot routing then picks
            // the return surface by REMAINING vault count (picker at ≥2, unlock
            // at 1, welcome at 0); the old arm stranded a multi-vault user on
            // the first-run screen with every other vault hidden. The delete IPC
            // has already resolved here, so the probe reads post-delete disk.
            onDeleteVaultSuccess={reprobe}
          />
        </PhoneColumn>
      );

    case "recover":
      return (
        <PhoneColumn>
          <RecoverFlow
            initialSubStep={stage.subStep}
            initialVaultId={stage.vaultId}
            onComplete={(vaultId?: VaultId) => dispatch({ type: "recover.complete-success", vaultId })}
            onCancel={() => dispatch({ type: "recover.cancel" })}
          />
        </PhoneColumn>
      );

    case "editor":
      return (
        <EditorFlow
          vaultId={stage.vaultId}
          // The palette revert rides `lockVault()` with the other per-vault
          // teardowns, so every route through the lock inherits it (MYND-598).
          onLock={async (reason) => {
            await lockVault(reason === "idle" ? "idle" : "manual").catch(() => {});
            dispatch({ type: "editor.lock" });
          }}
          // Not preceded by `lockVault()`: see `leaveForCreateVault`, which is what
          // the teardown guard holds for this exit.
          onCreateVault={leaveForCreateVault}
          // Not preceded by `lockVault()`, unlike `onSwitchVault`: the join
          // flow's own `sync_join_account` unlocks the vault it bootstraps,
          // which evicts this one at the IPC layer (SYNC-1) — the same posture
          // `onCreateVault` takes toward the create → auto-unlock chain.
          // Same reason as the delete path below: not preceded by `lockVault`,
          // and the vault it bootstraps is a different one.
          onJoinAccount={leaveForJoinAccount}
          onSwitchVault={async (vaultId: VaultId) => {
            await lockVault("switch").catch(() => {});
            dispatch({ type: "editor.switch-vault", vaultId });
          }}
          // Vault deletion is the one exit that does NOT go through `lockVault`
          // (the slot is gone, not locked), so it reverts the palette itself.
          // Deletion is the one exit that does NOT go through `lockVault` (the
          // slot is gone, not locked), so it must end the agent run itself
          // (myne-md/myne#456). The store is module scope and survives every
          // unmount, so without this a proposal holding anchors and replacements
          // copied verbatim out of the DELETED vault's notes stays resident and
          // renders in the next vault's AI tab. That is the myne-md/myne#529
          // shape exactly: a teardown wired to the lock and not to the other
          // vault-leaving path.
          onDeleteVaultSuccess={() => {
            endAgentRun("lock", "");
            // The third leaving path that skips `lockVault`, same reason as the two
            // above (myne-md/myne#849 review). The guarded clear is in
            // `mobile/src/lib/vault-delete.ts::deleteVault` (`mobile-delete`), which
            // runs it BEFORE the delete IPC, and every delete surface on this client
            // reaches this callback only after that function resolved. This second
            // call is belt and braces: it costs nothing, and the screen's half of the
            // moment then does not depend on how the settings sheet reached it.
            clearAwareness();
            clearCustomTheme();
            reprobe(); // #45 — see the unlock surface above
          }}
        />
      );

    case "pending-approval":
      // The wait, resumed (#535). Reached from the editor by the verdict above,
      // never by boot routing: the question needs `root_key` in the slot, so it
      // is asked after unlock. Renders the join flow's own wait and compare —
      // one implementation of "has an approval landed", shared with the overlay
      // entry that a first join uses.
      return (
        <PhoneColumn>
          <PendingApprovalFlow
            vaultId={stage.vaultId}
            onApproved={(vaultId?: VaultId) => dispatch({ type: "pending-approval.approved", vaultId })}
            onCancel={leaveApprovalWait}
          />
        </PhoneColumn>
      );

    case "picker":
      return (
        <PhoneColumn>
          <PickerFlow
            onSelect={(vaultId: VaultId) => dispatch({ type: "picker.select-vault", vaultId })}
            onCreate={() => dispatch({ type: "picker.create-vault" })}
            onJoin={() => setJoinFrom("picker")}
          />
        </PhoneColumn>
      );

    case "restore-backup":
      return (
        <PhoneColumn>
          <RestoreBackupFlow entry={stage.entry} onDone={reprobe} />
        </PhoneColumn>
      );
  }
}
