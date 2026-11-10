// Sync settings panel (MYND-424/425/426/427) — the in-app hub for the sync
// engine: runtime status + manual sync, this-account device management (add +
// approve + remove), the cold-start "building index" state, and the keep-both
// Conflicts surface. Mounts inside the Editor's SidebarStateProvider, so it reads
// the live note cache for conflict copies. Penpot skipped per the owner
// directive; built against design tokens, mirroring the other Settings panels'
// block / label / helper rhythm.

import { useCallback, useEffect, useRef, useState, type CSSProperties } from "react";
import { useTranslation } from "react-i18next";
import { listen } from "../../platform/event";
import { invoke } from "../../platform/core";
import { SyncStatusIndicator } from "../sync/SyncStatusIndicator";
import { EndpointConfig } from "../sync/EndpointConfig";
import { EnrollDeviceForm } from "../sync/EnrollDeviceForm";
import { BetaTermsConsent } from "../sync/BetaTermsConsent";
import { useBetaTermsGate } from "../../hooks/useBetaTermsGate";
import { IdentitySetupDialog } from "../IdentitySetupDialog";
import { readPublishState, type PublishState } from "../../lib/sync-publish";
import {
  readVaultDoctor,
  type AuthorityCause,
  type VaultDoctor,
} from "../../lib/vault-doctor";
import { personStatus, type PersonStatusView } from "../../lib/personAccount";
import { setPersonIdentityState, usePersonIdentityState } from "../sync/personIdentityState";
import { DeviceManagementPanel } from "../sync/DeviceManagementPanel";
import { MemberRosterPanel } from "../sync/MemberRosterPanel";
import { PersonIdentityUnlock } from "../sync/PersonIdentityUnlock";
import { PersonRegisterDialog } from "../sync/PersonRegisterDialog";
import { DeviceJoinQrDialog } from "../sync/DeviceJoinQrDialog";
import { BuildingIndexState } from "../sync/BuildingIndexState";
import { SyncUsageBlock } from "../sync/SyncUsageBlock";
import { RecoveredNotes } from "../sync/RecoveredNotes";
import { has as hasCapability } from "../../platform/capabilities";
import {
  ConflictsView,
  type ConflictCompare,
} from "../../notes/components/ConflictsView";
import {
  diffWithSegments,
  normalizeConflictPair,
  normalizeForDiff,
} from "../../dialect";
import {
  useSelectedNote,
  conflictRecordsByOriginal,
  UNKNOWN_CONFLICT_ORIGINAL,
} from "../../notes/sidebarState";
import { noteRead } from "../../notes/readNote";
import { noteUpdate } from "../../notes/updateNote";
import { deleteNoteRouted } from "../../notes/deleteNote";
import {
  clearConflictMarkers,
  applyConflictVersion,
  undoConflictVersion,
} from "../../notes/conflictCopy";
import { Button } from "../primitives/Button";
import { IconButton } from "../primitives/IconButton";
import { VISUALLY_HIDDEN } from "../primitives/visuallyHidden";
import { Input } from "../primitives/Input";
import { copyText } from "../../lib/clipboard";
import { writeText as clipboardWriteText } from "../../platform/clipboardManager";
import { toast } from "../toast/toastStore";
import { Toast } from "../Toast";
import { noteList } from "../../notes";
import { useDevices } from "../../hooks/useDevices";
import { useMemberVault } from "../../hooks/useMemberVault";
import { useAccountStatus } from "../../hooks/useAccountStatus";
import { useSyncStatus } from "../../hooks/useSyncStatus";
import { ENROLL_PENDING_NOTICE } from "../../lib/load-bearing-copy";
import { canAddThisDevice } from "../../lib/enroll-gate";
import {
  PANEL_ROOT_STYLE,
  BLOCK_STYLE,
  LABEL_STYLE,
  HELPER_STYLE,
} from "./panel-styles";
import { SettingsTopicPanel } from "./SettingsTabs";
import { SettingRow } from "./SettingRow";
import { SettingsSection } from "./SettingsSection";

const SECTION_TITLE_STYLE: CSSProperties = {
  fontSize: "var(--text-base)",
  fontWeight: "var(--weight-semibold)" as CSSProperties["fontWeight"],
  color: "var(--fg-1)",
};

export interface SyncPanelProps {
  /**
   * The active vault's id. Used for ONE question now — is this vault a MEMBER
   * vault (myne-md/myne)? — which decides whether the account-plane surfaces
   * below describe the vault or the member's own account. `null` while unknown,
   * which reads as "not a member vault" and is the pre-change behaviour.
   */
  vaultId?: string | null;
  /**
   * Raised while this panel has a modal dialog of its own up (the beta terms).
   * The Settings shell stands its global keys down while a child dialog owns
   * the surface — see the child-dialog gating note in `SettingsModal.tsx`.
   */
  onDialogOpenChange?: (open: boolean) => void;
}

/**
 * The named authority causes, in the indicator's own vocabulary. `undefined` for every other
 * detail, which is what keeps the raw failure tag out of product copy. Module scope because it
 * does not vary with props or state, so rebuilding it inside the render body only gives a later
 * edit somewhere to drift from.
 *
 * This is the FALLBACK since myne-md/myne#1003, not the source: the failure class is a lossy
 * projection of `AuthorityMissing` and names two of its causes, while the vault doctor reports
 * the cause itself. It stays for the one case the doctor cannot serve, a failed read, so the
 * panel never goes silent about a failure it can still partly name.
 */
const AUTHORITY_CAUSES: Record<string, string> = {
  identity_locked: "sync.panel.status.authorityIdentityClosed",
  device_key_missing: "sync.panel.status.authorityKeyMissing",
};

/**
 * One sentence per cause the report can name (myne-md/myne#1003).
 *
 * Partial on purpose, and the gaps are two different facts. `no_person_session` is a cycle-level
 * cause that cannot reach a report: a bound device key authors without the phrase, so the
 * verdict names the device instead. `key_missing_while_bound` reuses the sentence the indicator
 * already renders for that class, because it IS that state and one fact gets one sentence.
 */
const AUTHORITY_CAUSE_COPY: Partial<Record<AuthorityCause, string>> = {
  no_head_context: "sync.panel.status.authorityNoHeadContext",
  no_device_id: "sync.panel.status.authorityNoDeviceId",
  no_key_at_rest: "sync.panel.status.authorityNoKeyAtRest",
  key_unreadable: "sync.panel.status.authorityKeyUnreadable",
  no_binding_row: "sync.panel.status.authorityNoBindingRow",
  row_names_different_key: "sync.panel.status.authorityRowNamesDifferentKey",
  row_unverified: "sync.panel.status.authorityRowUnverified",
  key_missing_while_bound: "sync.panel.status.authorityKeyMissing",
};

export function SyncPanel({ vaultId, onDialogOpenChange }: SyncPanelProps = {}) {
  const { t } = useTranslation();
  const ctx = useSelectedNote();
  // `MY01`-only by construction (#422, ASM-6→B): keep-both conflict copies carry
  // the `conflict:`/`conflict_of:` frontmatter, which the sync orchestrator writes
  // ONLY for `MY01` notes — a next-major CRDT note (`NC05`) is reconciled by an
  // automatic merge and never staged as keep-both (ASM-9), so `groups` holds no
  // `NC05` entries and this section is empty in a fully-migrated vault. The
  // calm "updated from another device" hint (`RemoteMergeHint`) is the CRDT-note
  // surface; there is deliberately no dual-model Conflicts view.
  const groups = conflictRecordsByOriginal(ctx.cache);

  // Device roster, lifted here so its poll feeds BOTH the device list and the
  // "Add a device" enroll gate (single source of enrollment truth).
  const devicesHook = useDevices();

  // Which account plane the ACTIVE vault speaks for (myne-md/myne) — the twin of
  // the mobile hook, same file name and same content, so the two clients cannot
  // answer this differently. See its header for why `unknown` is a third state
  // rather than a flavour of `owner`: the owner shape re-offers the destructive
  // reset, so an unresolved probe must render neither side's arms.
  const plane = useMemberVault(vaultId ?? undefined);

  // Plan-free usage projection (MYND-570). Absent (`null`) on a server without
  // the route — self-hosted or older — in which case the block is simply not
  // rendered: no error, no hosted-only concept, no upsell.
  const { status: accountStatus } = useAccountStatus();
  // Whether this device may be enrolled at all is `canAddThisDevice`, shared
  // with mobile (`src/lib/enroll-gate.ts`, myne-md/myne-mobile#38) — the gate
  // was fixed here in MYND-635 and mobile, which keeps its own tree, kept
  // showing the row to an already-syncing phone. One predicate, three clients.
  //
  // `sync_status` is the arbiter rather than the roster, and that is the point:
  // the roster is the thing a pending device cannot read, so asking it "am I
  // pending?" is asking the one source guaranteed to be silent. Status derives
  // the answer from disk — identity persisted, token absent — with no server
  // round trip.
  const { status: syncStatus, syncNow } = useSyncStatus();
  // Which authority half is missing, from the VAULT DOCTOR rather than from the failure class
  // (myne-md/myne#1003). The class is a lossy projection of `AuthorityMissing` and could name two
  // of its causes; the doctor reports the cause itself, so the sentence and the log token agree.
  //
  // Read once per failing state, never on the status beat: one call is an ML-DSA roster
  // verification. The key is the failure TAG rather than the status object, whose identity
  // changes on every poll, so a standing failure is diagnosed once and a changed one re-reads.
  const failingDetail = syncStatus?.state === "error" ? syncStatus.detail : null;
  const [doctor, setDoctor] = useState<VaultDoctor | null>(null);
  useEffect(() => {
    // A stale verdict must not outlive the failure it described, in EITHER direction: a
    // changed failure tag drops the previous report before the next read starts, and a
    // failed read drops it too. Keeping it would make the report outrank the class-based
    // fallback that exists for exactly that case.
    setDoctor(null);
    if (failingDetail === null) return;
    let live = true;
    void readVaultDoctor(invoke)
      .then((report) => {
        if (live) setDoctor(report);
      })
      .catch(() => {
        if (live) setDoctor(null);
      });
    return () => {
      live = false;
    };
  }, [failingDetail]);
  // One line, one derivation, and silence when nothing is missing: a verdict of `device_key` or
  // `person_key` under a failure means the authority is NOT the fault, and rendering an authority
  // sentence there would send the reader after the wrong half.
  const authorityCauseLine = doctor
    ? doctor.authority.state === "missing"
      ? AUTHORITY_CAUSE_COPY[doctor.authority.cause]
      : // An unreadable frame is the same fact as a head context that never built: the vault
        // cannot be read, and the credentials are not the problem. It has its own state so
        // the report never calls it a cause, not so the panel stays silent about it.
        doctor.authority.state === "unknown"
        ? AUTHORITY_CAUSE_COPY.no_head_context
        : undefined
    : failingDetail
      ? AUTHORITY_CAUSES[failingDetail]
      : undefined;
  // The shared person-identity store: the roster's Lock/Forget and this panel's
  // own unlock all write it, so it is the one "is the identity ready for this
  // session" signal.
  const { ready: identityReady, ownerCode: identityOwnerCode } = usePersonIdentityState();
  // The full device-local person status, not just `enrolled`: the Identity block
  // below shows the existing identity (its public code) while it is locked, which
  // `enrolled` alone cannot answer (myne-md/myne#792 follow-up). It is re-probed
  // whenever the shared store changes, so a lock or forget taken in the member
  // roster re-derives the block here instead of leaving a mount-time snapshot
  // claiming the identity is still unlocked (myne-md/myne#831 review).
  const [person, setPerson] = useState<PersonStatusView | null>(null);
  const probePerson = useCallback(() => {
    void personStatus()
      .then((s) => setPerson(s))
      .catch(() => {});
  }, []);
  useEffect(() => {
    probePerson();
  }, [probePerson, identityReady, identityOwnerCode]);
  // After the identity dialog recovers or creates an identity, the session now
  // holds it. Reflect that in the shared identity store (the roster's unlock gate
  // reads it, and without this it stayed on the phrase grid) and kick one cycle
  // so the status dot clears now rather than at the top of the retry ladder.
  const handleIdentityCreated = useCallback(() => {
    void personStatus()
      .then((s) => {
        setPerson(s);
        setPersonIdentityState({
          ready: s.identity_unlocked,
          ownerCode: s.identity_code,
        });
      })
      .catch(() => {});
    void syncNow();
  }, [syncNow]);
  // A device holds an identity if it enrolled a token OR sealed a keypair it can
  // still recover (#780): the latter means "you have an identity, recover it",
  // not "add one".
  const hasIdentity =
    identityReady ||
    identityOwnerCode != null ||
    (person ? person.enrolled || person.sealed_keypair_present : false);
  const identityUnlocked = identityReady || (person?.identity_unlocked ?? false);
  const identityCode = identityOwnerCode ?? person?.identity_code ?? null;
  // Nothing is known until the device-local probe (or the shared store) answers.
  // Rendering the empty state first would flash the "Add an identity" CTA on a
  // device that holds one.
  const identityLoaded = person !== null || identityReady || identityOwnerCode != null;
  // Registration (2026-10-23). The identity home offers this, and it is the only
  // place that did: that screen renders at ZERO vaults, so a user sitting in a
  // vault had no door to register from, and the publish row's own refusal
  // (`PersonNotRegistered`) told them to go to a screen they could not open.
  //
  // `reserved` ONLY. A `pending` device has already registered and is waiting for
  // another device's approval; re-registering mints a second device id (so the
  // owner is asked to approve a row nothing holds any more) and the recovery path
  // self-approves, which would silently skip the wait this panel is describing.
  // The identity home gates on `reserved` for the same reason.
  const [registerOpen, setRegisterOpen] = useState(false);
  const needsRegistration = hasIdentity && person?.state === "reserved";
  // Copy the public identity code. Outcome-only feedback, never the value
  // (`lib/clipboard.ts`), the same arm `MemberRosterPanel` uses
  // (myne-md/myne#818).
  const copyIdentityCode = () => {
    if (!identityCode) return;
    void copyText(clipboardWriteText, identityCode, {
      onSuccess: {
        kind: "toast",
        run: () => {
          setIdentityCopied(true);
          if (identityCopyTimer.current !== null) window.clearTimeout(identityCopyTimer.current);
          identityCopyTimer.current = window.setTimeout(() => {
            setIdentityCopied(false);
            identityCopyTimer.current = null;
          }, 1600);
        },
      },
      onFailure: {
        kind: "toast",
        run: () => toast({ message: t("personIdentityCode.copyFailed"), variant: "error" }),
      },
    });
  };
  const awaitingApproval = syncStatus?.state === "pending";
  const showEnroll = canAddThisDevice(syncStatus?.state);
  // The vault's GENERATION, and the only thing this panel still needs from the
  // publish record (myne-md/myne#974). Publishing itself is automatic: the sync
  // cycle does it the first time it has an endpoint, a registered identity and a
  // person session (`core/src/plugins/sync/publish.rs::publish_if_due`), so there
  // is no control here and no readout, because the vault rows already carry
  // "Device only" and the sync status row carries every failure.
  //
  // What is still needed is `person_born`: the legacy "add this device" form is
  // the VAULT ACCOUNT flow (account number + password), and a person-born vault
  // has no such account (myne-md/myne#911 task 8). Offering the form there would
  // ask for a number that does not exist.
  const [publishState, setPublishState] = useState<PublishState | null>(null);
  const showEnrollForm = showEnroll && publishState?.person_born !== true;
  // Re-read when the identity becomes ready, because that is when the answer can
  // change from "device only" to "published" without anything here being clicked.
  const probePublishState = useCallback(() => {
    void readPublishState()
      .then((s) => setPublishState(s))
      .catch(() => setPublishState(null));
  }, []);
  useEffect(() => {
    probePublishState();
  }, [probePublishState, identityReady]);
  const betaTerms = useBetaTermsGate();
  // The terms dialog, opened from the gate below. Local, and reported up so
  // the Settings shell stops competing for Esc while it is open. The cleanup
  // matters: the shell's flag outlives this panel, so unmounting with the
  // dialog open would leave Esc gated for every later session.
  const [termsOpen, setTermsOpen] = useState(false);
  // The later-add identity door (myne-md/myne#768).
  const [identityOpen, setIdentityOpen] = useState(false);
  // The inline session unlock of an existing identity (myne-md/myne#831): the
  // member roster no longer carries a second phrase grid, so this is the one
  // surface, and the status indicator opens it too.
  const [identityUnlockOpen, setIdentityUnlockOpen] = useState(false);
  // The device-join QR dialog (myne-md/myne#831): an icon in the Devices header
  // rather than a full-width block.
  const [qrOpen, setQrOpen] = useState(false);
  // A member's own-device QR dialog (myne-md/myne) — the same slot, a different
  // producer. Held separately from `qrOpen` so the two can never both be up.
  const [memberQrOpen, setMemberQrOpen] = useState(false);
  // The identity-code copy confirms itself (2026-10-24): the chip's glyph
  // becomes a tick and pops, and the live region below says it out loud. The
  // toast is kept for the FAILURE only, because a chip cannot report "that did
  // not work" by looking happy.
  const [identityCopied, setIdentityCopied] = useState(false);
  const identityCopyTimer = useRef<number | null>(null);
  useEffect(
    () => () => {
      if (identityCopyTimer.current !== null) window.clearTimeout(identityCopyTimer.current);
    },
    [],
  );
  // Any child ModalShell this panel mounts must stand the Settings shell's
  // Escape/keys down while it is up (myne-md/myne#831 added the QR dialog;
  // IdentitySetupDialog was the same latent gap). ModalShell calls
  // `preventDefault` but does not stop propagation, so without this Escape
  // closed the whole Settings modal as well as the child.
  // The member roster owns child dialogs of its own (invite, remove) and reports
  // them here rather than straight to the shell, so this panel stays the ONE
  // writer of the shell's flag and last-writer-wins cannot clear it while a
  // dialog is still up (myne-md/myne#831 review).
  const [rosterDialogOpen, setRosterDialogOpen] = useState(false);
  const childModalOpen =
    termsOpen || identityOpen || qrOpen || memberQrOpen || rosterDialogOpen;
  useEffect(() => {
    onDialogOpenChange?.(childModalOpen);
    return () => onDialogOpenChange?.(false);
  }, [childModalOpen, onDialogOpenChange]);
  // Still roster-derived, because it asks something status cannot: the QR
  // invite is only meaningful for a device the ACCOUNT lists as an approved
  // member, and only the roster knows that.
  //
  // Deliberately NOT on a member vault even though the roster now loads there:
  // this is the OWNER's QR, which carries an account number a member does not
  // have and leads to the `{account# + password}` enroll path a member cannot
  // complete. A member gets their own QR icon below.
  const enrolledHere =
    plane === "owner" &&
    (devicesHook.devices ?? []).some((d) => d.is_current && d.approved && !d.retired);


  const [buildingIndex, setBuildingIndex] = useState(false);
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    let cancelled = false;
    void (async () => {
      try {
        const handle = await listen<{ building: boolean }>(
          "sync://index-building",
          (e) => {
            if (!cancelled) setBuildingIndex(e.payload?.building ?? true);
          },
        );
        if (cancelled) handle();
        else unlisten = handle;
      } catch {
        // Not inside Tauri → no index-building channel.
      }
    })();
    return () => {
      cancelled = true;
      if (unlisten) unlisten();
    };
  }, []);

  const refreshSidebar = useCallback(async () => {
    try {
      const ids = await noteList();
      await ctx.refreshAll(ids);
    } catch {
      // Sidebar stays as-is until the next refresh — non-fatal.
    }
  }, [ctx]);

  // Compare (MYND-334): read both sides, normalize away the sync bookkeeping
  // (`updated:` + the injected `conflict:` markers — otherwise every conflict
  // opens on frontmatter the user never wrote), and hand the diff to the view.
  // Reading happens here rather than in `ConflictsView` so that view stays pure.
  const [compare, setCompare] = useState<ConflictCompare | null>(null);
  // Opening a second comparison while the first is still reading must not let
  // the stale resolve paint over the newer one.
  const compareSeq = useRef(0);

  const handleCompare = useCallback((copyId: string, originalUuid: string) => {
    const seq = ++compareSeq.current;
    setCompare({ status: "loading", copyId, originalUuid });
    void (async () => {
      try {
        if (originalUuid === UNKNOWN_CONFLICT_ORIGINAL) {
          // Orphan copy: no original survives to diff against, so show the copy
          // itself rather than fabricating an empty left-hand side.
          const copyText = normalizeForDiff(await noteRead(copyId));
          if (seq === compareSeq.current) {
            setCompare({ status: "orphan", copyId, originalUuid, copyText });
          }
          return;
        }
        const [mineRaw, theirsRaw] = await Promise.all([
          noteRead(originalUuid),
          noteRead(copyId),
        ]);
        const { mine, theirs } = normalizeConflictPair(mineRaw, theirsRaw);
        if (seq === compareSeq.current) {
          setCompare({
            status: "ready",
            copyId,
            originalUuid,
            diff: diffWithSegments(mine, theirs),
          });
        }
      } catch {
        if (seq === compareSeq.current) {
          setCompare({ status: "error", copyId, originalUuid });
        }
      }
    })();
  }, []);

  const handleCloseCompare = useCallback(() => {
    compareSeq.current++;
    setCompare(null);
  }, []);

  // Keep-both: the conflict copy becomes an ordinary note (clear its
  // `conflict:` / `conflict_of:` markers, write the new version), then refresh
  // so it re-enters the live sidebar.
  const handleKeepBoth = useCallback(
    (copyId: string) => {
      handleCloseCompare();
      void (async () => {
        try {
          const content = await noteRead(copyId);
          // `content` is this write's base, so a live session merges rather than
          // being replaced (myne-md/myne#849).
          await noteUpdate(copyId, clearConflictMarkers(content), undefined, content);
          await refreshSidebar();
        } catch {
          // Surfaced via the unchanged Conflicts list — the user can retry.
        }
      })();
    },
    [refreshSidebar, handleCloseCompare],
  );

  // Discard: delete the conflict copy. Routed so that under sync it tombstones
  // (propagates + no resurrection) instead of a bare unlink.
  const handleDiscard = useCallback(
    (copyId: string) => {
      handleCloseCompare();
      void (async () => {
        try {
          await deleteNoteRouted(copyId);
          await refreshSidebar();
        } catch {
          // Non-fatal — the copy stays listed until the next refresh.
        }
      })();
    },
    [refreshSidebar, handleCloseCompare],
  );

  // Take theirs ("Use this version", MYND-452): promote the remote copy to the
  // surviving note and tombstone the local original. A result toast offers Undo.
  // The toast is local to this panel (rendered below) — it floats above the
  // Settings modal (fixed, z-index 1100), so no Editor↔modal plumbing is needed.
  const [takeTheirsPending, setTakeTheirsPending] = useState<{
    copyId: string;
    originalUuid: string;
  } | null>(null);

  const handleTakeTheirs = useCallback(
    (copyId: string, originalUuid: string) => {
      // Defensive: `conflictRecordsByOriginal` groups an orphan copy (no
      // `conflict_of:`) under the UNKNOWN_CONFLICT_ORIGINAL sentinel; ConflictsView
      // already suppresses the take-theirs button there, so this only guards a
      // direct/programmatic call — there's no real original to trash.
      if (originalUuid === UNKNOWN_CONFLICT_ORIGINAL) return;
      handleCloseCompare();
      void (async () => {
        try {
          await applyConflictVersion(copyId, originalUuid);
          await refreshSidebar();
          setTakeTheirsPending({ copyId, originalUuid });
        } catch {
          // Non-fatal — the copy stays listed until the next refresh.
        }
      })();
    },
    [refreshSidebar, handleCloseCompare],
  );

  const handleUndoTakeTheirs = useCallback(() => {
    const pending = takeTheirsPending;
    if (pending === null) return;
    setTakeTheirsPending(null);
    void (async () => {
      try {
        await undoConflictVersion(pending.copyId, pending.originalUuid);
        await refreshSidebar();
      } catch {
        // Non-fatal — the user can reconcile manually from the list.
      }
    })();
  }, [takeTheirsPending, refreshSidebar]);

  return (
    <div style={PANEL_ROOT_STYLE} data-testid="settings.sync-panel">
      {/* **Connection**: this device's account and the server it talks to.
          The identity block leads it because whether this device holds a person
          identity is the question that decides what any of the rest can do.

          Migration is the last block of this topic rather than a topic of its
          own. It is a real concern, but it renders only where the vault is still
          v0.1 or has an unsettled `legacy/` snapshot, and a vault created today
          has neither: the strip draws the roster rather than the filtered set,
          so a tab for it would be an empty body on nearly every install. What it
          upgrades is what leaves this device for the server, which is this
          topic's own subject.

          Each topic's body keeps the indentation of the code it replaced, the
          convention the AI panel set, so the diff is about which rows moved. */}
      <SettingsTopicPanel panelId="sync" topicId="connection">
      {/* Two sections (myne-md/myne#885): this device's account (its identity
          and what it uses) against the server it talks to. The server section's
          only content today is the vault migration, which upgrades what this
          device sends the server, so the section is gated WITH that one block
          rather than drawn around it: `SettingsSection` renders its heading and
          accent rule unconditionally, so an ungated section would show a title
          above nothing on a v0.2 vault and on web. */}
      <SettingsSection title={t("sync.panel.sections.account")}>
      {/* Identity block (myne-md/myne#768). Shown wherever the IDENTITY plane
          exists: with no identity on this device it offers to add one; with an
          identity it shows THAT identity (its public code) and, while the private
          identity is locked for the session (decisions/protocol/0612), the unlock
          action. Before, the block vanished once an identity existed, so a locked
          identity had no surface here at all (myne-md/myne#792 follow-up).

          **Gated on `personIdentity`, not `memberSharing`** (myne-md/myne#911
          task 13). One flag used to cover both planes, so a client that shipped
          the identity could not have it without also shipping the member surface.
          Web is now exactly the case that flag could not express: the identity
          plane dispatches there, and the roster, the invites, member names and
          the device-binding map still do not. */}
      {hasCapability("personIdentity") && identityLoaded && (
        // A `SettingRow` (myne-md/myne#885 visual pass): the actions sit in the
        // control slot on the right, side by side, and the phrase entry the
        // unlock needs is a dialog rather than 24 cells expanded under the row.
        // The helper is the row's readout, so each state keeps its own testid
        // on it.
        <SettingRow
          anchorId="sync.identity"
          label={t("sync.panel.identity.label")}
          helper={
            !hasIdentity
              ? t("sync.panel.identity.helper")
              : needsRegistration
                ? // A `reserved` identity is NOT “locked and waiting”: it has
                  // never been written to a server, so there is nothing it
                  // could sign yet, and the old sentence sent the reader to the
                  // unlock door first (2026-10-25 owner report: “I created it
                  // with the identity, why register again”). One fact, said
                  // once, and it names the act the button beside it performs.
                  t("sync.panel.identity.unregisteredHelper")
                : identityUnlocked
                  ? t("sync.panel.identity.unlockedHelper")
                  : t("sync.panel.identity.lockedHelper")
          }
          {...(hasIdentity
            ? {
                helperTestId: needsRegistration
                  ? "sync.panel.identity-unregistered"
                  : identityUnlocked
                    ? "sync.panel.identity-unlocked"
                    : "sync.panel.identity-locked",
              }
            : {})}
          control={
            // A `reserved` identity has no Unlock control, and that is the
            // correction rather than a tidy-up: Register (`person_register`)
            // installs the person session itself, so the two doors asked for the
            // same 24 words while only one of them led anywhere. Publishing
            // refuses a reserved identity with `PersonNotRegistered`, the invite
            // list needs a token, and the sync cycle needs a token, so an unlock
            // on its own changed nothing a user could see.
            identityUnlocked || needsRegistration ? null : (
              <div style={{ display: "flex", gap: "var(--space-2)", alignItems: "center" }}>
                {!hasIdentity && (
                  <Button
                    variant="secondary"
                    onClick={() => setIdentityOpen(true)}
                    data-testid="sync.panel.add-identity"
                  >
                    {t("sync.panel.identity.cta")}
                  </Button>
                )}
                {/* Derive the identity from an existing phrase without a server
                    round trip; the add dialog can only recover with an
                    endpoint, because it registers the person account. */}
                <PersonIdentityUnlock
                  open={identityUnlockOpen}
                  onOpenChange={setIdentityUnlockOpen}
                />
              </div>
            )
          }
        >
          {/* A locked identity still shows its public code, with the copy chip
              at the end of the box (myne-md/myne#818). A `reserved` one shows it
              too: the code is public and stable, so writing it down now is what
              makes an invitation addressable the moment the identity reaches a
              server. */}
          {hasIdentity && !identityUnlocked && identityCode ? (
            <div style={{ display: "flex", gap: "var(--space-2)", alignItems: "center" }}>
              <Input
                readOnly
                mono
                aria-label={t("common.youridentitycode")}
                value={identityCode}
                data-testid="sync.panel.identity-code"
                style={{ flex: 1, minWidth: 0, userSelect: "all" }}
                onFocus={(e) => e.target.select()}
              />
              <IconButton
                icon="copy"
                label={t("personIdentityCode.copy")}
                bordered
                tooltip
                confirmed={identityCopied}
                onClick={copyIdentityCode}
                testId="sync.panel.copy-identity"
              />
              <p
                role="status"
                aria-live="polite"
                data-testid="sync.panel.copy-status"
                style={VISUALLY_HIDDEN}
              >
                {identityCopied ? t("personIdentityCode.copied") : ""}
              </p>
            </div>
          ) : null}
          {/* What the code is, beside the code itself (myne-md/myne-ops#54).
              The identity home carried this sentence and this box did not, so
              the one place a reader is most likely to think "this looks like a
              secret, should I be pasting it into a message?" was the one place
              that did not answer. Same key as the home: one sentence, one
              meaning, and `identityHome.shareCodeHint` already names the
              distinction that matters (public material, never the phrase). */}
          {hasIdentity && !identityUnlocked && identityCode ? (
            <p style={HELPER_STYLE} data-testid="sync.panel.identity-code-hint">
              {t("identityHome.shareCodeHint")}
            </p>
          ) : null}
          {/* Registration, where the need appears (2026-10-23). A `reserved`
              identity has sent nothing and a `pending` one has no token, so
              neither can be invited, published under, or found. The identity
              home is the only other place this act exists and it renders at zero
              vaults; this block is the one a user with a vault is looking at.

              The act itself is the shared DIALOG (2026-10-24), not a block that
              expands in this row: it asks which server the identity is written
              to before it asks for the phrase, and that is one component so the
              two doors cannot answer it differently. */}
          {needsRegistration ? (
            <div>
              <Button
                variant="secondary"
                data-testid="sync.panel.register-cta"
                onClick={() => setRegisterOpen(true)}
              >
                {t("common.registerthisidentity")}
              </Button>
              <PersonRegisterDialog
                open={registerOpen}
                testIdPrefix="sync.panel.register"
                onRegistered={() => {
                  setRegisterOpen(false);
                  // Re-probe rather than assume: the lifecycle is DERIVED from
                  // disk, and this panel's block is the thing being re-rendered.
                  // The cycle kick clears the status dot without waiting for the
                  // retry ladder.
                  probePerson();
                  void syncNow();
                }}
                onClose={() => setRegisterOpen(false)}
              />
            </div>
          ) : null}
        </SettingRow>
      )}

      <div style={BLOCK_STYLE} data-setting-anchor="sync.server" data-setting-row="true">
        <span style={LABEL_STYLE}>{t("sync.panel.server.label")}</span>
        {/* The server helper now renders inside EndpointConfig, directly under
            the input and before the fingerprint block (E4a). */}
        <EndpointConfig />
      </div>

      <div style={BLOCK_STYLE} data-setting-anchor="sync.status" data-setting-row="true">
        <span style={LABEL_STYLE}>{t("sync.panel.status.label")}</span>
        <SyncStatusIndicator
          // A `reserved` identity's “not enrolled” is not a missing enrolment, it
          // is a registration that never happened, and the panel says so in the
          // row directly above. Two words for one state is how a reader concludes
          // the app wants two separate acts from them (2026-10-25).
          notRegistered={needsRegistration}
          onUnlockIdentity={
            // Same plane as the identity block above, so the same gate: the
            // unlock action opens the identity's own prompt, which needs no
            // member surface (myne-md/myne#911 task 13). Withheld on a `reserved`
            // identity for the reason the control slot states: there is nothing
            // an unlock alone could enable.
            hasCapability("personIdentity") && !needsRegistration
              ? () => setIdentityUnlockOpen(true)
              : undefined
          }
        />
        <BuildingIndexState building={buildingIndex} />
        <p style={HELPER_STYLE}>{t("sync.panel.status.helper")}</p>
        {/* One line naming WHICH authority problem this is, from the VAULT DOCTOR's cause rather
            than from the failure class (myne-md/myne#1003, finishing the deferral this comment
            carried since #983). The class names two causes out of nine; the doctor names the one
            that is true, and it is derived beside the same status the indicator renders, so the two
            cannot disagree. Nothing renders when the doctor says the authority is present: the
            failure is then a different half, and an authority sentence would send the reader after
            the wrong one. The five facts themselves live in the diagnostics block, which is what a
            bug report needs, and the panel owes the answer rather than the table. */}
        {authorityCauseLine && (
          <p style={HELPER_STYLE} data-testid="sync.authority-verdict">
            {t(authorityCauseLine)}
          </p>
        )}
      </div>

      {/* The plane has to be KNOWN before either label is chosen: `unknown` would
          otherwise print the owner's "Storage and devices" over the member's
          numbers, or the reverse. */}
      {accountStatus !== null && plane !== "unknown" && (
        <div style={BLOCK_STYLE}>
          <span style={LABEL_STYLE}>
            {t(
              plane === "member"
                ? "sync.panel.usage.memberLabel"
                : "sync.panel.usage.label",
            )}
          </span>
          <SyncUsageBlock status={accountStatus} showStorage={plane === "owner"} />
          <p style={HELPER_STYLE}>
            {t(
              plane === "member"
                ? "sync.panel.usage.memberHelper"
                : "sync.panel.usage.helper",
            )}
          </p>
        </div>
      )}
      </SettingsSection>

      </SettingsTopicPanel>

      {/* **Devices and members**: what is enrolled on this account, what may be
          added, and who the vault is shared with. The two capability-gated
          roster blocks sit here rather than in a topic of their own, for the
          reason the identity block is gated at all: a roster needs a
          person-identity carrier, and on a client without one a topic holding
          only them would draw a tab whose body is empty. */}
      <SettingsTopicPanel panelId="sync" topicId="devices">
      {/* Two sections (myne-md/myne#885): the devices on this account (adding
          one, the roster, the member each device is claimed by) against the
          people the vault is shared with. */}
      <SettingsSection
        title={t("sync.panel.sections.devices")}
        // The device-join action is an icon-only `+` on the section seam, which
        // REVERSES the 2026-10-25 decision recorded here before ("it looks as if
        // a vault is being added"). The owner asked for the icon back on
        // 2026-10-29, and the two reports are answered by WHERE it sits rather
        // than by labelling it: on the seam, beside "Devices on your account",
        // the `+` is scoped by the heading immediately to its left, which is
        // exactly what a plus floating over the first row could not do. The
        // earlier objection ("it had to be hovered to learn what it added") is
        // met without hover: `aria-label` names it, `tooltip` shows the same
        // words on hover or keyboard focus, and `bordered` makes it read as a
        // control rather than a decoration. The heading above the old labelled
        // button already said "devices", so the word beside the button was the
        // duplication (myne-md/myne#945 item 06).
        action={
          enrolledHere && publishState?.person_born === true ? (
            // The owner arm needs an ENROLLED device to show a code for another
            // one, and it needs a PERSON-BORN vault to have a person code to
            // show. The member arm needs the member plane. The two never render
            // together, so one slot carries one action.
            //
            // `person_born === true` rather than `!== false` is the deliberate
            // half: while `publishState` is still null the button is absent
            // rather than wrong, and a vault that is not person-born gets no QR
            // at all. It used to get the `account` variant, and that variant now
            // produces a code nothing can scan (both clients that could lost
            // their join forms, `decisions/sync/0767`). Its path is the
            // account-number form below, which is the only one an account-keyed
            // vault has: there is no person to invite a device to.
            <IconButton
              icon="plus"
              label={t("sync.deviceJoinQr.title")}
              tooltip
              bordered
              onClick={() => setQrOpen(true)}
              testId="sync.device-join-qr.open"
            />
          ) : plane === "member" ? (
            // A member's own-device QR: no pasted account number, because it
            // describes the shared vault this device is already a member of.
            <IconButton
              icon="plus"
              label={t("sync.memberJoinQr.title")}
              tooltip
              bordered
              onClick={() => setMemberQrOpen(true)}
              testId="sync.member-join-qr.open"
            />
          ) : undefined
        }
      >
      {/* The ACCOUNT model in one sentence, above the controls that act on it.
          Without it the section reads as a list of vault participants: the reader
          has to infer whether a device is added to this vault or to the person.
          It is added to the person, and that is the one fact this surface owed
          (2026-10-25, `decisions/protocol/0731`). */}
      <p style={HELPER_STYLE}>{t("sync.panel.devices.helper")}</p>
      {/* The beta-terms gate (myne-ops#15). One of three doors that turn sync
          on, and the gate stands in front of each — a consent screen at one
          door is not a consent screen.

          While the answer is still being read (`pending`) neither the gate nor
          the form renders: showing the form first and replacing it a frame
          later reads as a glitch, and showing the gate first would flash it at
          someone who accepted months ago. It is one local read.

          The terms are a DIALOG, and the gate is what stands in the form's
          place until they are accepted. The form is not merely covered — it is
          not rendered — so dismissing the dialog cannot reveal a route past the
          text it was asking about. */}
      {showEnrollForm && !betaTerms.pending && (
        <div style={BLOCK_STYLE} data-setting-anchor="sync.add-device" data-setting-row="true">
          <span style={SECTION_TITLE_STYLE}>
            {t("sync.panel.addDevice.label")}
          </span>
          <p style={HELPER_STYLE}>{t("sync.panel.addDevice.helper")}</p>
          {betaTerms.needed ? (
            <div style={{ marginTop: "var(--space-2)" }}>
              <Button
                variant="primary"
                data-testid="sync.beta-terms.open"
                onClick={() => setTermsOpen(true)}
              >
                {t("sync.betaTerms.review")}
              </Button>
            </div>
          ) : (
            <EnrollDeviceForm />
          )}
        </div>
      )}

      <DeviceJoinQrDialog
        open={memberQrOpen}
        onClose={() => setMemberQrOpen(false)}
        variant="member"
      />

      {/* What that form is replaced BY for a device that is already waiting
          (MYND-635). Stating the situation rather than offering an action,
          because there is no action to take here: approval happens on another
          device, and the only button this screen could honestly show would
          create a second pending record.

          The sentence is `ENROLL_PENDING_NOTICE`, rendered verbatim from
          `@myne/copy` — the same literal `EnrollDeviceForm` and the web entry
          screen already show. Not an i18n key: `scripts/check-i18n.mjs` derives
          the load-bearing list from those exported constants and fails if one
          appears as a catalog value, precisely so this sentence cannot acquire
          24 machine-filled variants. */}
      {awaitingApproval && (
        <div style={BLOCK_STYLE} data-testid="sync.panel.awaiting-approval">
          <span style={SECTION_TITLE_STYLE}>
            {t("sync.panel.awaitingApproval.label")}
          </span>
          <p style={HELPER_STYLE}>{ENROLL_PENDING_NOTICE}</p>
        </div>
      )}

      <div style={BLOCK_STYLE} data-setting-anchor="sync.devices" data-setting-row="true">
        {/* The only approval a new device can wait for is reached from the rows
            below: a device that joined with the identity phrase appears there,
            and `DeviceManagementPanel` carries the `Approve` action, which a
            device that HOLDS the identity performs, plus the code compare that
            follows it. The two-sided admission ceremony stood here until
            myne-md/myne#956; it was withdrawn because its joining arm needs this
            device's identity, which only the phrase gives, so it ran after that
            path rather than replacing it (`decisions/protocol/0764`). */}
        <DeviceManagementPanel hook={devicesHook} plane={plane} />
      </div>

      {/* The B2B member roster (myne-md/myne#698): the membership extension's
          member rows for the unlocked shared vault. Omitted on a client without
          the capability (web has no person-identity carrier), per the
          absent-not-disabled rule; the empty arm covers a single-account vault.
          NOT gated on `enrolledHere`: the roster is a property of the unlocked
          VAULT (read from `vault.meta` under `root_key`), not of this device's
          account enrollment, so a vault can carry members before this device
          joins the account roster. */}
      </SettingsSection>

      {/* The member roster needs a capability, which is the absent-not-disabled
          rule: on the web client there is no person-identity carrier, so it
          does not render at all.

          **No outer section here** (myne-md/myne#885 visual pass). The roster
          brings its own sections (identity, members, invitations), so wrapping
          it in a `Members` section drew "Members" three times: the outer
          heading, the block's own "Vault members" title, and the roster's inner
          heading. It is a section of its own instead, at one level.

          The separate `MEMBER DEVICES` block that used to sit here is gone
          (myne-md/myne#976): it listed every device in the vault with the member
          who claimed it, offered no action on anyone else's row, and duplicated
          on a fourth surface what the roster and the two device lists above
          already say. Its two useful facts moved INTO the roster, which is where
          a reader already looks: a device count beside each member, and one
          section line when a claim did not verify. */}
      {hasCapability("memberSharing") && (
        <div data-setting-anchor="sync.members" data-setting-row="true">
          <MemberRosterPanel
            onDialogOpenChange={setRosterDialogOpen}
          />
        </div>
      )}
      </SettingsTopicPanel>

      {/* **Conflicts**: the two surfaces that exist because something went
          wrong, and they are one story from two ends - a keep-both copy that
          has not been reconciled, and one that has. Recovery sits with the
          conflict list rather than earning a tab, which it could not fill. */}
      <SettingsTopicPanel panelId="sync" topicId="conflicts">
      <div style={BLOCK_STYLE} data-setting-anchor="sync.conflicts" data-setting-row="true">
        <span style={SECTION_TITLE_STYLE}>
          {t("sync.panel.conflicts.label")}
        </span>
        <p style={HELPER_STYLE}>{t("sync.panel.conflicts.helper")}</p>
        <ConflictsView
          groups={groups}
          onKeepBoth={handleKeepBoth}
          onDiscard={handleDiscard}
          onTakeTheirs={handleTakeTheirs}
          onCompare={handleCompare}
          compare={compare}
          onCloseCompare={handleCloseCompare}
        />
      </div>

      <div style={BLOCK_STYLE} data-setting-anchor="sync.recovered" data-setting-row="true">
        <span style={SECTION_TITLE_STYLE}>
          {t("sync.panel.recovered.label")}
        </span>
        <p style={HELPER_STYLE}>{t("sync.panel.recovered.helper")}</p>
        <RecoveredNotes onRestored={refreshSidebar} />
      </div>
      </SettingsTopicPanel>

      {/* The panel's child dialogs and its toast stay OUTSIDE the topic bodies,
          so a dialog opened from one topic is not unmounted by moving to
          another: its lifetime is the panel's, not the topic's. Nothing here
          renders until it is opened, so the group adds no row to any topic. */}
      <BetaTermsConsent
        open={termsOpen}
        testId="sync.beta-terms"
        onAccept={() => {
          setTermsOpen(false);
          void betaTerms.accept();
        }}
        // Declining closes the dialog and leaves the gate standing - the form
        // was never rendered, so there is nothing to take back.
        onCancel={() => setTermsOpen(false)}
      />

      <IdentitySetupDialog
        open={identityOpen}
        onClose={() => setIdentityOpen(false)}
        onCreated={handleIdentityCreated}
      />

      {/* The owner's device-join code, and it is the PERSON code now
          (`decisions/sync/0767`). A vault born under an identity names the person
          and the payload comes from this device's own identity (myne-md/myne#911
          task 9). A vault that is NOT person-born used to get the account-number
          variant, and that variant is withdrawn here rather than left to age:
          the two clients that could SCAN an account code are the ones that lost
          their join forms, so the dialog was producing a picture nothing could
          consume. The form that types the number is still below for such a
          vault, and it is the only path it has: an account-keyed vault has no
          person to invite a device to. */}
      <DeviceJoinQrDialog open={qrOpen} onClose={() => setQrOpen(false)} variant="person" />

      <Toast
        message={takeTheirsPending ? t("sync.conflicts.tookTheirsToast") : null}
        onDone={() => setTakeTheirsPending(null)}
        durationMs={8000}
        action={
          takeTheirsPending
            ? {
                label: t("sync.conflicts.tookTheirsUndo"),
                onAction: handleUndoTakeTheirs,
              }
            : undefined
        }
      />
    </div>
  );
}
