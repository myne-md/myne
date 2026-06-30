import { Screen, Button, MyneMark } from "../../components";
import type { WelcomeFlowProps } from "./types";

/** 01 · Welcome — wired. Routes into create / recover. */
export function WelcomeFlow({ onCreate, onRecover }: WelcomeFlowProps) {
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
        <Button onClick={onCreate}>Create a vault</Button>
        <Button variant="ghost" onClick={onRecover}>
          I already have a recovery phrase
        </Button>
      </div>
    </Screen>
  );
}
