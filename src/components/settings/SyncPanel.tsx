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
import { SyncStatusIndicator } from "../sync/SyncStatusIndicator";
import { EndpointConfig } from "../sync/EndpointConfig";
import { EnrollDeviceForm } from "../sync/EnrollDeviceForm";
import { BetaTermsConsent } from "../sync/BetaTermsConsent";
import { useBetaTermsGate } from "../../hooks/useBetaTermsGate";
import { IdentitySetupDialog } from "../IdentitySetupDialog";
import { personStatus, type PersonStatusView } from "../../lib/personAccount";
import { setPersonIdentityState, usePersonIdentityState } from "../sync/personIdentityState";
import { DeviceManagementPanel } from "../sync/DeviceManagementPanel";
import { MemberRosterPanel } from "../sync/MemberRosterPanel";
import { DeviceJoinQr } from "../sync/DeviceJoinQr";
import { BuildingIndexState } from "../sync/BuildingIndexState";
import { SyncUsageBlock } from "../sync/SyncUsageBlock";
import { RecoveredNotes } from "../sync/RecoveredNotes";
import { has as hasCapability } from "../../platform/capabilities";
import { MigrateVaultForm } from "./MigrateVaultForm";
import { SettleMigrationBlock } from "./SettleMigrationBlock";
import { migrationSettleStatus } from "../../lib/vault-migrate";
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
import { Input } from "../primitives/Input";
import { Toast } from "../Toast";
import { noteList } from "../../notes";
import { useDevices } from "../../hooks/useDevices";
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

const SECTION_TITLE_STYLE: CSSProperties = {
  fontSize: "var(--text-base)",
  fontWeight: "var(--weight-semibold)" as CSSProperties["fontWeight"],
  color: "var(--fg-1)",
};

export interface SyncPanelProps {
  /**
   * Routed to Unlock after a successful vault migration (#420). Migration re-keys
   * the vault and drops the running slot, so the session must re-unlock; the
   * Settings shell wires this to `onForceRelock({ kind: "Exists" })`.
   */
  onMigrated?: () => void;
  /**
   * Raised while this panel has a modal dialog of its own up (the beta terms).
   * The Settings shell stands its global keys down while a child dialog owns
   * the surface — see the child-dialog gating note in `SettingsModal.tsx`.
   */
  onDialogOpenChange?: (open: boolean) => void;
}

export function SyncPanel({ onMigrated, onDialogOpenChange }: SyncPanelProps = {}) {
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
  // The full device-local person status, not just `enrolled`: the Identity block
  // below shows the existing identity (its public code) while it is locked, which
  // `enrolled` alone cannot answer (myne-md/myne#792 follow-up).
  const [person, setPerson] = useState<PersonStatusView | null>(null);
  useEffect(() => {
    let alive = true;
    void personStatus()
      .then((s) => {
        if (alive) setPerson(s);
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, []);
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
  // not "add one". Merged with the shared identity store so an unlock done
  // through the member roster below (which writes that store) reflects here
  // without waiting for a re-probe (myne-md/myne#792 review).
  const { ready: identityReady, ownerCode: identityOwnerCode } = usePersonIdentityState();
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
  const awaitingApproval = syncStatus?.state === "pending";
  const showEnroll = canAddThisDevice(syncStatus?.state);
  const betaTerms = useBetaTermsGate();
  // The terms dialog, opened from the gate below. Local, and reported up so
  // the Settings shell stops competing for Esc while it is open. The cleanup
  // matters: the shell's flag outlives this panel, so unmounting with the
  // dialog open would leave Esc gated for every later session.
  const [termsOpen, setTermsOpen] = useState(false);
  // The later-add identity door (myne-md/myne#768).
  const [identityOpen, setIdentityOpen] = useState(false);
  useEffect(() => {
    onDialogOpenChange?.(termsOpen);
    return () => onDialogOpenChange?.(false);
  }, [termsOpen, onDialogOpenChange]);
  // Still roster-derived, because it asks something status cannot: the QR
  // invite is only meaningful for a device the ACCOUNT lists as an approved
  // member, and only the roster knows that.
  const enrolledHere = (devicesHook.devices ?? []).some(
    (d) => d.is_current && d.approved && !d.retired,
  );

  // Cold-start "building search index…" state. Producer: the MYND-426 engine
  // re-derives vault.search/vault.indices after a full-reconcile or a fresh
  // device enroll and emits `sync://index-building` around that window. Dormant
  // until the loop lands (R3); no-op outside Tauri (browser dev shim).
  // Does this vault have anything to say about migration at all?
  //
  // `offerable` is "still v0.1, the upgrade can be offered"; `pending` is "a
  // migration ran and its `legacy/` snapshot is unsettled". A vault created
  // today is v0.2 from birth (`decisions.md` 2026-08-13) and has NEITHER, so
  // the whole block — heading included — stays out of Settings rather than
  // showing a permanently-inert control. `null` while the probe is in flight,
  // which renders as absent: a row that appears a beat late is better than one
  // that flashes and disappears.
  const [migration, setMigration] = useState<{
    offerable: boolean;
    pending: boolean;
  } | null>(null);
  const probeMigration = useCallback(() => {
    // Not on web: the dispatcher refuses the whole `vault-migrate` plugin there
    // (a web client joins an already-current account and never migrates), so
    // probing would be a call the backend answers with a refusal.
    if (!hasCapability("vaultMigration")) return;
    void migrationSettleStatus()
      .then((s) => setMigration({ offerable: s.offerable, pending: s.pending }))
      // A probe failure hides the block, exactly as it does on a vault that was
      // never migrated. The unlock path owns any real meta failure.
      .catch(() => setMigration(null));
  }, []);
  useEffect(probeMigration, [probeMigration]);

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
          await noteUpdate(copyId, clearConflictMarkers(content));
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
      {/* Identity block (myne-md/myne#768). Shown whenever sharing is available:
          with no identity on this device it offers to add one; with an identity
          it shows THAT identity (its public code) and, while the private identity
          is locked for the session (decisions/protocol/0612), the unlock action.
          Before, the block vanished once an identity existed, so a locked
          identity had no surface here at all (myne-md/myne#792 follow-up). */}
      {hasCapability("memberSharing") && (
        <div style={BLOCK_STYLE} data-setting-anchor="sync.identity" data-setting-row="true">
          <span style={LABEL_STYLE}>{t("sync.panel.identity.label")}</span>
          {!identityLoaded ? null : !hasIdentity ? (
            <>
              <p style={HELPER_STYLE}>{t("sync.panel.identity.helper")}</p>
              <Button
                variant="secondary"
                onClick={() => setIdentityOpen(true)}
                data-testid="sync.panel.add-identity"
              >
                {t("sync.panel.identity.cta")}
              </Button>
            </>
          ) : identityUnlocked ? (
            <p style={HELPER_STYLE} data-testid="sync.panel.identity-unlocked">
              {t("sync.panel.identity.unlockedHelper")}
            </p>
          ) : (
            <>
              <p style={HELPER_STYLE} data-testid="sync.panel.identity-locked">
                {t("sync.panel.identity.lockedHelper")}
              </p>
              {identityCode ? (
                <Input
                  readOnly
                  mono
                  aria-label={t("sync.panel.identity.codeLabel")}
                  value={identityCode}
                  data-testid="sync.panel.identity-code"
                  style={{ userSelect: "all" }}
                  onFocus={(e) => e.target.select()}
                />
              ) : null}
              <Button
                variant="secondary"
                onClick={() => setIdentityOpen(true)}
                data-testid="sync.panel.unlock-identity"
              >
                {t("sync.status.unlockIdentityCta")}
              </Button>
            </>
          )}
        </div>
      )}

      <div style={BLOCK_STYLE} data-setting-anchor="sync.server" data-setting-row="true">
        <span style={LABEL_STYLE}>{t("sync.panel.server.label")}</span>
        {/* The server helper now renders inside EndpointConfig, directly under
            the input and before the fingerprint block (E4a). */}
        <EndpointConfig />
      </div>

      <div style={BLOCK_STYLE} data-setting-anchor="sync.status" data-setting-row="true">
        <span style={LABEL_STYLE}>{t("sync.panel.status.label")}</span>
        <SyncStatusIndicator onUnlockIdentity={() => setIdentityOpen(true)} />
        <BuildingIndexState building={buildingIndex} />
        <p style={HELPER_STYLE}>{t("sync.panel.status.helper")}</p>
      </div>

      {accountStatus !== null && (
        <div style={BLOCK_STYLE}>
          <span style={LABEL_STYLE}>{t("sync.panel.usage.label")}</span>
          <SyncUsageBlock status={accountStatus} />
          <p style={HELPER_STYLE}>{t("sync.panel.usage.helper")}</p>
        </div>
      )}

      {/* The beta-terms gate (operations#15). One of three doors that turn sync
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
      {showEnroll && !betaTerms.pending && (
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
      <BetaTermsConsent
        open={termsOpen}
        testId="sync.beta-terms"
        onAccept={() => {
          setTermsOpen(false);
          void betaTerms.accept();
        }}
        // Declining closes the dialog and leaves the gate standing — the form
        // was never rendered, so there is nothing to take back.
        onCancel={() => setTermsOpen(false)}
      />

      <IdentitySetupDialog
        open={identityOpen}
        onClose={() => setIdentityOpen(false)}
        onCreated={handleIdentityCreated}
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
        <span style={SECTION_TITLE_STYLE}>{t("sync.panel.devices.label")}</span>
        <DeviceManagementPanel hook={devicesHook} />
      </div>

      {/* The B2B member roster (myne-md/myne#698): the membership extension's
          member rows for the unlocked shared vault. Omitted on a client without
          the capability (web has no person-identity carrier), per the
          absent-not-disabled rule; the empty arm covers a single-account vault.
          NOT gated on `enrolledHere`: the roster is a property of the unlocked
          VAULT (read from `vault.meta` under `root_key`), not of this device's
          account enrollment, so a vault can carry members before this device
          joins the account roster. */}
      {hasCapability("memberSharing") ? (
        <div style={BLOCK_STYLE} data-setting-anchor="sync.members" data-setting-row="true">
          <span style={SECTION_TITLE_STYLE}>{t("sync.memberRoster.title")}</span>
          <MemberRosterPanel onDialogOpenChange={onDialogOpenChange} />
        </div>
      ) : null}

      {/* An enrolled device can invite another by showing a QR (MYND-466). */}
      {enrolledHere && (
        <div style={BLOCK_STYLE}>
          <DeviceJoinQr />
        </div>
      )}

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

      {/* Whole-vault v0.1 → v0.2 migration (#420) — gated behind the
          `vaultMigration` capability (present on desktop, absent on web: a web
          client joins an already-current account and never migrates). The
          dispatcher refuses `plugin:vault-migrate|vault_migrate` on web, so this
          capability is what keeps the UI from offering a control the backend
          rejects (check-web-capabilities.mjs). */}
      {hasCapability("vaultMigration") && (migration?.offerable || migration?.pending) && (
        <div style={BLOCK_STYLE} data-setting-anchor="sync.migrate" data-setting-row="true">
          <span style={SECTION_TITLE_STYLE}>{t("migrate.submit")}</span>
          {/* The form only where there is something to migrate. On an
              already-current vault it would ask for the 24-word recovery phrase
              to perform a no-op that the backend refuses with `AlreadyMigrated`
              — an offer the product cannot honour. */}
          {migration?.offerable && (
            <MigrateVaultForm
              onMigrated={() => {
                probeMigration();
                onMigrated?.();
              }}
            />
          )}
          {/* §10.4.1 point 5 (myne-md/myne#430). Renders only while a `legacy/`
              snapshot is staged, which is also why it sits BELOW the form: after
              a migration the vault locks and the user re-unlocks, so this is the
              surface they come back to, not one they see on the way out. */}
          <SettleMigrationBlock
            onSettled={(which) => {
              probeMigration();
              // ABORT only (myne-md/myne#461). `onMigrated` is the force-relock:
              // it routes the shell to the Unlock screen, which is right after
              // an abort, because that command restores the pre-migration root
              // and the backend drops the slot with it. Confirm is not a re-key.
              // It erases the staged `legacy/` snapshot and leaves the running
              // slot untouched, so relocking on top of it showed a lock screen
              // the backend never locked: the correct password then came back
              // `VaultAlreadyUnlocked` forever and the only way out was
              // restarting the app. Confirm re-probes and leaves the user where
              // they are, which is what settling a migration should feel like.
              if (which === "aborted") onMigrated?.();
            }}
          />
        </div>
      )}

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
