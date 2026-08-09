import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
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
      data-testid="repair-residue.banner"
      style={{
        border: "1px solid var(--line-1)",
        borderRadius: "var(--radius-3)",
        background: "var(--bg-2)",
        padding: "var(--space-4)",
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
  const { t } = useTranslation();
  const Title = ({ children }: { children: string }) => (
    <div style={{ fontSize: "var(--text-sm)", fontWeight: "var(--weight-semibold)", color: "var(--fg-1)" }}>
      {children}
    </div>
  );
  const Body = ({ children }: { children: string }) => (
    <div style={{ fontSize: 12, lineHeight: 1.6, color: "var(--fg-2)" }}>
      {children}
    </div>
  );

  switch (phase.kind) {
    case "found":
      return (
        <>
          <Title>{t("welcome.repairResidue.foundTitle")}</Title>
          <Body>
            {t("welcome.repairResidue.foundBody", { count: phase.count })}
          </Body>
        </>
      );
    case "confirming":
    case "sweeping":
      return (
        <>
          <Title>{t("welcome.repairResidue.confirmTitle")}</Title>
          <Body>
            {t("welcome.repairResidue.confirmBody", { count: phase.count })}
          </Body>
        </>
      );
    case "done":
      return (
        <>
          <Title>{t("welcome.repairResidue.doneTitle")}</Title>
          <Body>
            {t("welcome.repairResidue.doneBody", { count: phase.removed })}
          </Body>
        </>
      );
    case "partial":
      return (
        <>
          <Title>{t("welcome.repairResidue.partialTitle")}</Title>
          <Body>
            {t("welcome.repairResidue.partialBody", { count: phase.remaining })}
          </Body>
        </>
      );
    case "error":
      return (
        <>
          <Title>{t("welcome.repairResidue.errorTitle")}</Title>
          <Body>{t("welcome.repairResidue.errorBody")}</Body>
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
  const { t } = useTranslation();
  switch (phase.kind) {
    case "found":
      return (
        <div style={{ display: "flex", justifyContent: "flex-end" }}>
          <Button variant="secondary" onClick={() => onRequestConfirm(phase.count)}>
            {t("welcome.repairResidue.cleanUp")}
          </Button>
        </div>
      );
    case "confirming":
    case "sweeping": {
      const busy = phase.kind === "sweeping";
      return (
        <div style={{ display: "flex", justifyContent: "flex-end", gap: "var(--space-2)" }}>
          <Button variant="ghost" disabled={busy} onClick={() => onCancel(phase.count)}>
            {t("welcome.repairResidue.cancel")}
          </Button>
          <Button variant="secondary" disabled={busy} onClick={() => onConfirm(phase.count)}>
            {busy
              ? t("welcome.repairResidue.cleaningUp")
              : t("welcome.repairResidue.cleanUp")}
          </Button>
        </div>
      );
    }
    default:
      return null;
  }
}
