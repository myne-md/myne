import { useEffect, useState } from "react";
import { Button } from "./primitives/Button";
import {
  vaultResidueScan,
  vaultRepair,
  isVaultRepairPartial,
  type VaultRepairError,
} from "../lib/vault-repair";

/**
 * Welcome-screen affordance for cleaning up orphan vault residue left by a
 * partial-fail `vault_delete` (MYND-159). Renders **nothing** on a clean
 * device — it probes `vault_residue_scan` on mount and only surfaces when
 * residue is actually present (`vault.meta` is absent in this stage by
 * construction, so the scan can run freely).
 *
 * Friction is a single explicit confirm, NOT a typed-DELETE ceremony: the
 * residue is already unreadable junk (the keys left with the deleted
 * `vault.meta`), so the heavy gate that guards recoverable data would be
 * dishonest here. The copy is reassuring, not alarmist, and shows the true
 * count the sweep will remove (the over-capture safety valve). The
 * asymmetry with `vault_delete`'s typed-DELETE gate is deliberate — friction
 * tracks what is at stake.
 *
 * On a successful sweep the banner reports the count and clears the way for
 * vault creation. On a partial-fail it falls back to the same manual-cleanup
 * instruction as `vault_delete`'s partial-fail — repair makes the common
 * transient-lock case recoverable in-app; it does not promise to eliminate
 * the manual path.
 */

type Phase =
  | { kind: "found"; count: number } // residue detected, banner shown
  | { kind: "confirming"; count: number } // single explicit confirm
  | { kind: "sweeping"; count: number } // vault_repair in flight
  | { kind: "done"; removed: number } // swept clean
  | { kind: "partial"; remaining: number } // some files still locked
  | { kind: "error" }; // unexpected failure

export function RepairResidueBanner() {
  // `null` until the mount probe resolves (renders nothing in the meantime),
  // and stays `null` on a clean device so the banner never flashes.
  const [phase, setPhase] = useState<Phase | null>(null);

  useEffect(() => {
    let cancelled = false;
    void vaultResidueScan()
      .then((count) => {
        if (!cancelled && count > 0) setPhase({ kind: "found", count });
      })
      .catch(() => {
        // A scan failure is non-fatal — show nothing rather than block the
        // Welcome screen.
      });
    return () => {
      cancelled = true;
    };
  }, []);

  if (phase === null) return null;

  const runRepair = async (count: number) => {
    setPhase({ kind: "sweeping", count });
    try {
      const removed = await vaultRepair();
      setPhase({ kind: "done", removed });
    } catch (e) {
      const err = e as VaultRepairError;
      if (isVaultRepairPartial(err)) {
        setPhase({ kind: "partial", remaining: err.detail.remaining_count });
      } else {
        setPhase({ kind: "error" });
      }
    }
  };

  return (
    <div
      style={{
        border: "1px solid var(--line-1)",
        borderRadius: 10,
        background: "var(--bg-2)",
        padding: 16,
        display: "flex",
        flexDirection: "column",
        gap: 10,
      }}
    >
      <BannerBody phase={phase} />
      <BannerActions
        phase={phase}
        onRequestConfirm={(count) => setPhase({ kind: "confirming", count })}
        onConfirm={runRepair}
        onCancel={(count) => setPhase({ kind: "found", count })}
      />
    </div>
  );
}

function BannerBody({ phase }: { phase: Phase }) {
  const Title = ({ children }: { children: string }) => (
    <div style={{ fontSize: 13, fontWeight: 600, color: "var(--fg-1)" }}>
      {children}
    </div>
  );
  const Body = ({ children }: { children: string }) => (
    <div style={{ fontSize: 12, lineHeight: 1.6, color: "var(--fg-2)" }}>
      {children}
    </div>
  );

  const plural = (n: number) => (n === 1 ? "" : "s");

  switch (phase.kind) {
    case "found":
      return (
        <>
          <Title>Leftover files from an incomplete deletion</Title>
          <Body>{`${phase.count} leftover file${plural(phase.count)} from a previous deletion that didn't finish. They're already unreadable — you won't lose anything recoverable.`}</Body>
        </>
      );
    case "confirming":
    case "sweeping":
      return (
        <>
          <Title>Clean up leftover files?</Title>
          <Body>{`${phase.count} file${plural(phase.count)} will be removed. They're already unreadable; nothing recoverable is lost.`}</Body>
        </>
      );
    case "done":
      return (
        <>
          <Title>Cleaned up</Title>
          <Body>{`Removed ${phase.removed} leftover file${plural(phase.removed)}. You can create a new vault now.`}</Body>
        </>
      );
    case "partial":
      return (
        <>
          <Title>Some files couldn't be removed</Title>
          <Body>{`${phase.remaining} file${plural(phase.remaining)} may be locked by another app (antivirus, file sync, or search indexing). Close the app and try again in a moment, or remove the vault folder manually.`}</Body>
        </>
      );
    case "error":
      return (
        <>
          <Title>Cleanup failed</Title>
          <Body>Something went wrong. Close the app and try again.</Body>
        </>
      );
  }
}

function BannerActions({
  phase,
  onRequestConfirm,
  onConfirm,
  onCancel,
}: {
  phase: Phase;
  onRequestConfirm: (count: number) => void;
  onConfirm: (count: number) => void;
  onCancel: (count: number) => void;
}) {
  switch (phase.kind) {
    case "found":
      return (
        <div style={{ display: "flex", justifyContent: "flex-end" }}>
          <Button variant="secondary" onClick={() => onRequestConfirm(phase.count)}>
            Clean up
          </Button>
        </div>
      );
    case "confirming":
    case "sweeping": {
      const busy = phase.kind === "sweeping";
      return (
        <div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
          <Button variant="ghost" disabled={busy} onClick={() => onCancel(phase.count)}>
            Cancel
          </Button>
          <Button variant="secondary" disabled={busy} onClick={() => onConfirm(phase.count)}>
            {busy ? "Cleaning up…" : "Clean up"}
          </Button>
        </div>
      );
    }
    default:
      return null;
  }
}
