// App-level stage union + transition function.
//
// `transition(prev, action)` is pure. Illegal pairs return `prev`
// unchanged + dev `console.warn`. The `LEGAL` table is the source of
// truth for the dev-only verification harness; keep it in sync with
// the switch arms in `transition`.
//
// `recover` carries a `subStep` discriminator (`'phrase-entry' |
// 'decrypting' | 'password-reset'`) used as the **mount-time hint**
// for which sub-step component the recover screen renders first.
// **It is not kept in sync with the recover-screen reducer's live
// sub-step** — once the recover screen mounts, its internal
// `useReducer` is the source of truth for sub-step transitions.
// Therefore Stage-level transitions out of recover (`recover.cancel`,
// `recover.complete-success`) are NOT sub-step-conditional in
// `transition()`; the recover-screen component is responsible for
// gating which sub-step dispatches each action (Cancel button is
// rendered only on phrase-entry; complete-success is dispatched only
// from PasswordResetStep on A8f success).

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
 * after create-vault, editor → unlock on user-initiated lock,
 * change-password force-relock with `suspicionReason` set), the entry
 * is `{ kind: "Exists" }` — the vault was just confirmed openable.
 * `InvalidVaultMeta` from change-password routes through
 * `{ kind: "Corrupted" }` instead, so the Unlock screen lands on the
 * existing `corrupted-vault` fail-closed UI shared with the boot probe.
 */
export type StageVaultStatus =
  | { kind: "Exists" }
  | { kind: "Corrupted" }
  | { kind: "IoError"; ioKind: IoFailureKind };

/**
 * Sub-step discriminator for the `recover` stage. Carried in the
 * Stage payload as a **mount-time hint** for which sub-step the
 * recover screen renders first; NOT kept in sync with the recover
 * screen's reducer post-mount. The recover screen's internal
 * `useReducer` is the live source of truth for sub-step transitions
 * (phrase-entry → decrypting → password-reset, plus Q4 silent-
 * recovery swaps). Stage-level transitions out of recover trust the
 * recover-screen component to gate which sub-step dispatches each
 * action (Cancel button rendered only on phrase-entry; complete-
 * success dispatched only from PasswordResetStep on A8f success).
 */
export type RecoverSubStep = "phrase-entry" | "decrypting" | "password-reset";

/**
 * Optional one-shot signal carried on the `unlock` stage when the
 * change-password modal force-relocks. Set ONLY by the change-password
 * modal's force-relock callback (via App.tsx's `setStageWithSuspicion`
 * out-of-band Stage set, sibling of `reprobe()`); the boot probe NEVER
 * emits this field. Read by `<Unlock>` to render a one-shot banner above
 * the password form (`<SuspicionBanner>`); cleared on first unlock
 * attempt or stage exit.
 *
 * Two values mirror the user-recoverable change-password backend errors:
 * - `"vault-meta-changed-externally"` — backend returned `VaultMetaChangedExternally`
 *   (CAS mismatch — another instance committed a competing rewrite).
 *   Banner copy LITERAL (`decisions.md` 2026-05-06):
 *   `"Vault was modified in another session — please unlock again."` Red severity.
 * - `"vault-locked-during-change"` — backend returned `VaultLockedDuringChange`
 *   (user fired vault_lock during the Argon2id window; informational).
 *   Banner copy LITERAL: `"Password change cancelled: vault was locked."`
 *   Informational gray severity.
 *
 * `InvalidVaultMeta` (the third change-password force-relock variant)
 * deliberately does NOT use this field — it routes through
 * `initialStatus: { kind: "Corrupted" }` to the existing
 * `<FailClosedError reason="corrupted-vault" />` shared with the
 * boot-probe corrupted-vault path; "vault file is unreadable" is a
 * different UX category from "vault was changed during change-password"
 * (fail-closed vs suspicion). See `decisions.md` 2026-05-08
 * "`Stage.unlock.suspicionReason?` field" entry §Rationale (2).
 */
export type SuspicionReason =
  | "vault-meta-changed-externally"
  | "vault-locked-during-change";

/**
 * Top-level app stage. Discriminator is `name`. `unlock` carries an
 * `initialStatus` payload + optional `suspicionReason` for change-password
 * force-relock signals; `recover` carries a `subStep` payload; the other
 * three stages are payload-free.
 */
export type Stage =
  | { name: "welcome" }
  | { name: "create-vault" }
  | { name: "unlock"; initialStatus: StageVaultStatus; suspicionReason?: SuspicionReason }
  | { name: "editor" }
  | { name: "recover"; subStep: RecoverSubStep };

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
   * the password manually. Defensive: should not trigger in normal
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
  /**
   * editor → unlock(Exists) on user clicking the Lock affordance.
   * vault.meta is known good (the user just locked from a successful
   * editor session), so initialStatus is `Exists` — the user lands
   * directly on the password form with no intermediate "vault locked"
   * screen.
   */
  | { type: "editor.lock" }
  /**
   * unlock → recover(phrase-entry). Cold-start entry: user clicked
   * the "Recovery phrase ile aç" link below the password CTA.
   */
  | { type: "unlock.start-recovery" }
  /**
   * unlock → recover(password-reset). Resume entry: user clicked the
   * "Continue" CTA on the `VaultRecoveryInProgress` banner — runtime
   * slot is `Recovering`, A8d already succeeded last (sub)session.
   */
  | { type: "unlock.resume-recovery" }
  /**
   * recover → unlock(Exists). Dispatched by the Cancel button on the
   * `phrase-entry` sub-step (the recover screen renders Cancel only
   * there per `recovery-flow.md` §3.3 + §4.1). Stage transition is
   * not sub-step-aware — the recover-screen component is the gate.
   */
  | { type: "recover.cancel" }
  /**
   * recover → editor. Dispatched by PasswordResetStep on A8f
   * success. Stage transition is not sub-step-aware — Stage's
   * `subStep` is a mount-time hint and may drift from the recover
   * screen's live reducer state across silent-recovery swaps; the
   * recover-screen component is the gate that ensures only
   * `password-reset` dispatches this action.
   */
  | { type: "recover.complete-success" };

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
        case "unlock.start-recovery":
          // Cold-start entry — user does not have a recovery in
          // flight yet (slot is Empty); recover screen mounts in
          // phrase-entry sub-step.
          return { name: "recover", subStep: "phrase-entry" };
        case "unlock.resume-recovery":
          // Resume entry — slot is `Recovering` (A8d previously
          // succeeded); skip phrase-entry and mount directly in
          // password-reset to chain A8f. If the React-side claim
          // disagrees with the actual slot at IPC time, the recover
          // screen reducer collapses the mismatch silently per Q4.
          return { name: "recover", subStep: "password-reset" };
        default:
          return rejectIllegal(prev, action);
      }
    case "editor":
      switch (action.type) {
        case "editor.lock":
          // Post-explicit-lock entry: vault.meta is known good
          // (the user just locked from a successful editor session),
          // so initialStatus is `Exists`. No intermediate "locked"
          // screen — the user lands directly on the password form.
          return { name: "unlock", initialStatus: { kind: "Exists" } };
        default:
          return rejectIllegal(prev, action);
      }
    case "recover":
      switch (action.type) {
        case "recover.cancel":
          // Stage's `subStep` payload is a mount-time hint and may
          // drift from the recover-screen reducer's live sub-step
          // (e.g., entered via `unlock.start-recovery` → Stage subStep
          // = phrase-entry, but reducer transitioned to decrypting and
          // back). The recover-screen component renders Cancel only
          // on its live phrase-entry sub-step, so dispatch-site
          // gating is sufficient; Stage transition trusts the
          // component.
          return { name: "unlock", initialStatus: { kind: "Exists" } };
        case "recover.complete-success":
          // PasswordResetStep dispatches this on A8f success. Same
          // reasoning as recover.cancel — Stage trusts the dispatch
          // site.
          return { name: "editor" };
        default:
          return rejectIllegal(prev, action);
      }
    default:
      return assertNever(prev);
  }
}

/**
 * Map paired probe results (`vault_status` on disk +
 * `vault_slot_kind` on runtime) to the initial Stage at app boot.
 *
 * **Runtime slot trumps disk for non-Empty variants.** A live
 * `Recovering` or `Unlocked` slot means the Rust process is mid-flow
 * (typically post-WebView-reload — Tauri's host outlives the JS
 * runtime across Cmd+R / HMR). At cold boot the slot is always
 * `Empty` and disk-based routing applies as before.
 *
 * Decision tree:
 * - Slot `Recovering`            → `recover` with `subStep = password-reset`
 *   (skip phrase-entry; A8d already produced the in-memory `root_key`
 *   in a prior session — `recovery-flow.md` §4.1's non-dismissible
 *   chained step continues from where the user left off).
 * - Slot `Unlocked`              → `editor` (auto-unlock parity;
 *   the Editor mount guard's `vault_is_unlocked()` probe is the
 *   reality check if Rust state somehow disagrees).
 * - Slot `Empty` + `Ok(Missing)`     → `welcome`
 * - Slot `Empty` + `Ok(Exists)`      → `unlock` with `initialStatus = Exists`
 * - Slot `Empty` + `Ok(Corrupted)`   → `unlock` with `initialStatus = Corrupted`
 * - Slot `Empty` + `Err(IoError)`    → `unlock` with `initialStatus = IoError`
 *
 * The IO-error path lands in `unlock` (not a separate `error` stage)
 * per Q10 α=3 — Unlock component renders `<FailClosedError reason="io-error">`
 * in place of the password form when `initialStatus.kind === "IoError"`.
 *
 * **Exotic disagreements** (slot says Recovering/Unlocked but disk
 * is Missing/Corrupted/IoError) are routed by slot anyway; the
 * downstream A8f / editor mount surfaces the real failure (parse
 * fail → fail-closed corrupted-vault; missing file → A8f
 * VaultNotFound). Keeping the boot decision tree slot-priority
 * preserves the silent-recovery posture (Q4) at the boundary.
 */
export function initialStageFromProbe(
  result: { ok: VaultStatus } | { err: VaultStatusError },
  slotKind: SlotKind,
): Stage {
  // Slot-priority: a non-Empty runtime slot pins the boot stage
  // regardless of disk state.
  if (slotKind === "Recovering") {
    return { name: "recover", subStep: "password-reset" };
  }
  if (slotKind === "Unlocked") {
    return { name: "editor" };
  }
  // Slot is Empty — fall through to disk-based routing.
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
import type { SlotKind } from "../types/slot-kind";

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
 * `prev` unchanged). Recover transitions are NOT sub-step-aware —
 * `recover.cancel` and `recover.complete-success` are legal from
 * any recover sub-step; the recover-screen component gates which
 * sub-step dispatches each action.
 */
const LEGAL: Record<string, Stage["name"]> = {
  "welcome|create-vault.start": "create-vault",
  "create-vault|create-vault.back": "welcome",
  "create-vault|create-vault.commit-success": "unlock",
  "create-vault|create-vault.auto-unlock-success": "editor",
  "unlock|unlock.success": "editor",
  "editor|editor.lock": "unlock",
  "unlock|unlock.start-recovery": "recover",
  "unlock|unlock.resume-recovery": "recover",
  "recover|recover.cancel": "unlock",
  "recover|recover.complete-success": "editor",
};

const ALL_STAGES_FOR_VERIFICATION: Stage[] = [
  { name: "welcome" },
  { name: "create-vault" },
  { name: "unlock", initialStatus: { kind: "Exists" } },
  // Coverage entry for the optional `suspicionReason` payload field
  // (`decisions.md` 2026-05-08). The `transition` fn ignores the field;
  // this entry exercises every (Stage × Action) pair to confirm the
  // field's presence does not change transition outcomes.
  { name: "unlock", initialStatus: { kind: "Exists" }, suspicionReason: "vault-meta-changed-externally" },
  { name: "editor" },
  { name: "recover", subStep: "phrase-entry" },
  { name: "recover", subStep: "decrypting" },
  { name: "recover", subStep: "password-reset" },
];

const ALL_ACTIONS_FOR_VERIFICATION: Action[] = [
  { type: "create-vault.start" },
  { type: "create-vault.back" },
  { type: "create-vault.commit-success" },
  { type: "create-vault.auto-unlock-success" },
  { type: "unlock.success" },
  { type: "editor.lock" },
  { type: "unlock.start-recovery" },
  { type: "unlock.resume-recovery" },
  { type: "recover.cancel" },
  { type: "recover.complete-success" },
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
  // walk so the dev console isn't flooded with the illegal-pair
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
              `[stage] regression: illegal pair (${key}) was accepted; ` +
                `transition returned ${actualNext.name}, expected ${stage.name}`,
            );
          }
        } else {
          // Legal pair → must return the expected next stage.
          if (actualNext.name !== expectedNext) {
            throw new Error(
              `[stage] regression: legal pair (${key}) returned ` +
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
 * Walk every (vault_status × slot_kind) probe outcome combination and
 * assert `initialStageFromProbe` produces the expected Stage. Catches
 * regressions where a refactor on either side (Rust enum drift, TS
 * mapping change) breaks the boot routing.
 *
 * Coverage:
 * - Slot `Empty` × four disk states (Missing / Exists / Corrupted /
 *   two IoError variants) — five disk-priority cases.
 * - Slot `Recovering` × Exists (the realistic post-reload case) —
 *   slot-priority routes to `recover(password-reset)`.
 * - Slot `Recovering` × Missing (exotic disagreement) — still routes
 *   to recover; downstream A8f surfaces VaultNotFound.
 * - Slot `Unlocked` × Exists — slot-priority routes to `editor`.
 */
function verifyInitialStageFromProbe(): void {
  type Case = {
    label: string;
    input: { ok: VaultStatus } | { err: VaultStatusError };
    slotKind: SlotKind;
    expectedName: Stage["name"];
    expectedInitialStatus?: { kind: "Exists" | "Corrupted" | "IoError"; ioKind?: IoFailureKind };
    expectedSubStep?: RecoverSubStep;
  };
  const cases: Array<Case> = [
    // ---- Slot Empty: disk-based routing (cold boot path) ----
    {
      label: "Empty + Ok(Missing)",
      input: { ok: { kind: "Missing" } },
      slotKind: "Empty",
      expectedName: "welcome",
    },
    {
      label: "Empty + Ok(Exists)",
      input: { ok: { kind: "Exists" } },
      slotKind: "Empty",
      expectedName: "unlock",
      expectedInitialStatus: { kind: "Exists" },
    },
    {
      label: "Empty + Ok(Corrupted)",
      input: { ok: { kind: "Corrupted" } },
      slotKind: "Empty",
      expectedName: "unlock",
      expectedInitialStatus: { kind: "Corrupted" },
    },
    {
      label: "Empty + Err(IoError, PermissionDenied)",
      input: { err: { kind: "IoError", detail: { io_error_kind: "PermissionDenied" } } },
      slotKind: "Empty",
      expectedName: "unlock",
      expectedInitialStatus: { kind: "IoError", ioKind: "PermissionDenied" },
    },
    {
      label: "Empty + Err(IoError, Other)",
      input: { err: { kind: "IoError", detail: { io_error_kind: "Other" } } },
      slotKind: "Empty",
      expectedName: "unlock",
      expectedInitialStatus: { kind: "IoError", ioKind: "Other" },
    },
    // ---- Slot Recovering: slot-priority (post-reload mid-recovery) ----
    {
      label: "Recovering + Ok(Exists)",
      input: { ok: { kind: "Exists" } },
      slotKind: "Recovering",
      expectedName: "recover",
      expectedSubStep: "password-reset",
    },
    {
      label: "Recovering + Ok(Missing) (exotic)",
      input: { ok: { kind: "Missing" } },
      slotKind: "Recovering",
      expectedName: "recover",
      expectedSubStep: "password-reset",
    },
    // ---- Slot Unlocked: slot-priority (post-reload mid-edit) ----
    {
      label: "Unlocked + Ok(Exists)",
      input: { ok: { kind: "Exists" } },
      slotKind: "Unlocked",
      expectedName: "editor",
    },
  ];

  for (const c of cases) {
    const actual = initialStageFromProbe(c.input, c.slotKind);
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
    if (c.expectedSubStep !== undefined && actual.name === "recover") {
      if (actual.subStep !== c.expectedSubStep) {
        throw new Error(
          `[stage] regression: initialStageFromProbe(${c.label}) subStep=${actual.subStep}; expected ${c.expectedSubStep}`,
        );
      }
    }
  }
}

if (import.meta.env.DEV) {
  verifyTransitionTable();
  verifyInitialStageFromProbe();
}
