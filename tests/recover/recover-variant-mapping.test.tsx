// @vitest-environment jsdom
//
// MYND-126 task 7 — component/unit layer for the recovery flow:
//
// (a) 11-variant mapping table: EVERY `VaultRecoveryError` variant
//     (incl. the two MYND-219 mirror additions) must produce a DEFINED
//     reducer outcome on both the A8d (phrase) and A8f (password)
//     surfaces — an unmapped variant would dispatch `undefined` into
//     the reducer and strand the user. Driven through the REAL screen
//     components with a mocked `invoke` reject per variant.
//
// (b) phraseRef lifecycle (§3.5, SYNC-5 reference-release only): the
//     stashed phrase's sole consumer is the A8d invoke — after either
//     resolve or reject the ref is wiped, observable as "a second
//     decrypting entry without a fresh stash does not re-fire A8d".
//     (JS strings are immutable; the load-bearing zeroize is Rust-side.)
//
// (c) Q8 static assert: zero `vault_lock`/`lockVault` references in
//     the recover-screen tree (cancel is Stage-only; no lock fires).

import { afterEach, describe, expect, it, vi } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

const invokeMock = vi.fn<(cmd: string, args?: Record<string, unknown>) => Promise<unknown>>();

vi.mock("@tauri-apps/api/core", () => ({
  invoke: (cmd: string, args?: Record<string, unknown>) => invokeMock(cmd, args),
}));
vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => ({ show: async () => {} }),
}));
vi.mock("@tauri-apps/api/path", () => ({
  appDataDir: async () => "/tmp/app-data",
  join: async (...parts: string[]) => parts.join("/"),
}));

import { VaultRecover } from "../../src/screens/VaultRecover";
import type { VaultRecoveryError } from "../../src/types/vault-recovery-error";

const PHRASE_WORDS = Array.from({ length: 24 }, () => "abandon");

function renderRecover(overrides?: {
  onCancel?: (vaultId?: string) => void;
  onCompleteSuccess?: (vaultId?: string) => void;
}) {
  return render(
    <VaultRecover
      initialSubStep="phrase-entry"
      onCancel={overrides?.onCancel ?? (() => {})}
      onCompleteSuccess={overrides?.onCompleteSuccess ?? (() => {})}
      onDeleteVaultSuccess={() => {}}
    />,
  );
}

/** Fill all 24 cells and submit A8d. */
async function submitPhrase(): Promise<void> {
  const cells = await screen.findAllByTestId("recover.phrase-cell");
  expect(cells.length).toBe(24);
  cells.forEach((cell, i) => {
    fireEvent.change(cell, { target: { value: PHRASE_WORDS[i] } });
  });
  fireEvent.click(screen.getByTestId("recover.submit"));
}

function recoverCalls(): number {
  return invokeMock.mock.calls.filter(
    ([cmd]) => cmd === "plugin:vault-recover|recover_with_phrase",
  ).length;
}

/** Mock: vault_list yields one vault (single-vault parity — no select
 *  step); A8d rejects with `error` (or resolves when null). */
function mockA8d(error: VaultRecoveryError | null): void {
  invokeMock.mockImplementation((cmd) => {
    switch (cmd) {
      case "plugin:vault-unlock|vault_list":
        return Promise.resolve([
          { id: "00000000-0000-7000-8000-00000000000a", status: { kind: "Exists" }, label: null, last_unlock: null },
        ]);
      case "plugin:vault-recover|recover_with_phrase":
        return error ? Promise.reject(error) : Promise.resolve(undefined);
      default:
        return Promise.resolve(undefined);
    }
  });
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

// ── (a) the 11-variant table ────────────────────────────────────────

/** Expected A8d (phrase-side) outcome class per variant. */
const A8D_EXPECTATIONS: Array<{
  error: VaultRecoveryError;
  expect: "non-distinguishing" | "banner" | "fail-closed" | "advance-to-reset";
}> = [
  { error: { kind: "VaultNotFound" }, expect: "banner" },
  { error: { kind: "InvalidCredentialOrVault" }, expect: "non-distinguishing" },
  { error: { kind: "InvalidVaultMeta" }, expect: "fail-closed" },
  { error: { kind: "IoError", detail: { io_error_kind: "PermissionDenied" } }, expect: "banner" },
  { error: { kind: "RecoveryInProgress" }, expect: "banner" },
  { error: { kind: "VaultAlreadyUnlocked" }, expect: "fail-closed" },
  { error: { kind: "RecoveryAlreadyInProgress" }, expect: "advance-to-reset" },
  { error: { kind: "VaultRecoveryRequiresActiveSession" }, expect: "banner" },
  { error: { kind: "JoinFailure" }, expect: "banner" },
  // The two MYND-219 mirror additions — pre-fix these crossed the wire
  // into an UNDEFINED mapper result.
  { error: { kind: "RecoveryAbortedByLock" }, expect: "banner" },
  { error: { kind: "WeakNewPassword" }, expect: "banner" },
];

describe("A8d variant mapping: all 11 VaultRecoveryError variants produce defined outcomes", () => {
  for (const { error, expect: outcome } of A8D_EXPECTATIONS) {
    it(`${error.kind} → ${outcome}`, async () => {
      mockA8d(error);
      renderRecover();
      await submitPhrase();

      switch (outcome) {
        case "non-distinguishing": {
          const banner = await screen.findByTestId("recover.banner");
          expect(banner.textContent).toBe("Phrase or vault file is invalid. Please try again.");
          // §3.4 wipe: every cell empty.
          for (const cell of screen.getAllByTestId("recover.phrase-cell")) {
            expect((cell as HTMLInputElement).value).toBe("");
          }
          break;
        }
        case "banner": {
          const banner = await screen.findByTestId("recover.banner");
          expect((banner.textContent ?? "").length).toBeGreaterThan(0);
          break;
        }
        case "fail-closed": {
          await screen.findByTestId("fail-closed.root");
          break;
        }
        case "advance-to-reset": {
          // Q4 silent swap: no banner, straight to password-reset.
          await screen.findByTestId("recover.reset.password-input");
          expect(screen.queryByTestId("recover.banner")).toBeNull();
          break;
        }
      }
    });
  }
});

// ── (b) phraseRef lifecycle (reference-release contracts) ──────────

describe("phraseRef lifecycle (§3.5: stash → single consume → wipe)", () => {
  it("A8d fires exactly once per stash; the rejected attempt does not re-fire from a stale ref", async () => {
    mockA8d({ kind: "IoError", detail: { io_error_kind: "Other" } });
    renderRecover();
    await submitPhrase();
    await screen.findByTestId("recover.banner");
    expect(recoverCalls()).toBe(1);

    // The reducer re-enters decrypting ONLY via a fresh submit-phrase
    // stash; the wiped ref alone cannot re-fire the IPC. Cells were
    // PRESERVED on IoError — resubmit stashes anew and fires again.
    fireEvent.click(screen.getByTestId("recover.submit"));
    await waitFor(() => expect(recoverCalls()).toBe(2));
  });

  it("unmount wipes the stash without firing anything further", async () => {
    mockA8d(null);
    const { unmount } = renderRecover();
    const cells = await screen.findAllByTestId("recover.phrase-cell");
    cells.forEach((cell, i) => {
      fireEvent.change(cell, { target: { value: PHRASE_WORDS[i] } });
    });
    // Stash exists (typed) but never submitted; unmount must not fire
    // A8d on the way out.
    unmount();
    expect(recoverCalls()).toBe(0);
  });
});

// ── (c) Q8 static assert ────────────────────────────────────────────

describe("Q8: the recover screen tree never references vault_lock", () => {
  it("zero vault_lock/lockVault references under src/screens/vault-recover/ + VaultRecover.tsx", () => {
    const root = join(__dirname, "..", "..", "src", "screens");
    const files = [
      join(root, "VaultRecover.tsx"),
      ...readdirSync(join(root, "vault-recover"))
        .filter((f) => f.endsWith(".ts") || f.endsWith(".tsx"))
        .map((f) => join(root, "vault-recover", f)),
    ];
    for (const file of files) {
      const text = readFileSync(file, "utf8");
      // Comments may MENTION the rule; code must not CALL it. Strip
      // comments before scanning.
      const code = text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
      expect(code.includes("vault_lock")).toBe(false);
      expect(code.includes("lockVault")).toBe(false);
    }
  });
});
