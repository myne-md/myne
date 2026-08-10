// @vitest-environment jsdom
//
// #420 task 3: the migration form's phrase gate + flow. The load-bearing UI
// property is that "Migrate" stays disabled until BOTH the password and the
// recovery phrase are entered (the UI half of the phrase-required rule; the
// backend re-verifies), and that a `RecoveryPhraseRequired` refusal maps to
// phrase-specific copy rather than a generic error.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";

/** Click and flush the async handler's microtasks inside act, so a rejection is
 *  caught by the component (not surfaced as an "unhandled" rejection by the env). */
async function clickAndFlush(el: HTMLElement) {
  await act(async () => {
    fireEvent.click(el);
    // Macrotask flush: lets the awaited call + the catch's setState settle so a
    // rejection is handled by the component, not flagged as "unhandled".
    await new Promise((r) => setTimeout(r, 0));
  });
}

const migrateVault = vi.fn();
vi.mock("../../src/lib/vault-migrate", () => ({
  migrateVault: (...a: unknown[]) => migrateVault(...a),
  isRecoveryPhraseRequired: (e: unknown) =>
    (e as { kind?: string } | null)?.kind === "RecoveryPhraseRequired",
  isAlreadyMigrated: (e: unknown) => (e as { kind?: string } | null)?.kind === "AlreadyMigrated",
}));
vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (k: string, opts?: { count?: number }) => (opts?.count != null ? `${k}:${opts.count}` : k),
  }),
}));

import { MigrateVaultForm, migrateErrorMessageKey } from "../../src/components/settings/MigrateVaultForm";

function typePassword(v: string) {
  fireEvent.change(screen.getByTestId("migrate.password-input"), { target: { value: v } });
}
function typePhrase(v: string) {
  fireEvent.change(screen.getByTestId("migrate.phrase-input"), { target: { value: v } });
}

beforeEach(() => migrateVault.mockReset());
afterEach(() => cleanup());

describe("MigrateVaultForm (#420)", () => {
  it("keeps Migrate disabled until BOTH password and phrase are entered", () => {
    render(<MigrateVaultForm />);
    const submit = screen.getByTestId("migrate.submit") as HTMLButtonElement;
    expect(submit.disabled).toBe(true);
    typePassword("pw");
    expect(submit.disabled).toBe(true); // phrase still empty
    typePhrase("word ".repeat(12));
    expect(submit.disabled).toBe(false); // both present → enabled
  });

  it("migrates and shows the done summary", async () => {
    migrateVault.mockResolvedValue({ notes_migrated: 3, singletons_migrated: 1 });
    render(<MigrateVaultForm />);
    typePassword("correct");
    typePhrase("abandon abandon about");
    await clickAndFlush(screen.getByTestId("migrate.submit"));
    const done = screen.getByTestId("migrate.done");
    expect(migrateVault).toHaveBeenCalledWith("correct", "abandon abandon about");
    expect(done.textContent).toBe("migrate.done:3");
  });

  // The error→copy mapping is a pure function, tested directly (avoids the
  // async-event-handler rejection quirk of the jsdom/React test env; the
  // component's catch just calls this).
  it("maps each rejection to its own calm copy", () => {
    expect(migrateErrorMessageKey({ kind: "RecoveryPhraseRequired" })).toBe(
      "migrate.error.recoveryPhraseRequired",
    );
    expect(migrateErrorMessageKey({ kind: "InvalidCredentialOrVault" })).toBe(
      "migrate.error.wrongPassword",
    );
    expect(migrateErrorMessageKey({ kind: "AlreadyMigrated" })).toBe(
      "migrate.error.alreadyMigrated",
    );
    expect(migrateErrorMessageKey({ kind: "Io" })).toBe("migrate.error.generic");
    expect(migrateErrorMessageKey(undefined)).toBe("migrate.error.generic");
  });
});
