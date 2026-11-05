import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
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
import { clearApprovalWait, markApprovalWait } from "@myne/client-core/approval-wait";
import { awaitingApprovalVerdict } from "../lib/pending-approval";
import { endAgentRun } from "../lib/agent-lifetime";
import { errKind, scanQr, syncDecodeJoinQr } from "../lib/sync";
import { showToast } from "../components/ToastHost";
import { clearAwareness } from "@myne/awareness-store";
import { clearHandoffCaches } from "./vaultHandoff";
import { HAS_TAURI } from "../lib/app-window";
import { clearCustomTheme, paintSelectedCustomTheme } from "../lib/customTheme";
import { useDateTimeDisplaySync } from "../lib/useDateTimeDisplaySync";

import { WelcomeFlow } from "./flows/WelcomeFlow";
import { IdentityFlow } from "./flows/IdentityFlow";
import type { JoinLanding } from "./flows/types";
import { ApprovalWaitFlow } from "./flows/ApprovalWaitFlow";
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
  const { t } = useTranslation();
  const [stage, setStage] = useState<Stage | null>(null);
  // The stage `dispatch` reduces from. It mirrors `stage` and is written
  // SYNCHRONOUSLY by `enterStage` — which the functional `setStage(prev => …)`
  // form cannot be, because entering the editor is awaited (the custom palette
  // is painted first), so the reducer's "previous" has to be readable outside
  // React's render cycle. Every write to `stage` goes through `enterStage`, so
  // the two never diverge.
  const stageRef = useRef<Stage | null>(null);
  const probed = useRef(false);
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
   * Where an identity-flow accept or join lands.
   *
   * The landing is the flow's answer, not a guess: it names the vaults the wizard
   * put on this device, and whether it left them OPEN.
   *
   * WITH vaults, this device owes its §6.3 compare: a freshly installed vault
   * carries a device the owner still has to admit, so re-probing would land on an
   * ordinary editor (or the unlock form) with the compare never made, and the
   * approving device would sit on "this code appears once the new device finishes
   * its first sync" waiting for a cycle this device was never going to run. That was
   * the reported defect for the accept, and it was still true for the person join
   * because the flow handed nothing back.
   *
   * The wait is only ENTERED when the join left a vault open, because the wait's
   * poll claims a token and the claim needs `root_key` (see `JoinLanding`). A locked
   * joining vault (every person join) is OWED the wait rather than put in front of
   * it: the marker is written now, the probe lands on that vault's unlock form, and
   * the post-unlock verdict (`lib/pending-approval.ts`) routes to the wait as soon
   * as the vault is open. Entering it against a locked vault is an endless spinner,
   * which is the one thing this must not do.
   *
   * Several vaults are all marked and none is entered: the probe answers the picker,
   * and whichever one the user opens carries its own marker into the wait.
   *
   * A second join on a device that already holds these vaults marks them again. That
   * costs one screen rather than locking the user out: a vault this device already
   * synced has a baseline, so its wait shows the code on the first poll instead of a
   * spinner, and the compare screen now carries a Cancel next to the two answers, so
   * the non-destructive exit is one tap. Probing every id here to skip them would buy
   * a saved screen and nothing else.
   */
  const landOnJoinedVaults = useCallback(
    (landing?: JoinLanding) => {
      if (landing === undefined) {
        reprobe();
        return;
      }
      // Written BEFORE the stage, so a later unlock re-enters the wait instead of
      // showing an editor (the join's own answer is the only moment this fact is
      // known without inference).
      for (const vaultId of landing.vaultIds) markApprovalWait(vaultId);
      // `!== 1` rather than `> 1`: a landing with no id cannot be entered, and the
      // probe is the only thing that can decide where to go instead.
      if (landing.holding === "locked" || landing.vaultIds.length !== 1) {
        reprobe();
        return;
      }
      void enterStage({ name: "pending-approval", vaultId: landing.vaultIds[0] });
    },
    [enterStage, reprobe],
  );

  /**
   * Scan a join QR and route it. This is the client's ONLY join door
   * (`decisions/sync/0767`): the account-number form that used to sit behind this
   * scan is gone, so every arrival decodes into one of two wizards in the identity
   * flow and nothing else.
   *
   * A refusal is a toast rather than a screen, because there is no form to stay on:
   * a dismissed scanner is silence, an expired code and a legacy account-number
   * code each say what happened, and a transport fault is distinguished from a bad
   * code (it leaks nothing about the account either way).
   */
  const scanJoinQr = useCallback(async () => {
    try {
      const res = await scanQr();
      if (!res.value) return; // scanner dismissed
      const view = await syncDecodeJoinQr(res.value);
      if (!view.fresh) {
        showToast(t("join.qr.expired"));
        return;
      }
      if (view.kind === "person") {
        setPersonJoinFrom({ endpointUrl: view.endpoint_url, personIdHex: view.person_id_hex });
        return;
      }
      if (view.kind === "member_vault") {
        setIdentityFromQr({
          endpointUrl: view.endpoint_url,
          accountHashHex: view.account_hash_hex,
        });
        return;
      }
      showToast(t("join.qr.legacyAccount"));
    } catch (e) {
      const kind = errKind(e);
      showToast(
        kind === "Unsupported"
          ? t("join.qr.scanUnavailable")
          : kind === "NotAQrJoinPayload"
            ? t("join.qr.invalid")
            : kind === "UnsupportedVersion"
              ? t("join.qr.newerVersion")
              : t("join.qr.scanFailed"),
      );
    }
  }, [t]);

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
  // Hoisted out of the effect so the dep array can name it: `stage` is a union
  // and the narrowing the guard performs does not reach the deps expression.
  const editorVaultId = stage?.name === "editor" ? stage.vaultId : undefined;

  useEffect(() => {
    if (stage?.name !== "editor") return;
    let cancelled = false;
    void awaitingApprovalVerdict(editorVaultId).then((awaiting) => {
      if (cancelled || !awaiting) return;
      dispatch({ type: "editor.awaiting-approval" });
    });
    return () => {
      cancelled = true;
    };
  }, [stage?.name, editorVaultId, dispatch]);

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
   * The editor's "join a vault" exit, the other leaving path that skips
   * `lockVault`: the join installs and unlocks a different vault, which evicts this
   * one at the IPC layer (SYNC-1). Named for the guard (`mobile-join`), for the
   * reason `leaveForCreateVault` gives.
   */
  const leaveForJoinAccount = () => {
    endAgentRun("lock", "");
    // The presence store too: this path ends the session at the IPC layer without
    // going through `lockVault`, and a module-scope store outlives every unmount, so
    // the previous vault's peers would otherwise stay resident into the joined one.
    clearAwareness();
    clearHandoffCaches();
    void scanJoinQr();
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

  // The one join door left: a scanned QR (decisions/sync/0767).
  //
  // There used to be a full-screen account-number form here — server URL, account
  // number, password or 24-word phrase — and it is gone everywhere, so this client
  // has exactly one way in: scan the code the vault's owner shows, prove the
  // identity, accept the invite. The scan is a plain handler rather than an overlay
  // because it no longer has a form to render: it decodes, routes, and gets out of
  // the way.
  //
  // `account` codes are refused with a message rather than routed: they name an
  // account number, which only the removed form could use. A vault born that way
  // is joined today by asking its owner for an invite.

  // A scanned member-vault QR: the scanner handed the target here, and the
  // identity flow opens at the join step for that vault. Rendered ABOVE the switch
  // because the door is reachable from picker and editor too, so scoping it to
  // `case "welcome"` would make it unreachable on a device that already holds
  // vaults. `identityOpen` and this never coexist: this returns first, and the
  // welcome arm's own `identityOpen` overlay is untouched.
  if (identityFromQr !== null) {
    return (
      <PhoneColumn>
        <IdentityFlow
          fromQr={identityFromQr}
          onCancel={() => setIdentityFromQr(null)}
          // The member vault is on disk and unlocked by the time the join wizard
          // completes. The wait is owed, so the wizard's landing routes there
          // (`landOnJoinedVaults`); with no vault there is nothing to wait on and
          // the probe decides where the user lands.
          onAccepted={(landing) => {
            setIdentityFromQr(null);
            landOnJoinedVaults(landing);
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
          // The join listed the account's vaults and wrote their frames locally.
          // One vault means one wait, entered after that vault is unlocked (the
          // frames carry no key, so the wait cannot run yet); several means the
          // picker, and each of them is marked so the wait follows whichever is
          // opened.
          onAccepted={(landing) => {
            setPersonJoinFrom(null);
            landOnJoinedVaults(landing);
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
              // The fork's "scan the code" arm hands control back here, and the
              // scan routes straight into the wizard the code names
              // (`scanJoinQr`). This is the only join door on the client, so the
              // fork has one row for it rather than two doors into one form.
              onScanCode={() => {
                setIdentityOpen(false);
                void scanJoinQr();
              }}
              onCancel={() => {
                setIdentityOpen(false);
                setIdentityStart("gate");
              }}
              // The identity home's create-vault action, and the exit of the
              // first run (myne-md/myne#911 task 12): the identity exists by the
              // time this is reachable, so the next step of the same chain is the
              // vault. Passed ONLY here, because this is the one entry that knows
              // the device has zero vaults; every other entry (the sync repair
              // door, a scanned code) leaves it undefined so a device with vaults
              // does not get a second door to a flow the picker and the editor
              // already own. The identity UNLOCK door is not gated by this
              // (myne-md/myne#1029).
              onCreateVault={() => {
                setIdentityOpen(false);
                dispatch({ type: "create-vault.start" });
              }}
              // An invite was accepted, this device named itself, and the
              // member vault is on disk and unlocked. The flow hands back the
              // vaults it installed, and that landing decides the destination: the
              // approval wait with the §6.3 compare, never a re-probe, because a
              // freshly installed member vault is a device the owner has not
              // admitted yet (`landOnJoinedVaults`). The name step withholds this
              // until a name is saved, so a vault cannot arrive here unnamed.
              onAccepted={(landing) => {
                setIdentityOpen(false);
                landOnJoinedVaults(landing);
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
          // Not preceded by `lockVault()`, unlike `onSwitchVault`: a join
          // installs and unlocks a DIFFERENT vault, which evicts this one at the
          // IPC layer (SYNC-1) — the same posture `onCreateVault` takes toward the
          // create → auto-unlock chain. The flow that does it is the identity
          // flow's wizard; this client has no second join door.
          onJoinAccount={leaveForJoinAccount}
          // The manual door onto the approval wait (#535): the Sync panel's row
          // dispatches the same action the automatic verdict does, so both
          // entries land on ONE screen and the stage's legality table holds it.
          onShowApprovalCode={() => dispatch({ type: "editor.awaiting-approval" })}
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
      // The wait (#535). Two ways in, one screen: the post-unlock verdict above
      // (a device that lost its wait), and a join that just installed a vault
      // (`landOnJoinedVaults`). Never by boot routing: the question needs
      // `root_key` in the slot, so it is asked after unlock.
      return (
        <PhoneColumn>
          <ApprovalWaitFlow
            vaultId={stage.vaultId}
            onApproved={(vaultId?: VaultId) => {
              // The compare matched, so the approval is OBSERVED: retire the
              // join's marker or every later unlock routes back here.
              const approved = vaultId ?? stage.vaultId;
              if (approved !== undefined) clearApprovalWait(approved);
              dispatch({ type: "pending-approval.approved", vaultId });
            }}
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
            onJoin={() => void scanJoinQr()}
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
