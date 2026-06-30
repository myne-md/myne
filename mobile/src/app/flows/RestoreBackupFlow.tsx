import { Screen, Title, Lead, Button, MyneMark } from "../../components";
import type { RestoreBackupFlowProps } from "./types";

/**
 * Restore-from-backup — wired placeholder.
 *
 * Backup/restore is a Phase-2 capability that the mobile backend does not yet
 * include, so there is no IPC to call here. Rather than show the desktop-style
 * restore UI (the BK-01 static screen) and dead-end on a missing command, this
 * renders an honest on-brand notice and routes the user back out to the flows
 * that *do* work on mobile (create / recover). The shell maps `onDone` to an
 * out-of-band re-probe, which lands on welcome or the picker as appropriate.
 */
export function RestoreBackupFlow({ onDone }: RestoreBackupFlowProps) {
  return (
    <Screen style={{ padding: "0 30px" }}>
      <div style={{ paddingTop: 96, display: "flex", alignItems: "center", gap: 10 }}>
        <MyneMark size={28} radius={6} />
        <span
          style={{ fontSize: 21, fontWeight: 600, letterSpacing: "-0.02em", color: "var(--fg-1)" }}
        >
          myne
        </span>
      </div>
      <div
        style={{
          flex: 1,
          display: "flex",
          flexDirection: "column",
          justifyContent: "center",
          paddingBottom: 40,
        }}
      >
        <Title style={{ fontSize: 30 }}>Not available on mobile yet</Title>
        <Lead style={{ marginTop: 14, fontSize: 16, maxWidth: 320 }}>
          Restoring from a backup file is not available on mobile yet — create a vault or recover
          with your phrase.
        </Lead>
      </div>
      <div style={{ paddingBottom: 52 }}>
        <Button onClick={onDone}>Back</Button>
      </div>
    </Screen>
  );
}
