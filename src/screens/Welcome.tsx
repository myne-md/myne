import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "../components/primitives/Button";
import { MyneMark } from "../components/primitives/MyneMark";
import { Switch } from "../components/primitives/Switch";
import { RepairResidueBanner } from "../components/RepairResidueBanner";
import { IdentitySetupDialog } from "../components/IdentitySetupDialog";
import { stageRootStyle } from "../components/primitives/stageRoot";
import { has } from "../platform/capabilities";
import { plainFileGateGet, plainFileGateSet } from "../platform/plainFile";

/**
 * The plain-file gate for a device that has no vault (myne-md/myne#788, task 7).
 *
 * Settings is unreachable without a vault, so without this control a fresh
 * device could never enable the feature. Same optimistic-toggle-with-rollback
 * shape as `src/components/settings/PlainFileSettings.tsx`, and it deliberately
 * shows no developer-mode gate: `developer_mode` is a vault pref, which is
 * exactly the state this device does not have.
 */
function PlainFileGateToggle() {
  const { t } = useTranslation();
  const [enabled, setEnabled] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void plainFileGateGet()
      .then((value) => {
        if (!cancelled) setEnabled(value);
      })
      .catch(() => {
        /* unreadable gate reads as off (Rust fails closed) */
      });
    return () => {
      cancelled = true;
    };
  }, []);

  async function toggle(next: boolean) {
    const prev = enabled;
    setEnabled(next); // optimistic
    try {
      await plainFileGateSet(next);
      setError(null);
    } catch {
      setEnabled(prev); // rollback
      setError(t("settings.plainFile.errorSaveSetting"));
    }
  }

  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: "var(--space-2)",
        fontSize: "var(--text-xs)",
        color: "var(--fg-3)",
      }}
    >
      <span>{t("settings.plainFile.label")}</span>
      <Switch
        checked={enabled}
        onChange={() => void toggle(!enabled)}
        ariaLabel={t("settings.plainFile.label")}
        testId="welcome.plain-file"
      />
      {error !== null && (
        <span role="alert" data-testid="welcome.plain-file-error" style={{ color: "var(--danger)" }}>
          {error}
        </span>
      )}
    </div>
  );
}

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
  /** Fired after identity-only setup succeeds, so App re-probes and lands on
   *  the identity home (`myne-md/myne#711`). */
  onIdentityCreated?: () => void;
}

export function Welcome({ onCreateVault, onRestoreBackup, onJoinDevice, onIdentityCreated }: WelcomeProps) {
  const { t } = useTranslation();
  // Identity-only setup (myne-md/myne#711): a vault-less person can create an
  // identity and be invite-addressed before owning any vault. The dialog is
  // local to this screen, like the other modal carve-outs; it creates no vault.
  const [identityOpen, setIdentityOpen] = useState(false);
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
          {/* The fork (myne-md/myne#768). Identity comes first, because Myne is
              organised around it: an identity is what makes a person
              addressable for invites, and one identity spans many vaults. The
              local-vault door stays one tap away rather than hidden, since an
              offline vault with no identity is a legitimate choice and the
              identity can be added later from Settings. The two are visually
              adjacent and equally reachable; only the order changed. */}
          <Button
            variant="primary"
            onClick={() => setIdentityOpen(true)}
            data-testid="welcome.identity-cta"
          >
            {t("welcome.startIdentity")}
          </Button>
          <Button
            variant="secondary"
            onClick={onCreateVault}
            data-testid="welcome.create-cta"
          >
            {t("welcome.startLocal")}
          </Button>

          <div style={{ height: 1, background: "var(--line-1)", margin: "var(--space-1) 0" }} />

          <Button
            variant="ghost"
            onClick={onRestoreBackup}
            data-testid="welcome.restore-cta"
          >
            {t("welcome.restoreCta")}
          </Button>
          <Button
            variant="ghost"
            onClick={onJoinDevice}
            data-testid="welcome.join-cta"
          >
            {t("welcome.joinCta")}
          </Button>
        </div>

        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            gap: "var(--space-2)",
            marginTop: "var(--space-2)",
          }}
        >
          <div style={{ fontSize: "var(--text-xs)", color: "var(--fg-3)" }}>v0.1 pre-alpha</div>
          {/* Desktop-only: web has no OS file ingress, so the capability is
              absent there and the row is omitted rather than shown broken. */}
          {has("plainFile") && <PlainFileGateToggle />}
        </div>
      </div>

      <IdentitySetupDialog
        open={identityOpen}
        onClose={() => setIdentityOpen(false)}
        onCreated={onIdentityCreated}
      />
    </div>
  );
}
