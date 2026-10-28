import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Screen, Button, MyneMark, Banner, TextField } from "../../components";
import { HAS_TAURI } from "../../lib/app-window";
import { vaultResidueScan, vaultRepair, type ResidueRoot, type VaultRepairError } from "../../lib/vault-repair";
import { deleteVault } from "../../lib/vault-delete";
import type { WelcomeFlowProps } from "./types";

/** 01 · Welcome — wired. Routes into create / join. Surfaces a repair banner
 *  when a partial-fail vault_delete left orphan residue behind (MYND-159).
 *
 *  **Two kinds of leftover, and they are not the same button.** The report from
 *  `vaultResidueScan` is per vault root, and each root says whether it still
 *  carries a `vault.meta`:
 *
 *  - no `vault.meta` → genuine residue. `vaultRepair` sweeps it, gate-free, and
 *    nothing recoverable is lost because the key material went with the meta.
 *  - `vault.meta` present → a vault directory the app cannot open. The sweep
 *    refuses it by design, so a "clean up" button over one of these can only
 *    ever answer "couldn't finish cleaning up": that was this screen's bug, and
 *    the count it used to receive could not tell the two apart. It is routed to
 *    `deleteVault` instead, behind a typed DELETE, because destroying anything
 *    that still has a `vault.meta` is `vault_delete`'s gated territory.
 *
 *  Nothing here blocks creation: a new vault lands at a fresh
 *  `vaults/<minted-id>/`, so the old copy of this screen's copy ("clean them up
 *  before creating a vault") was advice that could not be acted on and was not
 *  required.
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
  const [roots, setRoots] = useState<ResidueRoot[]>([]);
  const [busy, setBusy] = useState(false);
  const [repairMsg, setRepairMsg] = useState<string | null>(null);
  const [typedDelete, setTypedDelete] = useState("");
  const [confirming, setConfirming] = useState(false);

  useEffect(() => {
    if (!HAS_TAURI) return;
    let cancelled = false;
    void scanInto(setRoots, () => cancelled);
    return () => {
      cancelled = true;
    };
  }, []);

  const repairable = roots.filter((root) => !root.hasVaultMeta);
  const gated = roots.find((root) => root.hasVaultMeta) ?? null;
  const repairableEntries = repairable.reduce((sum, root) => sum + root.entries, 0);

  async function scan() {
    try {
      setRoots(await vaultResidueScan());
    } catch {
      /* keep the last-known report */
    }
  }

  async function cleanUp() {
    setBusy(true);
    setRepairMsg(null);
    try {
      const removed = await vaultRepair();
      setRepairMsg(t("welcome.repairCleanedUp", { count: removed }));
    } catch (raw) {
      const e = raw as VaultRepairError | undefined;
      setRepairMsg(
        e?.kind === "PartialDelete"
          ? t("welcome.repairResidue.partialBody", { count: e.detail.remaining_count })
          : t("welcome.repairFailed"),
      );
    } finally {
      await scan();
      setBusy(false);
    }
  }

  async function deleteGated(root: ResidueRoot) {
    setBusy(true);
    setRepairMsg(null);
    try {
      await deleteVault(root.vaultId);
      setRepairMsg(t("welcome.repairCleanedUp", { count: root.entries }));
      setConfirming(false);
      setTypedDelete("");
    } catch {
      setRepairMsg(t("settings.deleteVault.deleteError"));
    } finally {
      await scan();
      setBusy(false);
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
        {roots.length > 0 && (
          <Banner kind="warning">
            {repairableEntries > 0 && (
              <div data-testid="welcome.residue-banner" style={{ display: "flex", flexDirection: "column", gap: "var(--space-2)" }}>
                <div>{t("welcome.residueBanner", { n: repairableEntries })}</div>
                <Button variant="secondary" onClick={() => void cleanUp()} disabled={busy} data-testid="welcome.residue-clean">
                  {busy ? t("welcome.repairResidue.cleaningUp") : t("welcome.cleanUpFiles")}
                </Button>
              </div>
            )}
            {gated && (
              <div
                data-testid="welcome.residue-gated"
                style={{ display: "flex", flexDirection: "column", gap: "var(--space-2)", marginTop: repairableEntries > 0 ? 14 : 0 }}
              >
                {/* Not called "leftover": this may be a vault nobody can open
                    any more, and telling the user it is already unreadable would
                    be a claim about their data that this screen cannot make. */}
                <div>{t("welcome.residueGated", { n: gated.entries })}</div>
                {confirming ? (
                  <>
                    <TextField
                      value={typedDelete}
                      onChange={setTypedDelete}
                      testId="welcome.residue-delete-confirm"
                      label={t("welcome.residueGatedHint")}
                      autoCapitalize="characters"
                    />
                    <Button
                      variant="danger"
                      onClick={() => void deleteGated(gated)}
                      disabled={busy || typedDelete.trim().toUpperCase() !== "DELETE"}
                      data-testid="welcome.residue-delete"
                    >
                      {t("welcome.residueGatedDelete")}
                    </Button>
                    <Button variant="ghost" onClick={() => { setConfirming(false); setTypedDelete(""); }} disabled={busy}>
                      {t("welcome.repairResidue.cancel")}
                    </Button>
                  </>
                ) : (
                  <Button
                    variant="secondary"
                    onClick={() => setConfirming(true)}
                    disabled={busy}
                    data-testid="welcome.residue-delete-open"
                  >
                    {t("welcome.residueGatedDelete")}
                  </Button>
                )}
              </div>
            )}
          </Banner>
        )}
        {repairMsg && (
          <div data-testid="welcome.repair-message" style={{ fontSize: "var(--text-sm)", color: "var(--fg-3)", textAlign: "center" }}>{repairMsg}</div>
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

/** Scan once on mount without letting a late result write into an unmounted
 *  screen. Kept outside the component so the effect stays one expression. */
async function scanInto(set: (roots: ResidueRoot[]) => void, cancelled: () => boolean) {
  try {
    const report = await vaultResidueScan();
    if (!cancelled()) set(report);
  } catch {
    /* an unreadable report is not a repair failure; leave the banner off */
  }
}
