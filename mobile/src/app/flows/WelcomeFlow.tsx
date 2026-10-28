import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Screen, Button, MyneMark, Banner } from "../../components";
import { HAS_TAURI } from "../../lib/app-window";
import { vaultResidueScan, vaultRepair } from "../../lib/vault-repair";
import type { WelcomeFlowProps } from "./types";

/** 01 · Welcome — wired. Routes into create / join. Surfaces a repair banner
 *  when a partial-fail vault_delete left orphan residue behind (MYND-159).
 *
 *  **One create action** (myne-md/myne#911 task 12). This screen used to offer a
 *  primary "Create an identity" AND a ghost "Create a local vault instead", which
 *  was the desktop's identity/local fork: two credential models, one of which
 *  minted a per-vault recovery phrase the person account exists to retire. The
 *  fork is gone, so the primary door starts the identity chain and the vault
 *  follows from the identity home. The join door stays, because adding this
 *  device to an account that already exists is not a create. */
export function WelcomeFlow({ onHaveIdentity, onIdentity }: WelcomeFlowProps) {
  const { t } = useTranslation();
  const [residue, setResidue] = useState(0);
  const [repairing, setRepairing] = useState(false);
  const [repairMsg, setRepairMsg] = useState<string | null>(null);

  useEffect(() => {
    if (!HAS_TAURI) return;
    let cancelled = false;
    void vaultResidueScan()
      .then((n) => {
        if (!cancelled) setResidue(n);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  async function repair() {
    setRepairing(true);
    setRepairMsg(null);
    try {
      const removed = await vaultRepair();
      setResidue(0);
      setRepairMsg(t("welcome.repairCleanedUp", { count: removed }));
    } catch {
      try {
        setResidue(await vaultResidueScan());
      } catch {
        /* keep the last-known count */
      }
      setRepairMsg(t("welcome.repairFailed"));
    } finally {
      setRepairing(false);
    }
  }

  return (
    <Screen style={{ padding: "0 30px" }}>
      <div style={{ paddingTop: 96, display: "flex", alignItems: "center", gap: 10 }}>
        <MyneMark size={28} radius={6} />
        <span style={{ fontSize: 21, fontWeight: 600, letterSpacing: "-0.02em", color: "var(--fg-1)" }}>myne</span>
      </div>
      <div style={{ flex: 1, display: "flex", flexDirection: "column", justifyContent: "center", paddingBottom: 40 }}>
        <h1
          style={{
            margin: 0,
            fontSize: 36,
            lineHeight: 1.12,
            letterSpacing: "-0.025em",
            fontWeight: 600,
            color: "var(--fg-display)",
          }}
        >
          {t("welcome.heroLine1")}
          <br />
          {t("welcome.heroLine2")}
          <br />
          {t("welcome.heroLine3")}
        </h1>
        <p style={{ margin: "22px 0 0", fontSize: 16, lineHeight: 1.6, color: "var(--fg-2)", maxWidth: 300 }}>
          {t("welcome.lede")}
        </p>
      </div>
      <div style={{ paddingBottom: 52, display: "flex", flexDirection: "column", gap: 10 }}>
        {residue > 0 && (
          <Banner kind="warning">
            <div style={{ marginBottom: 10 }}>
              {t("welcome.residueBanner", { n: residue })}
            </div>
            <Button variant="secondary" onClick={() => void repair()} disabled={repairing}>
              {repairing ? t("welcome.repairResidue.cleaningUp") : t("welcome.cleanUpFiles")}
            </Button>
          </Banner>
        )}
        {repairMsg && (
          <div style={{ fontSize: 13, color: "var(--fg-3)", textAlign: "center" }}>{repairMsg}</div>
        )}
        <Button onClick={onIdentity} data-testid="welcome.create-cta">
          {t("welcome.startAction")}
        </Button>
        {/* Two doors, and the second one now says what it does (myne-md/myne#932).
            "Connect to my account" carried the QR scanner only, while the phrase
            door sat behind "Create your identity and vault", so a returning user
            had to walk into a create action to find their own identity. This opens
            the identity flow's fork, which offers both credentials. */}
        <Button variant="ghost" onClick={onHaveIdentity} data-testid="welcome.have-identity-cta">
          {t("identityFlow.recover.open")}
        </Button>
      </div>
    </Screen>
  );
}
