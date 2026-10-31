// Endpoint screen — vault.meta has just been written to disk.
//
// Implements design session 2026-04-28-vault-creation-frontend.md Q9:
//   - No eyebrow (endpoint, not a numbered step).
//   - Success indicator: circle-check icon, var(--success).
//   - "Done" → calls the `onDone` callback prop. The orchestrator
//     (<CreateVault>) wires it through to App.tsx, which transitions
//     the stage to the terminal `editor` screen. Originally this called
//     `getCurrentWindow().close()`; revised by
//     myne-agents/features/empty-editor-shell/prd.md (2026-04-28).
//     Vault-detected Welcome and lock/relock semantics remain a future
//     vault-unlock feature — until then, the editor is terminal and
//     there is no path back to Welcome from inside it.
//
// The two local-disk affordances ("Back up now", "Show vault folder") that
// used to sit under "Done" are gone (myne-md/myne#960), which reverses MYND-56
// task 7 / B13(b) and is recorded in `docs/decisions/ui/`. A vault created a
// second ago has no history to lose, the backup that matters is a standing
// schedule (`Settings → Storage → Automatic backups`) rather than one taken at
// the moment of peak reading, and the folder reveal exists for hand-copying the
// vault directory: the copy path the verified `.myne-backup` write replaces.
// The web client's substitute module went with them, so the whole substitution
// edge is gone rather than rendering nothing.
//
// Window-close prompt (Task 12) explicitly excludes ReadyStep — vault
// is committed, no progress to discard.

import { useTranslation } from "react-i18next";
import { Button } from "../../components/primitives/Button";
import { Icon } from "../../components/primitives/Icon";
import { StepHeading, StepLayout } from "./step-shell";

interface ReadyStepProps {
  onDone: () => void;
  /**
   * True while the auto-unlock IPC is in flight (PRD Q4(a)). Disables the
   * button and switches the "Done" label to "Decrypting…" so the user sees
   * that the click registered and Argon2id is running (~1s baseline). False
   * during the brief window between mount and "Done" click.
   */
  pending?: boolean;
}

export function ReadyStep({ onDone, pending = false }: ReadyStepProps) {
  const { t } = useTranslation();
  return (
    <StepLayout align="center">
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          width: 56,
          height: 56,
          borderRadius: "var(--radius-pill)",
          color: "var(--success)",
          background: "color-mix(in srgb, var(--success) 14%, transparent)",
        }}
      >
        <Icon name="check" size={28} />
      </div>

      <StepHeading centered>{t("vaultCreation.ready.heading")}</StepHeading>

      <div
        style={{
          fontSize: "var(--text-base)",
          lineHeight: 1.6,
          color: "var(--fg-2)",
          textAlign: "center",
          maxWidth: 380,
        }}
      >
        {t("vaultCreation.ready.body")}
      </div>

      {/* One way forward, and it is the only one: the endpoint of a creation
          flow should not offer branches (myne-md/myne#960). */}
      <Button
        variant="primary"
        onClick={onDone}
        disabled={pending}
        data-testid="create.ready-done"
        style={{ minWidth: 220, justifyContent: "center", marginTop: "var(--space-2)" }}
      >
        {pending ? t("vaultCreation.ready.decrypting") : t("vaultCreation.ready.done")}
      </Button>
    </StepLayout>
  );
}
