import { Button } from "../components/primitives/Button";
import { MyneMark } from "../components/primitives/MyneMark";
import { RepairResidueBanner } from "../components/RepairResidueBanner";

interface WelcomeProps {
  onCreateVault: () => void;
}

export function Welcome({ onCreateVault }: WelcomeProps) {
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
          Encrypted markdown notes.
          <br />
          No email at signup.
        </div>

        <div
          style={{
            fontSize: 14,
            lineHeight: 1.6,
            color: "var(--fg-2)",
            maxWidth: 360,
          }}
        >
          Your notes are encrypted on this device before they leave it. The
          server only stores ciphertext.
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
            Create new vault
          </Button>
        </div>

        <div style={{ fontSize: 12, color: "var(--fg-3)", marginTop: 8 }}>
          v0.1 pre-alpha
        </div>
      </div>
    </div>
  );
}
