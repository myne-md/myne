import type { ReactNode } from "react";
import {
  Screen,
  ScreenScroll,
  FlowHeader,
  Title,
  Lead,
  FooterBar,
  Button,
  Field,
  PasswordField,
  StrengthMeter,
  RecoveryGrid,
  AccountNumber,
  Checkbox,
  Icon,
  MyneMark,
  Banner,
  BlockingOverlay,
} from "../../components";
import type { ScreenDef } from "../../gallery/types";

const PHRASE = [
  "ribbon", "kernel", "voyage", "marble", "harvest", "cobalt",
  "thistle", "quarry", "lantern", "pebble", "summit", "cedar",
];

/** Wordmark: mark + "myne". */
function Wordmark({ size = 28 }: { size?: number }) {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
      <MyneMark size={size} radius={6} />
      <span style={{ fontSize: 21, fontWeight: 600, letterSpacing: "-0.02em", color: "var(--fg-1)" }}>
        myne
      </span>
    </div>
  );
}

// 01 · Welcome ────────────────────────────────────────────────────────────────
function Welcome() {
  return (
    <Screen style={{ padding: "0 30px" }}>
      <div style={{ paddingTop: 96 }}>
        <Wordmark />
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
        <Button>Create a vault</Button>
        <Button variant="ghost">I already have a recovery phrase</Button>
      </div>
    </Screen>
  );
}

// Checklist row used by the safety briefing.
function CheckRow({
  checked,
  children,
  why,
  whyOpen,
  last,
}: {
  checked?: boolean;
  children: ReactNode;
  why?: ReactNode;
  whyOpen?: boolean;
  last?: boolean;
}) {
  return (
    <div
      style={{
        display: "flex",
        gap: 12,
        padding: "14px 0",
        borderTop: "1px solid var(--line-1)",
        borderBottom: last ? "1px solid var(--line-1)" : undefined,
      }}
    >
      <div
        style={{
          flex: "none",
          width: 22,
          height: 22,
          borderRadius: 4,
          background: checked ? "var(--accent)" : "var(--bg-1)",
          border: checked ? "none" : "1.5px solid var(--line-2)",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
        }}
      >
        {checked && <Icon name="check" size={13} color="var(--accent-on)" strokeWidth={2.4} />}
      </div>
      <div style={{ flex: 1 }}>
        <div style={{ fontSize: 15, lineHeight: 1.45, color: "var(--fg-1)" }}>{children}</div>
        {why && (
          <>
            <div
              style={{
                marginTop: 8,
                display: "inline-flex",
                alignItems: "center",
                gap: 5,
                color: "var(--accent)",
                fontSize: 13,
                fontWeight: 500,
              }}
            >
              Why?
              <Icon name={whyOpen ? "chevron-up" : "chevron-down"} size={11} color="var(--accent)" strokeWidth={1.6} />
            </div>
            {whyOpen && (
              <div
                style={{
                  marginTop: 8,
                  background: "var(--bg-2)",
                  border: "1px solid var(--line-1)",
                  borderRadius: 6,
                  padding: "10px 12px",
                  fontSize: 13,
                  lineHeight: 1.55,
                  color: "var(--fg-2)",
                }}
              >
                {why}
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}

// OB-01 · Safety briefing ─────────────────────────────────────────────────────
function SafetyBriefing() {
  return (
    <Screen>
      <FlowHeader label="Create a vault · 1 of 5" />
      <ScreenScroll style={{ padding: "18px 22px 0" }}>
        <Title>Before we begin</Title>
        <Lead>
          Myne encrypts everything on this device. That privacy comes with a responsibility only you
          can hold.
        </Lead>
        <Banner kind="danger" icon={false} style={{ marginTop: 16 }}>
          If you lose both your password and recovery phrase, your notes are unrecoverable. We cannot
          help.
        </Banner>
        <div style={{ marginTop: 20, display: "flex", flexDirection: "column", gap: 2 }}>
          <CheckRow checked>Myne has no access to my notes and cannot read or recover them.</CheckRow>
          <CheckRow
            why="Your password and phrase never leave this device. Nothing on our servers can decrypt them, so there is nothing for us to reset."
            whyOpen
          >
            There is no password reset and no email recovery.
          </CheckRow>
          <CheckRow why="—" last>
            My 24-word recovery phrase is the only way back into my vault.
          </CheckRow>
        </div>
      </ScreenScroll>
      <FooterBar>
        <Button variant="secondary" full={false}>
          Back
        </Button>
        <Button disabled>Continue</Button>
      </FooterBar>
    </Screen>
  );
}

// Small uppercase field label.
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

// OB-02 · Create password ─────────────────────────────────────────────────────
function CreatePassword() {
  return (
    <Screen>
      <FlowHeader label="Create a vault · 2 of 5" />
      <div style={{ flex: 1, padding: "18px 22px 0" }}>
        <Title>Create a password</Title>
        <div style={{ marginTop: 22 }}>
          <FieldLabel>Password</FieldLabel>
          <PasswordField focused length={12} />
        </div>
        <div style={{ marginTop: 10 }}>
          <StrengthMeter level="Strong" />
        </div>
        <div style={{ marginTop: 20 }}>
          <FieldLabel>Confirm password</FieldLabel>
          <Field
            value={<span style={{ fontFamily: "var(--font-mono)", fontSize: 20, letterSpacing: "0.14em" }}>••••••••••••</span>}
            trailing={<Icon name="check" size={14} color="var(--success)" strokeWidth={2} />}
          />
        </div>
        <div style={{ marginTop: 10, fontSize: 13, lineHeight: 1.5, color: "var(--fg-3)" }}>
          Never stored, never transmitted. It encrypts your keys on this device.
        </div>
      </div>
      <FooterBar style={{ padding: "14px 20px" }}>
        <Button variant="secondary" full={false}>
          Back
        </Button>
        <Button>Continue</Button>
      </FooterBar>
    </Screen>
  );
}

// OB-03 · Encrypting (blocking) ───────────────────────────────────────────────
function Encrypting() {
  return (
    <Screen>
      <BlockingOverlay
        title="Encrypting…"
        subtitle="Deriving your key with Argon2id. This takes a few seconds and can't be interrupted."
      />
    </Screen>
  );
}

// OB · Recovery phrase reveal ─────────────────────────────────────────────────
function PhraseReveal() {
  return (
    <Screen style={{ padding: "64px 24px 40px" }}>
      <Title>Your recovery phrase</Title>
      <p style={{ margin: "10px 0 0", fontSize: 14, lineHeight: 1.55, color: "var(--fg-3)" }}>
        Twenty-four words, in order. Write them on paper and store them somewhere safe.
      </p>
      <Banner kind="danger" icon={false} style={{ marginTop: 16 }}>
        This is the only key to your vault. We can't reset it — lose these words and the notes are
        gone for good.
      </Banner>
      <div style={{ marginTop: 20 }}>
        <RecoveryGrid words={PHRASE} />
      </div>
      <Button
        variant="secondary"
        style={{ marginTop: 14, height: 40, fontFamily: "var(--font-mono)", fontSize: 13, fontWeight: 500 }}
      >
        Show words 13–24
      </Button>
      <div style={{ flex: 1 }} />
      <Button style={{ marginTop: 18 }}>I've written them down</Button>
    </Screen>
  );
}

// A single type-back word field with its label + optional error.
function WordField({
  index,
  state,
  value,
  error,
}: {
  index: number;
  state: "filled" | "error" | "focused" | "empty";
  value?: string;
  error?: string;
}) {
  return (
    <div>
      <div style={{ fontFamily: "var(--font-mono)", fontSize: 11, color: "var(--line-3)", marginBottom: 6 }}>
        WORD #{index}
      </div>
      <div
        style={{
          display: "flex",
          alignItems: "center",
          height: 50,
          border:
            state === "error"
              ? "1.5px solid var(--danger)"
              : state === "focused"
                ? "1.5px solid var(--accent)"
                : "1px solid var(--line-2)",
          borderRadius: 6,
          background: "var(--bg-1)",
          padding: "0 14px",
          boxShadow: state === "focused" ? "0 0 0 3px color-mix(in srgb, var(--accent) 14%, transparent)" : "none",
        }}
      >
        {value && (
          <span style={{ fontFamily: "var(--font-mono)", fontSize: 16, fontWeight: 500, color: "var(--fg-1)" }}>
            {value}
          </span>
        )}
        {state === "focused" && <span style={{ width: 2, height: 22, background: "var(--accent)" }} />}
      </div>
      {error && (
        <div style={{ marginTop: 6, display: "flex", alignItems: "center", gap: 6, color: "var(--danger)", fontSize: 13 }}>
          <Icon name="info" size={14} color="var(--danger)" strokeWidth={1.4} />
          {error}
        </div>
      )}
    </div>
  );
}

// OB-04 · Type-back confirmation ──────────────────────────────────────────────
function TypeBack() {
  return (
    <Screen>
      <FlowHeader label="Create a vault · 3 of 5" />
      <div style={{ flex: 1, padding: "18px 22px 0" }}>
        <Title>Confirm your phrase</Title>
        <Lead>Enter these four words from the recovery phrase you just saved.</Lead>
        <div style={{ marginTop: 22, display: "flex", flexDirection: "column", gap: 16 }}>
          <WordField index={3} state="filled" value="voyage" />
          <WordField index={7} state="error" value="thirstle" error="Doesn't match word #7" />
          <WordField index={14} state="focused" />
          <WordField index={21} state="empty" />
        </div>
      </div>
      <FooterBar style={{ padding: "14px 20px" }}>
        <Button variant="secondary" full={false} style={{ fontSize: 14, padding: "0 18px" }}>
          Back to phrase
        </Button>
        <Button disabled>Continue</Button>
      </FooterBar>
    </Screen>
  );
}

// OB-05 · Account number ──────────────────────────────────────────────────────
function AccountNumberScreen() {
  return (
    <Screen>
      <FlowHeader label="Create a vault · 4 of 5" />
      <div style={{ flex: 1, padding: "18px 22px 0" }}>
        <Title>Your account number</Title>
        <Lead>
          Save this alongside your recovery phrase. You'll need it to restore your vault on a new
          device.
        </Lead>
        <div style={{ marginTop: 20 }}>
          <AccountNumber />
        </div>
        <div style={{ marginTop: 14, display: "flex", gap: 10 }}>
          <Button variant="secondary" style={{ height: 46, fontSize: 14 }}>
            <Icon name="copy" size={16} color="var(--fg-2)" strokeWidth={1.5} />
            Copy
          </Button>
          <Button variant="secondary" style={{ height: 46, fontSize: 14 }}>
            <Icon name="download" size={16} color="var(--fg-2)" strokeWidth={1.5} />
            Save as file
          </Button>
        </div>
        <div style={{ marginTop: 22, display: "flex", gap: 12, paddingTop: 16, borderTop: "1px solid var(--line-1)" }}>
          <Checkbox checked />
          <div style={{ flex: 1, fontSize: 15, lineHeight: 1.45, color: "var(--fg-1)" }}>
            I have saved my account number.
          </div>
        </div>
      </div>
      <FooterBar>
        <Button variant="secondary" full={false}>
          Back
        </Button>
        <Button>Commit</Button>
      </FooterBar>
    </Screen>
  );
}

// OB-06 · Ready / vault created ───────────────────────────────────────────────
function Ready() {
  return (
    <Screen style={{ alignItems: "center", padding: "0 30px" }}>
      <div
        style={{
          flex: 1,
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          justifyContent: "center",
          textAlign: "center",
        }}
      >
        <Wordmark />
        <h1
          style={{
            margin: "26px 0 0",
            fontSize: 30,
            lineHeight: 1.12,
            letterSpacing: "-0.025em",
            fontWeight: 600,
            color: "var(--fg-display)",
          }}
        >
          Your vault is ready
        </h1>
        <p style={{ margin: "12px 0 0", fontSize: 16, lineHeight: 1.6, color: "var(--fg-2)", maxWidth: 300 }}>
          Everything you write from here is encrypted on this device before it's stored or synced.
        </p>
        <div
          style={{
            marginTop: 18,
            display: "inline-flex",
            alignItems: "center",
            gap: 8,
            background: "var(--bg-2)",
            border: "1px solid var(--line-1)",
            borderRadius: 999,
            padding: "7px 14px",
          }}
        >
          <span style={{ width: 7, height: 7, borderRadius: "50%", background: "var(--success)" }} />
          <span style={{ fontSize: 13, color: "var(--fg-2)" }}>Personal · </span>
          <span style={{ fontFamily: "var(--font-mono)", fontSize: 13, color: "var(--fg-2)" }}>
            MY‑4F2A‑9C17‑8E2D
          </span>
        </div>
      </div>
      <div style={{ flex: "none", paddingBottom: 52, width: "100%", display: "flex", flexDirection: "column", gap: 10 }}>
        <Button>Open vault</Button>
        <Button variant="secondary">Back up now</Button>
      </div>
    </Screen>
  );
}

// OB-07 · Session lost ────────────────────────────────────────────────────────
function SessionLost() {
  return (
    <Screen style={{ alignItems: "center", padding: "0 32px" }}>
      <div
        style={{
          flex: 1,
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          justifyContent: "center",
          textAlign: "center",
        }}
      >
        <svg width="44" height="44" viewBox="0 0 44 44" fill="none">
          <circle cx="22" cy="22" r="19" stroke="var(--line-2)" strokeWidth="1.6" />
          <path d="M22 13v11M22 30h.02" stroke="var(--fg-3)" strokeWidth="1.8" strokeLinecap="round" />
        </svg>
        <h1
          style={{
            margin: "22px 0 0",
            fontSize: 26,
            lineHeight: 1.15,
            letterSpacing: "-0.02em",
            fontWeight: 600,
            color: "var(--fg-display)",
          }}
        >
          Setup was interrupted
        </h1>
        <p style={{ margin: "12px 0 0", fontSize: 16, lineHeight: 1.6, color: "var(--fg-2)", maxWidth: 300 }}>
          Your create session ended before the vault was finished. Nothing partial was saved to this
          device, so it's safe to begin again.
        </p>
      </div>
      <div style={{ flex: "none", paddingBottom: 52, width: "100%" }}>
        <Button>Start over</Button>
      </div>
    </Screen>
  );
}

export const onboardingScreens: ScreenDef[] = [
  { id: "01", label: "Welcome", Component: Welcome },
  { id: "OB-01", label: "Safety briefing", Component: SafetyBriefing },
  { id: "OB-02", label: "Create password", Component: CreatePassword, keyboard: true },
  { id: "OB-03", label: "Encrypting (blocking)", Component: Encrypting },
  { id: "OB", label: "Recovery phrase reveal", Component: PhraseReveal },
  { id: "OB-04", label: "Type-back confirmation", Component: TypeBack, keyboard: true },
  { id: "OB-05", label: "Account number", Component: AccountNumberScreen },
  { id: "OB-06", label: "Ready / vault created", Component: Ready },
  { id: "OB-07", label: "Session lost", Component: SessionLost },
];
