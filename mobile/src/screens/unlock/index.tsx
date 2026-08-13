import type { CSSProperties, ReactNode } from "react";
import {
  Screen,
  Eyebrow,
  Button,
  Banner,
  PasswordField,
  Icon,
  MyneMark,
} from "../../components";
import { usePlatform } from "../../platform/PlatformContext";
import type { ScreenDef } from "../../gallery/types";

// ── Shared bits ──────────────────────────────────────────────────────────────

/** Wordmark: mark + "myne" (unlock screens use the smaller 24/18 — or 22/17 — sizes). */
function Wordmark({ size = 24 }: { size?: number }) {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 9 }}>
      <MyneMark size={size} radius={Math.round(size * 0.25)} />
      <span style={{ fontSize: size === 22 ? 17 : 18, fontWeight: 600, letterSpacing: "-0.02em", color: "var(--fg-1)" }}>
        myne
      </span>
    </div>
  );
}

/** The "Personal" vault-name title (display ink; sizes 22 or 24 in the design). */
function VaultTitle({ size = 24 }: { size?: number }) {
  return (
    <div style={{ marginTop: 8, fontSize: size, fontWeight: 600, letterSpacing: "-0.02em", color: "var(--fg-display)" }}>
      Personal
    </div>
  );
}

/** Account-number specimen line under the vault name. */
function AccountLine() {
  return (
    <div style={{ marginTop: 6, fontFamily: "var(--font-mono)", fontSize: 13, letterSpacing: "0.04em", color: "var(--line-3)" }}>
      MY‑4F2A‑9C17‑8E2D
    </div>
  );
}

/** Tighter-tracked uppercase field label (0.06em) used over inputs. */
function FieldLabel({ children }: { children: ReactNode }) {
  return (
    <div
      style={{
        fontSize: 12,
        fontWeight: 600,
        letterSpacing: "0.06em",
        textTransform: "uppercase",
        color: "var(--fg-3)",
        marginBottom: 8,
      }}
    >
      {children}
    </div>
  );
}

/** Inert text-link button (accent by default; weight 600). */
function TextButton({
  children,
  color = "var(--accent)",
  height = 44,
  fontSize = 15,
  style,
}: {
  children: ReactNode;
  color?: string;
  height?: number;
  fontSize?: number;
  style?: CSSProperties;
}) {
  return (
    <button
      style={{
        height,
        padding: 0,
        border: "none",
        background: "transparent",
        color,
        fontFamily: "var(--font-sans)",
        fontSize,
        fontWeight: 600,
        cursor: "pointer",
        ...style,
      }}
    >
      {children}
    </button>
  );
}

/** Masked passphrase field with caret; optional trailing character count. */
function MaskedField({ dots, count }: { dots: number; count?: number }) {
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        height: 52,
        border: "1.5px solid var(--accent)",
        borderRadius: 6,
        background: "var(--bg-1)",
        padding: "0 14px",
      }}
    >
      <span style={{ fontFamily: "var(--font-mono)", fontSize: 14, letterSpacing: "0.14em", color: "var(--fg-1)" }}>
        {"•".repeat(dots)}
      </span>
      <span style={{ width: 2, height: 24, background: "var(--accent)", marginInlineStart: 3 }} />
      {count !== undefined && (
        <>
          <div style={{ flex: 1 }} />
          <span style={{ fontFamily: "var(--font-sans)", fontSize: 13, color: "var(--line-3)" }}>{count}</span>
        </>
      )}
    </div>
  );
}

/**
 * Biometric scan glyph — bracket frame + either the Face ID face or a
 * fingerprint. `expression` swaps the smile for a frown on the failure state.
 */
function BiometricGlyph({
  mode = "face",
  color = "var(--accent)",
  expression = "neutral",
}: {
  mode?: "face" | "fingerprint";
  color?: string;
  expression?: "neutral" | "sad";
}) {
  return (
    <div style={{ width: 72, height: 72, position: "relative", display: "flex", alignItems: "center", justifyContent: "center" }}>
      <svg width="72" height="72" viewBox="0 0 72 72" fill="none" style={{ position: "absolute", inset: 0 }}>
        <path d="M4 22 V14 a10 10 0 0 1 10 -10 H22" stroke={color} strokeWidth="3" strokeLinecap="round" />
        <path d="M50 4 H58 a10 10 0 0 1 10 10 V22" stroke={color} strokeWidth="3" strokeLinecap="round" />
        <path d="M68 50 V58 a10 10 0 0 1 -10 10 H50" stroke={color} strokeWidth="3" strokeLinecap="round" />
        <path d="M22 68 H14 a10 10 0 0 1 -10 -10 V50" stroke={color} strokeWidth="3" strokeLinecap="round" />
        {mode === "face" && (
          <>
            <path d="M27 30 V34 M45 30 V34" stroke={color} strokeWidth="3" strokeLinecap="round" />
            <path d="M36 31 V40 M32 44 h8" stroke={color} strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" />
            <path
              d={expression === "sad" ? "M29 52 q7 -5 14 0" : "M29 50 q7 5 14 0"}
              stroke={color}
              strokeWidth="3"
              strokeLinecap="round"
              fill="none"
            />
          </>
        )}
      </svg>
      {mode === "fingerprint" && <Icon name="fingerprint" size={34} color={color} strokeWidth={2.2} />}
    </div>
  );
}

// 03 · Unlock — Face ID / Fingerprint (adaptive) ──────────────────────────────
function UnlockBiometric() {
  const { biometric, isAndroid } = usePlatform();
  return (
    <Screen style={{ alignItems: "center", padding: "0 32px" }}>
      <div style={{ paddingTop: 88 }}>
        <Wordmark />
      </div>
      <div style={{ flex: 1, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center" }}>
        <Eyebrow>Locked vault</Eyebrow>
        <VaultTitle />
        <AccountLine />
        <div style={{ marginTop: 48 }}>
          <BiometricGlyph mode={isAndroid ? "fingerprint" : "face"} />
        </div>
        <div style={{ marginTop: 22, fontSize: 17, fontWeight: 500, color: "var(--fg-1)" }}>
          {isAndroid ? "Touch to unlock" : "Look to unlock"}
        </div>
        <div style={{ marginTop: 4, fontSize: 13, color: "var(--fg-3)" }}>{biometric}</div>
      </div>
      <div style={{ paddingBottom: 48, display: "flex", flexDirection: "column", alignItems: "center", gap: 14 }}>
        <div style={{ fontSize: 12, color: "var(--line-3)" }}>Locked 2 minutes ago</div>
        <TextButton>Enter passphrase instead</TextButton>
      </div>
    </Screen>
  );
}

// 04 · Unlock — Passphrase [keyboard] ─────────────────────────────────────────
function UnlockPassphrase() {
  const { biometric } = usePlatform();
  return (
    <Screen style={{ alignItems: "center", padding: "0 32px" }}>
      <div style={{ paddingTop: 84 }}>
        <Wordmark />
      </div>
      <div style={{ marginTop: 40, textAlign: "center" }}>
        <Eyebrow>Unlock vault</Eyebrow>
        <VaultTitle size={22} />
      </div>
      <div style={{ marginTop: 34, width: "100%" }}>
        <FieldLabel>Passphrase</FieldLabel>
        <MaskedField dots={9} count={9} />
        <div style={{ marginTop: 8, fontSize: 13, lineHeight: 1.5, color: "var(--fg-3)" }}>
          Never stored, never transmitted. It only decrypts your keys on this device.
        </div>
      </div>
      <Button style={{ marginTop: 18 }}>Unlock</Button>
      <TextButton height={40} style={{ marginTop: 10 }}>
        Use {biometric}
      </TextButton>
    </Screen>
  );
}

// UN-01 · Quick-unlock PIN ────────────────────────────────────────────────────
function QuickUnlockPin() {
  const keys = ["1", "2", "3", "4", "5", "6", "7", "8", "9", "", "0", "back"];
  return (
    <Screen style={{ alignItems: "center", padding: "0 28px" }}>
      <div style={{ paddingTop: 80 }}>
        <Wordmark size={22} />
      </div>
      <div style={{ marginTop: 30, textAlign: "center" }}>
        <Eyebrow>Enter PIN</Eyebrow>
        <div style={{ marginTop: 18, display: "flex", gap: 14, justifyContent: "center" }}>
          {[0, 1, 2, 3, 4, 5].map((i) => (
            <span
              key={i}
              style={{
                width: 13,
                height: 13,
                borderRadius: "50%",
                background: i < 4 ? "var(--accent)" : "transparent",
                border: i < 4 ? "none" : "1.5px solid var(--line-2)",
              }}
            />
          ))}
        </div>
      </div>
      <div style={{ flex: 1, display: "flex", flexDirection: "column", justifyContent: "center", width: "100%", maxWidth: 300 }}>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(3,1fr)", gap: "18px 22px" }}>
          {keys.map((k, i) => {
            if (k === "") return <div key={i} />;
            if (k === "back") {
              return (
                <div key={i} style={{ height: 64, display: "flex", alignItems: "center", justifyContent: "center" }}>
                  <svg width="26" height="26" viewBox="0 0 26 26" fill="none">
                    <path
                      d="M9 5h11a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H9L2 13z"
                      stroke="var(--fg-2)"
                      strokeWidth={1.6}
                      strokeLinejoin="round"
                    />
                    <path d="M11 10l6 6M17 10l-6 6" stroke="var(--fg-2)" strokeWidth={1.6} strokeLinecap="round" />
                  </svg>
                </div>
              );
            }
            return (
              <div
                key={i}
                style={{ height: 64, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 28, fontWeight: 400, color: "var(--fg-1)" }}
              >
                {k}
              </div>
            );
          })}
        </div>
      </div>
      <div style={{ paddingBottom: 46 }}>
        <TextButton>Use your password</TextButton>
      </div>
    </Screen>
  );
}

// UN-02 · Biometric failure ───────────────────────────────────────────────────
function BiometricFailure() {
  const { biometric, isAndroid } = usePlatform();
  return (
    <Screen style={{ alignItems: "center", padding: "0 32px" }}>
      <div style={{ paddingTop: 88 }}>
        <Wordmark />
      </div>
      <div style={{ flex: 1, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center" }}>
        <Eyebrow>Locked vault</Eyebrow>
        <VaultTitle />
        <div style={{ marginTop: 44 }}>
          <BiometricGlyph mode={isAndroid ? "fingerprint" : "face"} color="var(--line-3)" expression="sad" />
        </div>
        <div style={{ marginTop: 22, fontSize: 17, fontWeight: 500, color: "var(--fg-1)" }}>
          {biometric} couldn't confirm it's you
        </div>
        <div style={{ marginTop: 6, fontSize: 14, color: "var(--fg-3)", textAlign: "center", maxWidth: 260 }}>
          Try again, or unlock with your passphrase.
        </div>
      </div>
      <div style={{ paddingBottom: 46, width: "100%", display: "flex", flexDirection: "column", gap: 10 }}>
        <Button>Try {biometric} again</Button>
        <Button variant="secondary" style={{ height: 48 }}>
          Enter passphrase
        </Button>
      </div>
    </Screen>
  );
}

// UN-03 · Recovery in progress ────────────────────────────────────────────────
function RecoveryInProgress() {
  return (
    <Screen style={{ alignItems: "center", padding: "0 28px" }}>
      <div
        style={{
          width: "100%",
          marginTop: 52,
          background: "color-mix(in srgb, var(--success) 12%, transparent)",
          border: "1px solid color-mix(in srgb, var(--success) 30%, transparent)",
          borderRadius: 8,
          padding: "12px 14px",
          display: "flex",
          gap: 10,
          alignItems: "flex-start",
        }}
      >
        <Icon name="info" size={18} color="var(--success)" style={{ marginTop: 1 }} />
        <div style={{ fontSize: 13, lineHeight: 1.5, color: "var(--success)" }}>
          You have a recovery in progress. Continue to finish setting a new password for this device.
        </div>
      </div>
      <div style={{ flex: 1, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center" }}>
        <Eyebrow>Resuming</Eyebrow>
        <VaultTitle />
        <AccountLine />
      </div>
      <div style={{ paddingBottom: 46, width: "100%" }}>
        <Button>Continue recovery</Button>
      </div>
    </Screen>
  );
}

// UN-04 · Suspicion banner [keyboard] ─────────────────────────────────────────
function SuspicionBanner() {
  return (
    <Screen style={{ alignItems: "center", padding: "0 28px" }}>
      <Banner
        kind="danger"
        style={{ marginTop: 52, border: "1px solid color-mix(in srgb, var(--danger) 25%, transparent)" }}
      >
        This vault was modified in another session. Unlock to review before making changes.
      </Banner>
      <div style={{ marginTop: 26, textAlign: "center" }}>
        <Eyebrow>Unlock vault</Eyebrow>
        <VaultTitle size={22} />
      </div>
      <div style={{ marginTop: 28, width: "100%" }}>
        <FieldLabel>Passphrase</FieldLabel>
        <MaskedField dots={8} />
      </div>
      <Button style={{ marginTop: 16 }}>Unlock</Button>
    </Screen>
  );
}

// UN-05 · Password unlock (no quick-unlock) [keyboard] ────────────────────────
function PasswordUnlock() {
  return (
    <Screen style={{ alignItems: "center", padding: "0 32px" }}>
      <div style={{ paddingTop: 84 }}>
        <Wordmark />
      </div>
      <div style={{ marginTop: 36, textAlign: "center" }}>
        <Eyebrow>Unlock vault</Eyebrow>
        <VaultTitle size={22} />
      </div>
      <div style={{ marginTop: 30, width: "100%" }}>
        <FieldLabel>Password</FieldLabel>
        <PasswordField length={10} />
      </div>
      <Button style={{ marginTop: 16 }}>Unlock</Button>
      <div style={{ flex: 1 }} />
      <div style={{ paddingBottom: 18, display: "flex", flexDirection: "column", alignItems: "center", gap: 12 }}>
        <TextButton height={40}>Use your recovery phrase</TextButton>
        <TextButton height={40} fontSize={14} color="var(--danger)">
          Delete vault and start over
        </TextButton>
      </div>
    </Screen>
  );
}

// UN-06 · Lock now (just locked) ──────────────────────────────────────────────
function LockNow() {
  const { biometric, isAndroid } = usePlatform();
  return (
    <Screen style={{ alignItems: "center", padding: "0 32px" }}>
      <div
        style={{
          position: "absolute",
          top: 52,
          insetInlineStart: 20,
          insetInlineEnd: 20,
          zIndex: 3,
          background: "var(--ink-1)",
          color: "var(--paper)",
          borderRadius: 10,
          padding: "12px 14px",
          display: "flex",
          alignItems: "center",
          gap: 10,
          boxShadow: "var(--shadow-3)",
        }}
      >
        <Icon name="lock" size={17} color="var(--paper)" strokeWidth={1.5} />
        <span style={{ fontSize: 14, fontWeight: 500 }}>Vault locked</span>
      </div>
      <div style={{ paddingTop: 88 }}>
        <Wordmark />
      </div>
      <div style={{ flex: 1, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center" }}>
        <Eyebrow>Locked vault</Eyebrow>
        <VaultTitle />
        <div style={{ marginTop: 48 }}>
          <BiometricGlyph mode={isAndroid ? "fingerprint" : "face"} />
        </div>
        <div style={{ marginTop: 22, fontSize: 17, fontWeight: 500, color: "var(--fg-1)" }}>
          {isAndroid ? "Touch to unlock" : "Look to unlock"}
        </div>
        <div style={{ marginTop: 4, fontSize: 13, color: "var(--fg-3)" }}>{biometric}</div>
      </div>
      <div style={{ paddingBottom: 48 }}>
        <TextButton>Enter passphrase instead</TextButton>
      </div>
    </Screen>
  );
}

export const unlockScreens: ScreenDef[] = [
  { id: "03", label: "Unlock — Face ID / Fingerprint", Component: UnlockBiometric },
  { id: "04", label: "Unlock — Passphrase", Component: UnlockPassphrase, keyboard: true },
  { id: "UN-01", label: "Quick-unlock PIN", Component: QuickUnlockPin },
  { id: "UN-02", label: "Biometric failure", Component: BiometricFailure },
  { id: "UN-03", label: "Recovery in progress", Component: RecoveryInProgress },
  { id: "UN-04", label: "Suspicion banner", Component: SuspicionBanner, keyboard: true },
  { id: "UN-05", label: "Password unlock (no quick-unlock)", Component: PasswordUnlock, keyboard: true },
  { id: "UN-06", label: "Lock now (just locked)", Component: LockNow },
];
