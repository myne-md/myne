// App-level stage union + transition function.
//
// Recover stage is intentionally absent — added back-compat in a
// separate recovery PR.
//
// `transition(prev, action)` is pure. Illegal pairs return `prev`
// unchanged + dev `console.warn`. The `LEGAL` table is the source of
// truth for the dev-only verification harness; keep it in sync with
// the switch arms in `transition`.

/**
 * Mirrors the Rust-side `IoFailureKind` enum
 * (`src-tauri/src/io_failure_kind.rs`) — bounded categorization of IO
 * failures surfaced by `vault_status`. No `String` payload (path
 * leakage prevention).
 */
export type IoFailureKind = "PermissionDenied" | "NoSpace" | "NotFound" | "Other";

/**
 * Initial `vault.meta` status carried by the `unlock` stage. Drives
 * whether the Unlock component renders the password form (`Exists`)
 * or `<FailClosedError reason="corrupted-vault" />` (`Corrupted` /
 * `IoError`). For transitions other than the boot probe (auto-unlock
 * after create-vault, locked → unlock), the entry is always
 * `{ kind: "Exists" }` — the vault was just confirmed openable.
 */
export type StageVaultStatus =
  | { kind: "Exists" }
  | { kind: "Corrupted" }
  | { kind: "IoError"; ioKind: IoFailureKind };

/**
 * Top-level app stage. Discriminator is `name`. `unlock` carries an
 * `initialStatus` payload; the other four stages are payload-free.
 *
 * `recover` stage is intentionally absent — the recovery flow lands
 * in a separate PR and will extend this union backwards-compatibly.
 */
export type Stage =
  | { name: "welcome" }
  | { name: "create-vault" }
  | { name: "unlock"; initialStatus: StageVaultStatus }
  | { name: "locked" }
  | { name: "editor" };

/**
 * Action type sent to `transition`. Each action corresponds to a
 * single legal trigger from the PRD's transition table.
 *
 * Boot-probe-driven initial state (`vault_status` Ok/Err → initial
 * Stage selection) is handled separately in App.tsx's mount effect,
 * not via `transition` — there is no prior Stage at boot.
 */
export type Action =
  /** Welcome → create-vault. */
  | { type: "create-vault.start" }
  /** create-vault → welcome (Back from any step). */
  | { type: "create-vault.back" }
  /**
   * create-vault → unlock(Exists). **Auto-unlock failure path.** The
   * vault was created (commit ok) but the chained `vault_unlock`
   * call rejected — the user lands on the unlock screen and retypes
   * the password manually. Defansif: should not trigger in normal
   * flow because the same password just succeeded inside `commit`.
   */
  | { type: "create-vault.commit-success" }
  /**
   * create-vault → editor. **Auto-unlock success path.** PRD Q4(a):
   * after `commit` resolves, CreateVault re-uses the just-typed
   * password to invoke `vault_unlock`. On resolve, slot is populated
   * and the user lands directly in editor without retyping. The
   * password itself does NOT travel via Stage payload — it's held
   * by the CreateVault reducer and passed directly to vault_unlock,
   * then wiped on resolve.
   */
  | { type: "create-vault.auto-unlock-success" }
  /** unlock(decrypting) → editor on `vault_unlock` IPC resolve. */
  | { type: "unlock.success" }
  /** editor → locked on user clicking the Lock affordance. */
  | { type: "editor.lock" }
  /** locked → unlock(Exists) on user clicking Unlock from the locked screen. */
  | { type: "locked.unlock" };

/**
 * Pure transition function. Returns the next Stage given the previous
 * Stage and an Action. Illegal (prev, action) pairs return `prev`
 * unchanged after emitting a dev `console.warn` — the React state is
 * preserved (no broken UI) and the regression is surfaced in dev.
 *
 * Adding a Stage variant or Action type without updating both the
 * switch arms below AND the `LEGAL` table is a compile-time error
 * (via `assertNever`) for Stage and a runtime regression caught by
 * the dev-only `verifyTransitionTable` harness for Action.
 */
export function transition(prev: Stage, action: Action): Stage {
  switch (prev.name) {
    case "welcome":
      switch (action.type) {
        case "create-vault.start":
          return { name: "create-vault" };
        default:
          return rejectIllegal(prev, action);
      }
    case "create-vault":
      switch (action.type) {
        case "create-vault.back":
          return { name: "welcome" };
        case "create-vault.commit-success":
          // Auto-unlock failure fallback (PRD Q4(a)): vault is
          // created but the chained vault_unlock IPC rejected; user
          // retypes manually on the unlock screen.
          return { name: "unlock", initialStatus: { kind: "Exists" } };
        case "create-vault.auto-unlock-success":
          // Auto-unlock success path: vault_unlock resolved, slot is
          // populated, user lands in editor without retyping.
          return { name: "editor" };
        default:
          return rejectIllegal(prev, action);
      }
    case "unlock":
      switch (action.type) {
        case "unlock.success":
          return { name: "editor" };
        default:
          return rejectIllegal(prev, action);
      }
    case "editor":
      switch (action.type) {
        case "editor.lock":
          return { name: "locked" };
        default:
          return rejectIllegal(prev, action);
      }
    case "locked":
      switch (action.type) {
        case "locked.unlock":
          // Post-explicit-lock entry: vault.meta is known good
          // (the user just locked from a successful editor session),
          // so initialStatus is `Exists`.
          return { name: "unlock", initialStatus: { kind: "Exists" } };
        default:
          return rejectIllegal(prev, action);
      }
    default:
      return assertNever(prev);
  }
}

/**
 * Map a `vault_status` probe result to the initial Stage at app boot.
 *
 * Boot-probe transition table (from PRD Implementation Decisions):
 * - `Ok(Missing)`              → `welcome`
 * - `Ok(Exists)`               → `unlock` with `initialStatus = Exists`
 * - `Ok(Corrupted)`            → `unlock` with `initialStatus = Corrupted`
 * - `Err(IoError)`             → `unlock` with `initialStatus = IoError`
 *
 * The IO-error path lands in `unlock` (not a separate `error` stage)
 * per Q10 α=3 — Unlock component renders `<FailClosedError reason="io-error">`
 * in place of the password form when `initialStatus.kind === "IoError"`.
 */
export function initialStageFromProbe(
  result: { ok: VaultStatus } | { err: VaultStatusError },
): Stage {
  if ("ok" in result) {
    switch (result.ok.kind) {
      case "Missing":
        return { name: "welcome" };
      case "Exists":
        return { name: "unlock", initialStatus: { kind: "Exists" } };
      case "Corrupted":
        return { name: "unlock", initialStatus: { kind: "Corrupted" } };
      default:
        return assertNever(result.ok);
    }
  }
  // Err arm: IoError. Unlock component renders fail-closed UI.
  return {
    name: "unlock",
    initialStatus: { kind: "IoError", ioKind: result.err.detail.io_error_kind },
  };
}

function rejectIllegal(prev: Stage, action: Action): Stage {
  if (import.meta.env.DEV) {
    // eslint-disable-next-line no-console
    console.warn(
      `[stage] Illegal transition: ${prev.name} → ${action.type}; retaining ${prev.name}`,
    );
  }
  return prev;
}

function assertNever(x: never): never {
  throw new Error(`[stage] Unhandled stage variant: ${JSON.stringify(x)}`);
}

import type { VaultStatus, VaultStatusError } from "../types/vault-status";

// ---- Dev-only runtime verification harness ----
//
// Walks every (Stage variant × Action variant) pair and asserts the
// `transition` fn matches the legal table below. Tree-shaken from prod
// via `import.meta.env.DEV`. Runs once per module load in dev — module
// is imported by App.tsx so a regression breaks `pnpm dev` boot
// immediately.

/**
 * Source-of-truth legal-transition table. Keys are
 * `<stage.name>|<action.type>`; values are the expected resulting
 * `stage.name`. Pairs not present here are illegal (must return
 * `prev` unchanged).
 */
const LEGAL: Record<string, Stage["name"]> = {
  "welcome|create-vault.start": "create-vault",
  "create-vault|create-vault.back": "welcome",
  "create-vault|create-vault.commit-success": "unlock",
  "create-vault|create-vault.auto-unlock-success": "editor",
  "unlock|unlock.success": "editor",
  "editor|editor.lock": "locked",
  "locked|locked.unlock": "unlock",
};

const ALL_STAGES_FOR_VERIFICATION: Stage[] = [
  { name: "welcome" },
  { name: "create-vault" },
  { name: "unlock", initialStatus: { kind: "Exists" } },
  { name: "locked" },
  { name: "editor" },
];

const ALL_ACTIONS_FOR_VERIFICATION: Action[] = [
  { type: "create-vault.start" },
  { type: "create-vault.back" },
  { type: "create-vault.commit-success" },
  { type: "create-vault.auto-unlock-success" },
  { type: "unlock.success" },
  { type: "editor.lock" },
  { type: "locked.unlock" },
];

/**
 * Walk every (Stage, Action) pair. Legal pairs must produce the
 * expected next stage; illegal pairs must return `prev` unchanged.
 *
 * Throws on any mismatch — in dev this surfaces as a hard failure on
 * App.tsx mount, blocking the broken state from reaching the user.
 */
function verifyTransitionTable(): void {
  // Suppress the rejectIllegal `console.warn` during the verification
  // walk so the dev console isn't flooded with the 24 illegal-pair
  // warnings the harness deliberately exercises. The harness's job is
  // to verify the table itself, not to test the warn-emit path (that
  // path is observable in real app usage).
  const originalWarn = console.warn;
  // eslint-disable-next-line no-console
  console.warn = () => {};
  try {
    for (const stage of ALL_STAGES_FOR_VERIFICATION) {
      for (const action of ALL_ACTIONS_FOR_VERIFICATION) {
        const key = `${stage.name}|${action.type}`;
        const expectedNext: Stage["name"] | undefined = LEGAL[key];
        const actualNext = transition(stage, action);
        if (expectedNext === undefined) {
          // Illegal pair → must return prev unchanged.
          if (actualNext.name !== stage.name) {
            throw new Error(
              `[stage] regression: illegal pair (${stage.name}, ${action.type}) was accepted; ` +
                `transition returned ${actualNext.name}, expected ${stage.name}`,
            );
          }
        } else {
          // Legal pair → must return the expected next stage.
          if (actualNext.name !== expectedNext) {
            throw new Error(
              `[stage] regression: legal pair (${stage.name}, ${action.type}) returned ` +
                `${actualNext.name}; expected ${expectedNext}`,
            );
          }
        }
      }
    }
  } finally {
    // eslint-disable-next-line no-console
    console.warn = originalWarn;
  }
}

/**
 * Walk every `vault_status` probe outcome and assert
 * `initialStageFromProbe` produces the expected Stage. Catches
 * regressions where a refactor on either side (Rust enum drift, TS
 * mapping change) breaks the boot routing.
 */
function verifyInitialStageFromProbe(): void {
  const cases: Array<{
    label: string;
    input: { ok: VaultStatus } | { err: VaultStatusError };
    expectedName: Stage["name"];
    expectedInitialStatus?: { kind: "Exists" | "Corrupted" | "IoError"; ioKind?: IoFailureKind };
  }> = [
    { label: "Ok(Missing)", input: { ok: { kind: "Missing" } }, expectedName: "welcome" },
    {
      label: "Ok(Exists)",
      input: { ok: { kind: "Exists" } },
      expectedName: "unlock",
      expectedInitialStatus: { kind: "Exists" },
    },
    {
      label: "Ok(Corrupted)",
      input: { ok: { kind: "Corrupted" } },
      expectedName: "unlock",
      expectedInitialStatus: { kind: "Corrupted" },
    },
    {
      label: "Err(IoError, PermissionDenied)",
      input: { err: { kind: "IoError", detail: { io_error_kind: "PermissionDenied" } } },
      expectedName: "unlock",
      expectedInitialStatus: { kind: "IoError", ioKind: "PermissionDenied" },
    },
    {
      label: "Err(IoError, Other)",
      input: { err: { kind: "IoError", detail: { io_error_kind: "Other" } } },
      expectedName: "unlock",
      expectedInitialStatus: { kind: "IoError", ioKind: "Other" },
    },
  ];

  for (const c of cases) {
    const actual = initialStageFromProbe(c.input);
    if (actual.name !== c.expectedName) {
      throw new Error(
        `[stage] regression: initialStageFromProbe(${c.label}) returned name=${actual.name}; expected ${c.expectedName}`,
      );
    }
    if (c.expectedInitialStatus && actual.name === "unlock") {
      const got = actual.initialStatus;
      if (got.kind !== c.expectedInitialStatus.kind) {
        throw new Error(
          `[stage] regression: initialStageFromProbe(${c.label}) initialStatus.kind=${got.kind}; expected ${c.expectedInitialStatus.kind}`,
        );
      }
      if (got.kind === "IoError" && c.expectedInitialStatus.ioKind !== undefined) {
        if (got.ioKind !== c.expectedInitialStatus.ioKind) {
          throw new Error(
            `[stage] regression: initialStageFromProbe(${c.label}) ioKind=${got.ioKind}; expected ${c.expectedInitialStatus.ioKind}`,
          );
        }
      }
    }
  }
}

if (import.meta.env.DEV) {
  verifyTransitionTable();
  verifyInitialStageFromProbe();
}
