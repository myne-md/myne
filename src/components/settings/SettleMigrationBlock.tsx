// The post-migration settle surface (`protocol.md` §10.4.1 point 5,
// myne-md/myne#430).
//
// A migration is NOT finished when it succeeds. It leaves the whole
// pre-migration vault staged under `legacy/`, and until the user settles it one
// way or the other:
//
//   - the old `root_key` is still on disk, wrapped under the OLD password and
//     the OLD recovery phrase, so rotating the master password does not revoke
//     access to those notes (`vault_change_password` rewrites `<vault>/vault.meta`
//     only) and the phrase cannot be rotated at all; and
//   - the vault occupies roughly twice the disk it needs to.
//
// So this block is not a nicety. It renders only while something is staged, and
// it is the only place either action can be taken.
//
// Tone (PRODUCT.md): honest, not alarming. Nothing has gone wrong — the
// migration worked, and this is the user confirming they have looked.

import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "../primitives/Button";
import {
  abortMigration,
  confirmMigration,
  migrationSettleStatus,
  type MigrationSettleStatus,
} from "../../lib/vault-migrate";

type Busy = "none" | "aborting" | "confirming";

/** Which of the two settle actions landed. */
export type SettleOutcome = "aborted" | "confirmed";

export interface SettleMigrationBlockProps {
  /**
   * Called after a settle lands, told WHICH one.
   *
   * The argument is the whole of myne-md/myne#461. Both actions used to report
   * through one bare callback, and the panel treated the pair as
   * interchangeable, so confirming routed the user to the Unlock screen. Only
   * ABORT is a re-key: it restores the pre-migration root and the backend locks
   * the slot (`vault_migrate_abort` calls `lock_from_host`). CONFIRM only
   * crypto-erases the staged `legacy/` snapshot and leaves the running slot
   * exactly as it was, so a force-relock on top of it puts React on a lock
   * screen while the Rust slot is still `Slot::Unlocked`, and every unlock
   * attempt then returns `VaultAlreadyUnlocked` with no way forward short of
   * restarting the app.
   */
  onSettled?: (which: SettleOutcome) => void;
}

export function SettleMigrationBlock({
  onSettled,
}: SettleMigrationBlockProps = {}): React.ReactElement | null {
  const { t } = useTranslation();
  const [status, setStatus] = useState<MigrationSettleStatus | null>(null);
  const [busy, setBusy] = useState<Busy>("none");
  const [errorKey, setErrorKey] = useState<string | null>(null);

  const probe = useCallback(() => {
    void migrationSettleStatus()
      .then(setStatus)
      // A probe failure is not a thing to shout about: the block simply does not
      // render, exactly as it does not on a vault that was never migrated.
      .catch(() => setStatus(null));
  }, []);

  useEffect(probe, [probe]);

  if (!status?.pending) return null;

  const run = async (which: Exclude<Busy, "none">) => {
    setBusy(which);
    setErrorKey(null);
    try {
      await (which === "aborting" ? abortMigration() : confirmMigration());
      setStatus(null);
      onSettled?.(which === "aborting" ? "aborted" : "confirmed");
    } catch (e) {
      const kind = (e as { kind?: string } | null)?.kind;
      setErrorKey(
        kind === "AlreadySynced"
          ? "migrate.settle.errorAlreadySynced"
          : kind === "AuthOperationInProgress"
            ? "migrate.settle.errorBusy"
            : "migrate.settle.errorIo",
      );
      // An `AlreadySynced` refusal changes what is on offer, so re-probe rather
      // than leaving a button that cannot work.
      probe();
      setBusy("none");
    }
  };

  return (
    <div
      data-testid="migrate.settle"
      style={{ display: "flex", flexDirection: "column", gap: "var(--space-3)" }}
    >
      <p style={{ color: "var(--fg-3)", fontSize: "var(--text-sm)", margin: 0 }}>
        {t("migrate.settle.intro")}
      </p>
      {errorKey && (
        <div
          data-testid="migrate.settle-error"
          style={{ color: "var(--danger)", fontSize: "var(--text-sm)" }}
        >
          {t(errorKey)}
        </div>
      )}
      <div style={{ display: "flex", gap: "var(--space-2)" }}>
        <Button
          onClick={() => void run("confirming")}
          disabled={busy !== "none"}
          data-testid="migrate.settle-confirm"
        >
          {t("migrate.settle.confirm")}
        </Button>
        {/* Offered only while the roll-back is still safe. Past the first sync
            the peers hold the v0.2 generation, so restoring here would fork this
            device away from them — the backend refuses, and an offer the backend
            refuses is worse than no offer. */}
        {status.can_abort && (
          <Button
            onClick={() => void run("aborting")}
            disabled={busy !== "none"}
            data-testid="migrate.settle-abort"
          >
            {t("migrate.settle.abort")}
          </Button>
        )}
      </div>
    </div>
  );
}
