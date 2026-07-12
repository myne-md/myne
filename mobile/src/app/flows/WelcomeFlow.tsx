import { useEffect, useState } from "react";
import { Screen, Button, MyneMark, Banner } from "../../components";
import { HAS_TAURI } from "../../lib/app-window";
import { vaultResidueScan, vaultRepair } from "../../lib/vault-repair";
import type { WelcomeFlowProps } from "./types";

/** 01 · Welcome — wired. Routes into create / recover. Surfaces a repair banner
 *  when a partial-fail vault_delete left orphan residue behind (MYND-159). */
export function WelcomeFlow({ onCreate, onRecover, onJoin }: WelcomeFlowProps) {
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
      setRepairMsg(`Cleaned up ${removed} leftover ${removed === 1 ? "file" : "files"}.`);
    } catch {
      try {
        setResidue(await vaultResidueScan());
      } catch {
        /* keep the last-known count */
      }
      setRepairMsg("Couldn't finish cleaning up. Please try again.");
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
          Notes that
          <br />
          belong to
          <br />
          no one but you.
        </h1>
        <p style={{ margin: "22px 0 0", fontSize: 16, lineHeight: 1.6, color: "var(--fg-2)", maxWidth: 300 }}>
          Markdown, encrypted on this device before it ever leaves it. No account email. No servers
          that can read a word.
        </p>
      </div>
      <div style={{ paddingBottom: 52, display: "flex", flexDirection: "column", gap: 10 }}>
        {residue > 0 && (
          <Banner kind="warning">
            <div style={{ marginBottom: 10 }}>
              Leftover files from an interrupted delete ({residue}). Clean them up before creating a vault.
            </div>
            <Button variant="secondary" onClick={() => void repair()} disabled={repairing}>
              {repairing ? "Cleaning up…" : "Clean up leftover files"}
            </Button>
          </Banner>
        )}
        {repairMsg && (
          <div style={{ fontSize: 13, color: "var(--fg-3)", textAlign: "center" }}>{repairMsg}</div>
        )}
        <Button onClick={onCreate}>Create a vault</Button>
        <Button variant="ghost" onClick={onJoin}>
          Connect to my account
        </Button>
        <Button variant="ghost" onClick={onRecover}>
          I already have a recovery phrase
        </Button>
      </div>
    </Screen>
  );
}
