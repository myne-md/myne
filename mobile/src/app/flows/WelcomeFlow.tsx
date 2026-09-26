import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Screen, Button, MyneMark, Banner } from "../../components";
import { HAS_TAURI } from "../../lib/app-window";
import { vaultResidueScan, vaultRepair } from "../../lib/vault-repair";
import type { WelcomeFlowProps } from "./types";

/** 01 · Welcome — wired. Routes into create / join. Surfaces a repair banner
 *  when a partial-fail vault_delete left orphan residue behind (MYND-159). */
export function WelcomeFlow({ onCreate, onJoin, onIdentity }: WelcomeFlowProps) {
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
        <Button onClick={onIdentity}>{t("welcome.startIdentity")}</Button>
        <Button variant="ghost" onClick={onCreate}>{t("welcome.startLocal")}</Button>
        <Button variant="ghost" onClick={onJoin}>
          {t("welcome.connect")}
        </Button>
      </div>
    </Screen>
  );
}
