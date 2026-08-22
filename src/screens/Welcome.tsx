import { useTranslation } from "react-i18next";
import { Button } from "../components/primitives/Button";
import { MyneMark } from "../components/primitives/MyneMark";
import { RepairResidueBanner } from "../components/RepairResidueBanner";
import { stageRootStyle } from "../components/primitives/stageRoot";

interface WelcomeProps {
  onCreateVault: () => void;
  /** Fresh-install restore door (MYND-56; the user-guide UX contract). */
  onRestoreBackup: () => void;
  /**
   * Open the device-join modal (MYND-424). The modal itself is mounted by
   * App.tsx over every stage since myne#221 — this screen was its only host,
   * and `welcome` is produced only at ZERO vaults, so the first vault a user
   * created made the join door unreachable.
   */
  onJoinDevice: () => void;
}

export function Welcome({ onCreateVault, onRestoreBackup, onJoinDevice }: WelcomeProps) {
  const { t } = useTranslation();
  return (
    <div
      data-testid="welcome.root"
      style={{
        ...stageRootStyle,
        background: "var(--bg-1)",
        padding: "var(--space-5)",
      }}
    >
      <div
        style={{
          width: 420,
          display: "flex",
          flexDirection: "column",
          gap: "var(--space-5)",
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: "var(--space-3)" }}>
          <MyneMark size={36} />
          <div
            style={{
              fontSize: 24,
              fontWeight: "var(--weight-semibold)",
              letterSpacing: "-0.02em",
              color: "var(--fg-display)",
            }}
          >
            Myne
          </div>
        </div>

        <div
          style={{
            fontSize: "var(--text-2xl)",
            lineHeight: 1.2,
            fontWeight: "var(--weight-semibold)",
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
            fontSize: "var(--text-base)",
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
            gap: "var(--space-2)",
            marginTop: "var(--space-2)",
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
            onClick={onJoinDevice}
            data-testid="welcome.join-cta"
          >
            {t("welcome.joinCta")}
          </Button>
        </div>

        <div style={{ fontSize: 12, color: "var(--fg-3)", marginTop: "var(--space-2)" }}>
          v0.1 pre-alpha
        </div>
      </div>
    </div>
  );
}
