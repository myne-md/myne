import type { ReactNode } from "react";
import {
  Screen,
  ScreenScroll,
  FlowHeader,
  Eyebrow,
  Title,
  Lead,
  FooterBar,
  Button,
  Field,
  PasswordField,
  BlockingOverlay,
} from "../../components";
import type { ScreenDef } from "../../gallery/types";

// Small uppercase field label (12px / 600 / 0.06em).
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

// RC-01 · Account number ───────────────────────────────────────────────────────
function AccountNumberEntry() {
  return (
    <Screen>
      <FlowHeader label="Restore a vault" />
      <div style={{ flex: 1, padding: "18px 22px 0" }}>
        <Title>Enter your account number</Title>
        <Lead>Find this where you saved your recovery phrase. It identifies the vault to restore.</Lead>
        <div style={{ marginTop: 22 }}>
          <FieldLabel>Account number</FieldLabel>
          <div
            style={{
              display: "flex",
              alignItems: "center",
              height: 52,
              border: "1.5px solid var(--danger)",
              borderRadius: 6,
              background: "var(--bg-1)",
              padding: "0 14px",
            }}
          >
            <span
              style={{
                fontFamily: "var(--font-mono)",
                fontSize: 16,
                letterSpacing: "0.04em",
                color: "var(--fg-1)",
              }}
            >
              MY‑4F2A‑9C17‑8E2Q
            </span>
            <span style={{ width: 2, height: 22, background: "var(--accent)", marginLeft: 2 }} />
          </div>
          <div
            style={{
              marginTop: 8,
              display: "flex",
              alignItems: "center",
              gap: 6,
              color: "var(--danger)",
              fontSize: 13,
            }}
          >
            <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
              <circle cx="8" cy="8" r="6.5" stroke="var(--danger)" strokeWidth="1.4" />
              <path d="M8 5v4M8 11h.01" stroke="var(--danger)" strokeWidth="1.4" strokeLinecap="round" />
            </svg>
            Invalid account number — please check and re-enter.
          </div>
        </div>
      </div>
      <FooterBar style={{ padding: "14px 20px", borderTop: "none" }}>
        <Button>Continue</Button>
      </FooterBar>
    </Screen>
  );
}

// A single recovery-phrase grid cell.
function WordCell({
  n,
  word,
  state,
}: {
  n: string;
  word?: string;
  state: "filled" | "focused" | "empty";
}) {
  const border =
    state === "focused"
      ? "1.5px solid var(--accent)"
      : state === "filled"
        ? "1px solid var(--line-1)"
        : "1px solid var(--line-2)";
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: 8,
        height: 42,
        background: state === "filled" ? "var(--bg-2)" : "var(--bg-1)",
        border,
        borderRadius: 6,
        padding: "0 11px",
        boxShadow:
          state === "focused" ? "0 0 0 3px color-mix(in srgb, var(--accent) 12%, transparent)" : "none",
      }}
    >
      <span
        style={{
          fontFamily: "var(--font-mono)",
          fontSize: 11,
          color: "var(--line-3)",
          width: 16,
          textAlign: "right",
          flexShrink: 0,
        }}
      >
        {n}
      </span>
      {word && (
        <span style={{ fontFamily: "var(--font-mono)", fontSize: 14, color: "var(--fg-1)" }}>{word}</span>
      )}
      {state === "focused" && <span style={{ width: 2, height: 18, background: "var(--accent)" }} />}
    </div>
  );
}

const CELLS: { n: string; w?: string; state: "filled" | "focused" | "empty" }[] = [
  { n: "01", w: "ribbon", state: "filled" },
  { n: "02", w: "kernel", state: "filled" },
  { n: "03", w: "voyage", state: "filled" },
  { n: "04", w: "marble", state: "filled" },
  { n: "05", w: "harvest", state: "filled" },
  { n: "06", state: "focused" },
  { n: "07", state: "empty" },
  { n: "08", state: "empty" },
  { n: "09", state: "empty" },
  { n: "10", state: "empty" },
  { n: "11", state: "empty" },
  { n: "12", state: "empty" },
  { n: "13", state: "empty" },
  { n: "14", state: "empty" },
];

// RC-02 · Phrase entry (24 words) ──────────────────────────────────────────────
function PhraseEntry() {
  return (
    <Screen>
      <div
        style={{
          flex: "none",
          padding: "56px 16px 10px",
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          borderBottom: "1px solid var(--line-1)",
        }}
      >
        <button
          style={{
            border: "none",
            background: "transparent",
            color: "var(--fg-3)",
            fontSize: 15,
            fontWeight: 500,
            cursor: "pointer",
          }}
        >
          Cancel
        </button>
        <div style={{ fontSize: 15, fontWeight: 600, color: "var(--fg-1)" }}>Recovery phrase</div>
        <button
          style={{
            border: "none",
            background: "transparent",
            color: "var(--accent)",
            fontSize: 14,
            fontWeight: 600,
            cursor: "pointer",
            display: "flex",
            alignItems: "center",
            gap: 4,
          }}
        >
          <svg width="15" height="15" viewBox="0 0 20 20" fill="none">
            <rect x="6" y="6" width="11" height="11" rx="2" stroke="var(--accent)" strokeWidth="1.5" />
            <path d="M3 12V4a1 1 0 0 1 1-1h8" stroke="var(--accent)" strokeWidth="1.5" />
          </svg>
          Paste
        </button>
      </div>
      <ScreenScroll style={{ padding: "14px 16px 8px" }}>
        <div style={{ fontSize: 13, lineHeight: 1.5, color: "var(--fg-3)", marginBottom: 12 }}>
          Type each word, or paste all 24 at once to fill the grid.
        </div>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
          {CELLS.map((c) => (
            <WordCell key={c.n} n={c.n} word={c.w} state={c.state} />
          ))}
        </div>
      </ScreenScroll>
      <FooterBar style={{ flexDirection: "column", gap: 8, padding: "10px 16px 12px" }}>
        <Button disabled style={{ height: 50 }}>
          Submit · 5 of 24
        </Button>
        <Button variant="ghost" style={{ height: 40, color: "var(--danger)", fontSize: 14, fontWeight: 600 }}>
          Delete vault and start over
        </Button>
      </FooterBar>
    </Screen>
  );
}

// RC-03 · Decrypting (blocking) ────────────────────────────────────────────────
function Decrypting() {
  return (
    <Screen>
      <BlockingOverlay
        title="Decrypting…"
        subtitle="Rebuilding your vault keys with Argon2id. This takes a few seconds."
      />
    </Screen>
  );
}

// RC-04 · Set a new password ───────────────────────────────────────────────────
function NewPassword() {
  return (
    <Screen>
      <div style={{ flex: "none", padding: "56px 20px 0" }}>
        <Eyebrow>Restore a vault</Eyebrow>
      </div>
      <div style={{ flex: 1, padding: "14px 22px 0" }}>
        <Title>Choose a new password</Title>
        <Lead>Your recovery phrase stays the same. This sets the password for this device.</Lead>
        <div style={{ marginTop: 20 }}>
          <FieldLabel>New password</FieldLabel>
          <PasswordField length={10} />
        </div>
        <div style={{ marginTop: 10, display: "flex", alignItems: "center", gap: 10 }}>
          <div style={{ flex: 1, display: "flex", gap: 4 }}>
            <div style={{ flex: 1, height: 4, borderRadius: 999, background: "var(--accent)" }} />
            <div style={{ flex: 1, height: 4, borderRadius: 999, background: "var(--accent)" }} />
            <div style={{ flex: 1, height: 4, borderRadius: 999, background: "var(--line-1)" }} />
            <div style={{ flex: 1, height: 4, borderRadius: 999, background: "var(--line-1)" }} />
          </div>
          <span style={{ fontSize: 13, fontWeight: 500, color: "var(--fg-2)" }}>Fair</span>
        </div>
        <div style={{ marginTop: 20 }}>
          <FieldLabel>Confirm password</FieldLabel>
          <Field
            value={
              <span style={{ fontFamily: "var(--font-mono)", fontSize: 20, letterSpacing: "0.14em" }}>
                {"•".repeat(10)}
              </span>
            }
          />
        </div>
        <div style={{ marginTop: 10, fontSize: 13, lineHeight: 1.5, color: "var(--fg-3)" }}>
          Never stored, never transmitted. It encrypts your keys on this device.
        </div>
      </div>
      <FooterBar style={{ padding: "14px 20px", borderTop: "none" }}>
        <Button>Continue</Button>
      </FooterBar>
    </Screen>
  );
}

export const recoverScreens: ScreenDef[] = [
  { id: "RC-01", label: "Account number", Component: AccountNumberEntry, keyboard: true },
  { id: "RC-02", label: "Phrase entry (24 words)", Component: PhraseEntry, keyboard: true },
  { id: "RC-03", label: "Decrypting (blocking)", Component: Decrypting },
  { id: "RC-04", label: "Set a new password", Component: NewPassword, keyboard: true },
];
