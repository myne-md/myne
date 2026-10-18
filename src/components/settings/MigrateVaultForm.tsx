// The whole-vault v0.1 → v0.2 migration form (automerge-sync-migration #420,
// task 3). An opt-in Settings surface: the app opens both MYV1 and NTV5 vaults,
// so migration is user-initiated, not a forced refuse-and-prompt.
//
// The recovery phrase is REQUIRED and verified backend-side (a wrong/missing
// phrase → `RecoveryPhraseRequired`, writing nothing), so this form cannot strand
// recovery even with a UI bug. Tone is honest-not-alarming (PRODUCT.md): migration
// is a normal upgrade, not a danger — no red banners, no alarm icons; the one calm
// caution is that it re-keys the whole vault and is one-way (the old vault survives
// in a device-local `legacy/` snapshot until confirmed).

import { useEffect, useState, type ChangeEvent, type ClipboardEvent } from "react";
import { useTranslation } from "react-i18next";
import { PasswordInput } from "../PasswordInput";
import { Button } from "../primitives/Button";
import { PhraseEntryGrid, PHRASE_CELL_COUNT } from "../PhraseEntryGrid";
import {
  isAlreadyMigrated,
  isRecoveryPhraseRequired,
  migrateVault,
  migrationProgress,
  type MigrationProgress,
  type VaultMigrateSummary,
} from "../../lib/vault-migrate";

type State =
  | { kind: "idle" }
  | { kind: "migrating" }
  | { kind: "done"; summary: VaultMigrateSummary }
  | { kind: "error"; messageKey: string };

/**
 * Map a `vault_migrate` rejection to its i18n copy key (pure — unit-tested
 * without the async component). `RecoveryPhraseRequired` gets phrase-specific
 * copy (the load-bearing refusal); a wrong password and an already-migrated
 * vault get their own; everything else is the calm generic.
 */
export function migrateErrorMessageKey(e: unknown): string {
  if (isRecoveryPhraseRequired(e)) return "migrate.error.recoveryPhraseRequired";
  if (isAlreadyMigrated(e)) return "migrate.error.alreadyMigrated";
  if ((e as { kind?: string } | null | undefined)?.kind === "InvalidCredentialOrVault") {
    return "migrate.error.wrongPassword";
  }
  return "migrate.error.generic";
}

export interface MigrateVaultFormProps {
  /**
   * Fired after a successful migration. Migration is a RE-KEY event — the backend
   * mints a fresh `root_key` + `itemsKey` and drops the running slot, so the app
   * must route back to Unlock and re-derive the new keys. The Settings shell wires
   * this to `onForceRelock({ kind: "Exists" })` (the NTV5 vault is `Exists`, not
   * suspicious — no banner). When absent (e.g. isolation tests), the form falls
   * back to its own "done" confirmation.
   */
  onMigrated?: () => void;
}

export function MigrateVaultForm({ onMigrated }: MigrateVaultFormProps = {}): React.ReactElement {
  const { t } = useTranslation();
  const [password, setPassword] = useState("");
  const [phraseCells, setPhraseCells] = useState<string[]>(() =>
    Array.from({ length: PHRASE_CELL_COUNT }, () => ""),
  );
  const [showPassword, setShowPassword] = useState(false);
  const [state, setState] = useState<State>({ kind: "idle" });

  const inFlight = state.kind === "migrating";
  const [progress, setProgress] = useState<MigrationProgress | null>(null);
  // Polled rather than pushed: the engine writes three atomics with no host in
  // scope (its crypto core runs in a `'static` blocking closure), and an event
  // per blob would be thousands of postMessages for one line of text. 400 ms is
  // slower than a human reads a changing number and far cheaper than the work
  // being measured.
  useEffect(() => {
    if (!inFlight) {
      setProgress(null);
      return;
    }
    let live = true;
    const tick = () => {
      void migrationProgress()
        .then((p) => live && setProgress(p))
        .catch(() => {});
    };
    tick();
    const h = setInterval(tick, 400);
    return () => {
      live = false;
      clearInterval(h);
    };
  }, [inFlight]);
  // The UI-side phrase gate mirrors the backend one — Migrate stays disabled
  // until both credentials are entered. The backend re-verifies regardless.
  const canSubmit =
    password.trim().length > 0 &&
    phraseCells.every((cell) => cell.length > 0) &&
    !inFlight &&
    state.kind !== "done";

  async function onSubmit() {
    if (!canSubmit) return;
    setState({ kind: "migrating" });
    try {
      const summary = await migrateVault(password, phraseCells.join(" "));
      setState({ kind: "done", summary });
       setPassword("");
       setPhraseCells(Array.from({ length: PHRASE_CELL_COUNT }, () => ""));

      // Migration re-keyed the vault and the backend dropped the running slot;
      // route back to Unlock so the user re-derives the new keys. Without a
      // handler (isolation tests) the "done" confirmation above is the terminal.
      onMigrated?.();
    } catch (e) {
      setState({ kind: "error", messageKey: migrateErrorMessageKey(e) });
    }
  }

  if (state.kind === "done") {
    return (
      <div data-testid="migrate.done" style={{ color: "var(--fg-2)" }}>
        {t("migrate.done", { count: state.summary.notes_migrated })}
      </div>
    );
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "var(--space-3)" }}>
      <p style={{ color: "var(--fg-3)", fontSize: "var(--text-sm)", margin: 0 }}>{t("migrate.intro")}</p>

      <PasswordInput
        label={t("migrate.passwordLabel")}
        value={password}
        onChange={setPassword}
        show={showPassword}
        onToggleShow={() => setShowPassword((s) => !s)}
        disabled={inFlight}
        testId="migrate.password-input"
      />

      <PhraseEntryGrid
        baseId="migrate"
        label={t("migrate.phraseLabel")}
        hint={t("migrate.phraseHelp")}
        disabled={inFlight}
        cells={phraseCells}
        onCellChange={(index) => (event: ChangeEvent<HTMLInputElement>) => {
          setPhraseCells((cells) =>
            cells.map((cell, cellIndex) =>
              cellIndex === index ? event.target.value.replace(/\s+/g, "") : cell,
            ),
          );
        }}
        onCellPaste={(index) => (event: ClipboardEvent<HTMLInputElement>) => {
          const tokens = event.clipboardData
            .getData("text")
            .split(/\s+/)
            .filter((token) => token.length > 0);
          if (tokens.length < 2) return;
          event.preventDefault();
          setPhraseCells((cells) => {
            const next = [...cells];
            for (let i = 0; i < tokens.length && index + i < PHRASE_CELL_COUNT; i += 1) {
              next[index + i] = tokens[i];
            }
            return next;
          });
        }}
        gridTestId="migrate.phrase-grid"
        cellTestId={(index) =>
          index === 0 ? "migrate.phrase-input" : `migrate.phrase-cell-${index + 1}`
        }
      />

      {state.kind === "error" && (
        <div data-testid="migrate.error" style={{ color: "var(--danger)", fontSize: "var(--text-sm)" }}>
          {t(state.messageKey)}
        </div>
      )}

      <div style={{ display: "flex", alignItems: "center", gap: "var(--space-3)" }}>
        <Button onClick={onSubmit} disabled={!canSubmit} data-testid="migrate.submit">
          {inFlight ? t("migrate.migrating") : t("migrate.submit")}
        </Button>
        {inFlight && (
          // §10.4.1 md.2's per-blob progress (myne-md/myne#441). This testid used
          // to render a constant, so the surface existed and reported nothing on
          // an operation that runs for minutes. Counts only — see
          // `migrationProgress` for why there is no percentage or ETA.
          <span data-testid="migrate.progress" style={{ color: "var(--fg-3)", fontSize: "var(--text-sm)" }}>
            {progress && progress.total > 0
              ? t("migrate.progressCount", { done: progress.done, total: progress.total })
              : t("migrate.migrating")}
          </span>
        )}
      </div>
    </div>
  );
}
