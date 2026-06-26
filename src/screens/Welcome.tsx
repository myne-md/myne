import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "../components/primitives/Button";
import { MyneMark } from "../components/primitives/MyneMark";
import { RepairResidueBanner } from "../components/RepairResidueBanner";
import { JoinDeviceModal } from "../components/sync/JoinDeviceModal";

interface WelcomeProps {
  onCreateVault: () => void;
  /** Fresh-install restore door (MYND-56; the user-guide UX contract). */
  onRestoreBackup: () => void;
  /** Device-join succeeded (vault bootstrapped + unlocked) → editor (MYND-424). */
  onJoined: (vaultId: string) => void;
}

export function Welcome({ onCreateVault, onRestoreBackup, onJoined }: WelcomeProps) {
  const { t } = useTranslation();
  const [joinOpen, setJoinOpen] = useState(false);
  return (
    <div
      data-testid="welcome.root"
      style={{
        minHeight: "100vh",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        background: "var(--bg-1)",
        padding: 24,
      }}
    >
      <div
        style={{
          width: 420,
          display: "flex",
          flexDirection: "column",
          gap: 24,
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
          <MyneMark size={36} />
          <div
            style={{
              fontSize: 24,
              fontWeight: 600,
              letterSpacing: "-0.02em",
              color: "var(--fg-display)",
            }}
          >
            Myne
          </div>
        </div>

        <div
          style={{
            fontSize: 28,
            lineHeight: 1.2,
            fontWeight: 600,
            letterSpacing: "-0.015em",
            color: "var(--fg-display)",
          }}
        >
          {t("welcome.headlineLine1")}
          <br />
          {t("welcome.headlineLine2")}
        </div>

        <div
          style={{
            fontSize: 14,
            lineHeight: 1.6,
            color: "var(--fg-2)",
            maxWidth: 360,
          }}
        >
          {t("welcome.subtitle")}
        </div>

        {/* Orphan-residue cleanup (MYND-159). Renders nothing unless a
            partial-fail vault_delete left artefacts behind — surfaced here,
            on Welcome, because that is exactly where the user lands when
            vault.meta is gone (Settings is unreachable without a vault). */}
        <RepairResidueBanner />

        <div
          style={{
            display: "flex",
            flexDirection: "column",
            gap: 8,
            marginTop: 8,
          }}
        >
          <Button
            variant="primary"
            onClick={onCreateVault}
            data-testid="welcome.create-cta"
          >
            {t("welcome.createCta")}
          </Button>
          <Button
            variant="secondary"
            onClick={onRestoreBackup}
            data-testid="welcome.restore-cta"
          >
            {t("welcome.restoreCta")}
          </Button>
          <Button
            variant="secondary"
            onClick={() => setJoinOpen(true)}
            data-testid="welcome.join-cta"
          >
            Add this device to an account
          </Button>
        </div>

        <div style={{ fontSize: 12, color: "var(--fg-3)", marginTop: 8 }}>
          v0.1 pre-alpha
        </div>
      </div>

      {joinOpen && (
        <JoinDeviceModal
          onCancel={() => setJoinOpen(false)}
          onJoined={(vaultId) => {
            setJoinOpen(false);
            onJoined(vaultId);
          }}
        />
      )}
    </div>
  );
}
