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
export type RecoverSubStep =
  /**
   * Multi-vault recovery selection stage (MYND-206), entered BEFORE
   * phrase-entry when ≥2 vaults exist on disk. The recover screen renders a
   * vault picker (reusing sub-feature 3's row view-model — last-unlock /
   * "Vault N") plus an OPTIONAL account-number affordance (Task 1's
   * `resolve_vault_by_account_number` selector). Picking a row OR a successful
   * account-number match resolves a `VaultId` and advances to `phrase-entry`
   * against that vault. With exactly 1 vault the recover screen SKIPS this
   * sub-step entirely (single-vault parity, story 7) and mounts directly in
   * `phrase-entry`; the account-number is NEVER required (story 6). Reducer-
   * only — `initialStageFromProbe` never produces it (boot routes ≥2 vaults to
   * the unlock `picker`, not into recovery); it is reached only when the
   * recover screen mounts and discovers ≥2 vaults.
   */
  | "select"
  | "phrase-entry"
  | "decrypting"
  | "password-reset"
  /**
   * MYND-108-bis lost-credentials cul-de-sac escape. Reducer-only
   * sub-step entered from `phrase-entry` when the user clicks the
   * footer "Delete vault and start over" link. Renders
   * `<DeleteVaultConfirmForm>`; on Submit calls the `vault_delete`
   * IPC which accepts via `Slot::Empty + vault.meta-exists`. Boot
   * probe never lands here (no on-disk persistence of this sub-
   * step's state); only `unlock.start-recovery` reaches phrase-entry
   * which then transitions to delete-confirm via the reducer's
   * `request-delete` action.
   */
  | "delete-confirm";

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
 * Canonical vault identifier on the TS side — the `VaultId` rendered as
 * its 36-char lowercase-hyphenated UUIDv7 string (SYNC-2). Mirrors the
 * `id` field of `VaultSummary` (`src/types/vault-summary.ts`) and the
 * optional `vaultId` targeting argument on `probeSlotKind` /
 * vault-addressed IPC wrappers (SYNC-6). A plain `string` alias (not a
 * branded type) — the Rust side owns minting + validation; the TS side
 * only routes opaque ids through `transition` / `initialStageFromProbe`.
 */
export type VaultId = string;

/**
 * Top-level app stage. Discriminator is `name`. `unlock` carries an
 * `initialStatus` payload + optional `suspicionReason` for change-password
 * force-relock signals; `recover` carries a `subStep` payload; `picker`
 * and the other three stages are payload-free.
 *
 * `picker` (MYND-204, multi-vault sub-feature 3) is the ≥2-vault startup
 * surface. It is payload-free: the vault list is fetched from `vault_list()`
 * by the picker screen, not carried on the Stage. It is produced ONLY by
 * `initialStageFromProbe` (boot routing) — there is no `transition` arm that
 * *enters* `picker` (mirroring how the other initial stages are selected:
 * boot has no prior Stage). It is *left* via `picker.select-vault` →
 * `unlock` and `picker.create-vault` → `create-vault`.
 */
export type Stage =
  | { name: "welcome" }
  | {
      /**
       * Vault-creation flow. `briefing` (MYND-114) is a mount-time hint:
       * when set, the flow opens on the first-run safety-briefing step
       * (`<BriefingStep>`) before password setup. Set ONLY on the
       * `welcome → create-vault.start` transition (the first-run entry);
       * the picker / switcher "create another" entries leave it unset
       * (falsy), since a user creating an additional vault has already
       * acknowledged the recovery model once. Like `unlock`'s
       * `suspicionReason` / `vaultId`, it is payload — not part of the
       * `name` discriminator — so the `LEGAL` transition table is
       * unaffected.
       */
      name: "create-vault";
      briefing?: boolean;
    }
  | {
      name: "unlock";
      initialStatus: StageVaultStatus;
      suspicionReason?: SuspicionReason;
      /**
       * Optional vault-targeting id (MYND-204, multi-vault sub-feature 3,
       * task 8). Set ONLY when the unlock was reached by an explicit vault
       * choice: the `picker.select-vault` transition copies the chosen
       * `vaultId` here, and `initialStageFromProbe`'s single-vault arm sets
       * it to that lone vault's id. `<Unlock>` reads it and threads it into
       * the vault-addressed `unlock` IPC (SYNC-6 targeting). EVERY other
       * path to `unlock` (editor lock, recovery cancel, create-vault commit
       * fallback, change-password force-relock) leaves this `undefined` →
       * `<Unlock>` calls the param-less / `None` sole-vault unlock, which is
       * the unchanged single-vault behavior. Like `suspicionReason`, this is
       * payload (not part of the `name` discriminator), so the `LEGAL`
       * transition table is unaffected.
       */
      vaultId?: VaultId;
      /**
       * Set ONLY by the `picker.select-vault` transition — marks an unlock
       * screen the user reached by picking a row on the ≥2-vault picker. When
       * true, `<Unlock>` renders a "Choose a different vault" back affordance
       * (dispatching `unlock.back-to-picker` → `picker`) so a mis-selected
       * vault is recoverable without quitting the app. EVERY other path to
       * `unlock` (single-vault boot, editor lock, vault switch, recovery
       * cancel, create-vault fallback, change-password force-relock) leaves it
       * falsy — those entries have no picker to return to (a single-vault user
       * never saw one; the switch / lock / relock paths already tore down or
       * own the active vault). Like `suspicionReason` / `vaultId`, it is
       * payload (not part of the `name` discriminator), so the `LEGAL`
       * transition table is unaffected.
       */
      fromPicker?: boolean;
    }
  | {
      name: "editor";
      /**
       * The ACTIVE (sole-Unlocked) vault's id, threaded onto the editor
       * stage by every entry path that knows it (MYND-219 / SYNC-17):
       * `unlock.success` copies the unlock stage's targeting id,
       * `create-vault.auto-unlock-success` and `recover.complete-success`
       * carry the just-created / just-recovered vault's id on the action.
       * Read by the exits that re-enter `unlock` (`editor.lock`, the
       * change-password force-relock via `setStageWithSuspicion`) so the
       * resulting unlock stays vault-addressed at ≥2 vaults instead of
       * falling to the sole-vault `None` path. `undefined` only on the
       * boot-probe slot-priority entry (post-reload editor) — the runtime
       * owns active-vault identity there and no WebView-side id exists
       * without an extra IPC.
       */
      vaultId?: VaultId;
    }
  | { name: "recover"; subStep: RecoverSubStep }
  | { name: "picker" }
  /**
   * The web client's first-run identity step (phase3-web-client tasks 30 + 85).
   *
   * Desktop never reaches it: the vault is on disk, so unlock is password-only
   * and `initialStageFromProbe` keeps routing an empty disk to `welcome`. A
   * browser starting from an empty origin knows nothing — and `decisions.md`
   * 2026-07-26 makes sync a requirement rather than an option there — so the
   * first thing it must learn is which account to pull.
   *
   * It is a stage rather than a mode inside `unlock` because it precedes any
   * vault: there is no `initialStatus` to carry and no password to ask for yet.
   */
  | { name: "account-entry" }
  /**
   * This browser enrolled against an account and is **waiting for an existing
   * device to approve it** (MYND-635).
   *
   * A stage rather than component state, which is the whole fix. It used to be
   * a `useState(false)` inside `AccountBootstrap`, so a page refresh erased it
   * — and the boot probe, which routes on `vault.meta` existence alone, then
   * saw the meta the join had already written and sent the user to `/unlock`.
   * The password worked (the meta is the account's real one), so they landed in
   * a correctly-keyed but EMPTY vault, with the approval screen unreachable and
   * nothing saying why. A pending device holds no token and can pull nothing,
   * so "empty" was the honest content of a state the UI had lost track of.
   *
   * Web-only in practice, and by a reason rather than a flag: on desktop
   * enrolment happens FROM an unlocked vault and the Settings panel already
   * surfaces the wait, so there is nothing for a pre-unlock stage to add. The
   * browser is the only client that can be nothing BUT pending.
   *
   * Carries no payload. The fact is on disk — identity persisted, token absent
   * — and re-derived by the probe on every boot, so a copy here could only go
   * stale.
   */
  | { name: "pending-approval" }
  | {
      /**
       * Restore-from-backup flow (MYND-56 / MYND-218). A pre-unlock-class
       * Stage screen (the 2026-05-08 modal carve-out is post-unlock-only),
       * reachable from welcome (fresh install), the vault picker, the
       * corrupted-vault unlock state, and Settings (which routes OUT of the
       * editor — the flow is one screen for all four entries). Exit is
       * reprobe-based (MYND-219 / SYNC-16): App.tsx's `reprobe()` re-runs
       * boot routing, so after a successful restore the user lands on the
       * picker/unlock with the new vault visible. `entry` is payload (not
       * part of the discriminator) — copy/back-label only.
       */
      name: "restore-backup";
      entry: "welcome" | "picker" | "corrupted" | "settings";
    };

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
  /**
   * create-vault → unlock(Exists). **Auto-unlock failure path.** The
   * vault was created (commit ok) but the chained `vault_unlock`
   * call rejected — the user lands on the unlock screen and retypes
   * the password manually. Defensive: should not trigger in normal
   * flow because the same password just succeeded inside `commit`.
   *
   * `vaultId` is the just-created vault's id (returned by `commit`); it
   * rides onto the resulting `unlock` Stage so the manual retry targets
   * that exact vault. Without it the retry hits the sole-vault fallback,
   * which resolves to a non-existent legacy path once a second vault
   * exists (`VaultNotFound`). `undefined` only on the legacy sole-vault path.
   */
  | { type: "create-vault.commit-success"; vaultId?: VaultId }
  /**
   * create-vault → editor. **Auto-unlock success path.** PRD Q4(a):
   * after `commit` resolves, CreateVault re-uses the just-typed
   * password to invoke `vault_unlock`. On resolve, slot is populated
   * and the user lands directly in editor without retyping. The
   * password itself does NOT travel via Stage payload — it's held
   * by the CreateVault reducer and passed directly to vault_unlock,
   * then wiped on resolve. `vaultId` is the just-created vault's id
   * (MYND-219 / SYNC-17) — it rides onto the editor stage so the
   * editor's lock/relock exits stay vault-addressed.
   */
  | { type: "create-vault.auto-unlock-success"; vaultId?: VaultId }
  /** unlock(decrypting) → editor on `vault_unlock` IPC resolve. The
   *  unlock stage's own targeting `vaultId` threads onto the editor
   *  stage (MYND-219 / SYNC-17) — no action payload needed. */
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
   * editor → unlock(Exists, vaultId: target). **Multi-vault switch route**
   * (MYND-205, multi-vault sub-feature 4). Dispatched by App.tsx's
   * `switchVault` orchestration (the account-chip dropdown, sub-feature 4
   * task 5) AFTER the param-less `vault_lock()` four-surface teardown has
   * already torn down the prior vault (graceful `flushIfDirty` + keys +
   * indices + attachment-refs, SYNC-8). The side effect (`vault_lock()`)
   * runs in the dispatch handler, exactly like the editor Lock button fires
   * `vault_lock` before transitioning to `unlock(Exists)` — the only delta
   * is this arm carries the TARGET vault's `VaultId` on the resulting
   * `unlock` Stage's payload so `<Unlock>` threads it into the
   * vault-addressed `unlock` IPC (SYNC-6). The user lands on the target's
   * unlock screen (same Stage shape `picker.select-vault` produces) and
   * types the target's password; that unlock makes the target the sole
   * `Unlocked` slot (no pointer-flip; SYNC-1). NOT a separate teardown —
   * it reuses the existing `vault_lock()` primitive. See `decisions.md`
   * 2026-06-09 "Multi-vault in-app switcher + label management".
   */
  | { type: "editor.switch-vault"; vaultId: VaultId }
  /**
   * editor → create-vault. **Create-another route from the in-app
   * switcher** (MYND-205, multi-vault sub-feature 4 task 5). Dispatched by
   * App.tsx when the user picks the account-chip dropdown's "Create another
   * vault" footer. Routes into the existing vault-creation flow — the SAME
   * target as the picker's `picker.create-vault` affordance, but from the
   * editor stage rather than the picker. Under SYNC-1, committing the new
   * vault locks the currently-unlocked one (the create → auto-unlock chain
   * lands the user in the new vault's editor); the fresh `vaults/<new-id>/`
   * minting + guard scoping (SYNC-9) live in the IPC layer, not here. The
   * switcher's row-selection path uses `editor.switch-vault` instead — this
   * arm is only the "make a brand-new vault" branch.
   */
  | { type: "editor.create-vault" }
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
   * `vaultId` is the recovery's selected target (the recover screen's
   * reducer owns it — MYND-206 selection / sole-vault null), threaded
   * so the post-cancel unlock stays vault-addressed at ≥2 vaults
   * (MYND-219 / SYNC-17).
   */
  | { type: "recover.cancel"; vaultId?: VaultId }
  /**
   * recover → editor. Dispatched by PasswordResetStep on A8f
   * success. Stage transition is not sub-step-aware — Stage's
   * `subStep` is a mount-time hint and may drift from the recover
   * screen's live reducer state across silent-recovery swaps; the
   * recover-screen component is the gate that ensures only
   * `password-reset` dispatches this action. `vaultId` is the
   * just-recovered vault's id (MYND-219 / SYNC-17) — threads onto the
   * editor stage for vault-addressed lock/relock exits.
   */
  | { type: "recover.complete-success"; vaultId?: VaultId }
  /**
   * picker → unlock(Exists). Dispatched by the vault picker screen when
   * the user selects a vault row (MYND-204). Carries the chosen
   * `VaultId` so the App-side handler can thread it through the
   * vault-addressed `unlock` IPC (SYNC-6 targeting; the runtime evicts
   * any prior `Unlocked` entry per SYNC-1 — lock-on-pick is enforced at
   * the IPC layer, not via an extra Stage hop). `initialStatus` is
   * `Exists` — the picker only lists discovered vaults, and a `Corrupted`
   * row would surface its fail-closed UI on the unlock screen once
   * selected (the picker does not pre-route corrupted vaults to a
   * separate stage).
   */
  | { type: "picker.select-vault"; vaultId: VaultId }
  /**
   * unlock → picker. Dispatched by the "Choose a different vault" back
   * affordance `<Unlock>` renders ONLY when it was reached from the picker
   * (the `unlock` Stage's `fromPicker` payload is set). Returns the user to
   * the ≥2-vault selection surface so a mis-picked vault is recoverable
   * without quitting (MYND-204 follow-up — the picker → unlock hop was
   * previously one-way). No side effect: picking a row never unlocked
   * anything (the vault-addressed `unlock` IPC only fires on password submit),
   * so there is nothing to tear down on the way back. The picker re-fetches
   * its own list on mount, so the returned surface is always current.
   */
  | { type: "unlock.back-to-picker" }
  /**
   * picker → create-vault. Dispatched by the picker's "create another"
   * affordance (MYND-204, story 6). Routes into the existing
   * vault-creation flow; under SYNC-1 creating a new vault locks the
   * current one (no-op at cold boot — nothing is unlocked) and the
   * create → auto-unlock chain lands the user in the new vault's editor.
   * The fresh `vaults/<new-id>/` minting + guard scoping (SYNC-9) live
   * in the IPC layer (task 7), not here.
   */
  | { type: "picker.create-vault" }
  /** welcome → restore-backup (fresh-install restore, user-guide UX contract). */
  | { type: "welcome.restore-backup" }
  /**
   * welcome → editor (MYND-424). "Add this device to an existing account":
   * `sync_join_account` bootstrapped + UNLOCKED a fresh local vault from the
   * server's meta, so the device lands straight in the editor (sync pending
   * until an existing device approves). `vaultId` is the joined vault's id.
   */
  | { type: "welcome.join-success"; vaultId?: VaultId }
  /**
   * picker → editor (myne#221). The SAME join as `welcome.join-success`, from
   * the ≥2-vault picker's "add this device to an account" affordance. A second
   * action rather than one join action legal from several stages, because that
   * is how this table already models a shared destination — `picker.create-vault`
   * / `editor.create-vault`, and four separate `*.restore-backup` entries.
   *
   * Nothing is unlocked on the picker, so unlike the switcher entry below this
   * one needs no teardown before the join runs.
   */
  | { type: "picker.join-success"; vaultId?: VaultId }
  /**
   * unlock → editor (myne#221). The join reached from the EDITOR's account-chip
   * switcher — which lands here rather than dispatching from `editor` because
   * the switcher entry tears the active vault down FIRST (`leaveActiveVault` →
   * `editor.lock`) and opens the modal over the resulting unlock screen.
   *
   * That teardown is not tidiness: `sync_join_account` bootstraps AND unlocks a
   * different vault, and SYNC-1 (`set_unlocked_locking_others`) zeroizes the
   * previous one. A modal left over a mounted editor would therefore sit on
   * plaintext whose keys are already gone — for the whole `join.pending` wait,
   * which lasts until another device approves.
   */
  | { type: "unlock.join-success"; vaultId?: VaultId }
  /** picker → restore-backup ("restore an additional vault", SYNC-5 KeepBoth door). */
  | { type: "picker.restore-backup" }
  /**
   * unlock(corrupted) → restore-backup. The fail-closed corrupted screen's
   * primary CTA (decisions.md 2026-06-10 superseding entry: the single-CTA
   * posture predates a real restore route).
   */
  | { type: "unlock.restore-backup" }
  /** editor → restore-backup (Settings → Storage entry; flow is pre-unlock-class). */
  | { type: "editor.restore-backup" };

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
          // First-run entry — open the flow on the safety briefing
          // before password setup (MYND-114). Picker / switcher
          // "create another" entries skip it (briefing unset).
          return { name: "create-vault", briefing: true };
        case "welcome.restore-backup":
          return { name: "restore-backup", entry: "welcome" };
        case "welcome.join-success":
          // Device-join bootstrapped + unlocked a fresh local vault — land in
          // the editor directly, vault-addressed (MYND-424).
          return { name: "editor", vaultId: action.vaultId };
        default:
          return rejectIllegal(prev, action);
      }
    case "create-vault":
      switch (action.type) {
        // NOTE: Back-from-create is NOT a transition arm. It has reprobe
        // semantics (MYND-219 / SYNC-16): App.tsx's `reprobe()` re-runs
        // boot routing so the user returns where they came from — welcome
        // at 0 vaults, the lone vault's unlock at 1, the picker at ≥2.
        // The former `create-vault.back` → welcome arm stranded picker/
        // editor entrants on Welcome.
        case "create-vault.commit-success":
          // Auto-unlock failure fallback (PRD Q4(a)): vault is
          // created but the chained vault_unlock IPC rejected; user
          // retypes manually on the unlock screen. Carry the just-created
          // vault's id so the manual retry targets it (SYNC-6) instead of
          // the sole-vault fallback (which would 404 with >=2 vaults).
          return {
            name: "unlock",
            initialStatus: { kind: "Exists" },
            vaultId: action.vaultId,
          };
        case "create-vault.auto-unlock-success":
          // Auto-unlock success path: vault_unlock resolved, slot is
          // populated, user lands in editor without retyping. The
          // just-created vault's id rides onto the editor stage
          // (MYND-219 / SYNC-17 vault-addressed exits).
          return { name: "editor", vaultId: action.vaultId };
        default:
          return rejectIllegal(prev, action);
      }
    case "unlock":
      switch (action.type) {
        case "unlock.success":
          // Thread the unlock's targeting id onto the editor stage so
          // lock/relock exits stay vault-addressed (MYND-219 / SYNC-17).
          return { name: "editor", vaultId: prev.vaultId };
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
        case "unlock.join-success":
          // The switcher's join door (myne#221). It routed HERE first — flush +
          // `vault_lock()` + `editor.lock` — so the join ran with no vault
          // mounted; now the joined vault is the sole `Unlocked` slot and the
          // editor entry is vault-addressed, exactly like the welcome path.
          return { name: "editor", vaultId: action.vaultId };
        case "unlock.back-to-picker":
          // Return to the ≥2-vault picker. Reached only when the unlock was
          // entered via `picker.select-vault` (the back affordance is gated on
          // the `fromPicker` payload), so the picker is a meaningful
          // destination. Payload-free: the picker re-fetches its own list.
          return { name: "picker" };
        case "unlock.restore-backup":
          // Corrupted-vault repair door (decisions.md 2026-06-10 supersede).
          return { name: "restore-backup", entry: "corrupted" };
        default:
          return rejectIllegal(prev, action);
      }
    case "editor":
      switch (action.type) {
        case "editor.lock":
          // Post-explicit-lock entry: vault.meta is known good
          // (the user just locked from a successful editor session),
          // so initialStatus is `Exists`. No intermediate "locked"
          // screen — the user lands directly on the password form,
          // re-targeted at the vault that was just locked (MYND-219 /
          // SYNC-17: at ≥2 vaults the sole-vault `None` fallback would
          // be ambiguous).
          return { name: "unlock", initialStatus: { kind: "Exists" }, vaultId: prev.vaultId };
        case "editor.switch-vault":
          // Multi-vault switch route (MYND-205). The dispatch handler
          // (`switchVault`) has already fired the param-less `vault_lock()`
          // four-surface teardown (SYNC-8), so the prior vault is fully torn
          // down — this arm only routes to the TARGET's unlock screen,
          // carrying its `vaultId` on the resulting `unlock` Stage's payload
          // so `<Unlock>` threads it into the vault-addressed `unlock` IPC
          // (SYNC-6). Same Stage shape `picker.select-vault` produces;
          // `initialStatus` is `Exists` (the switcher only lists discovered
          // vaults — a corrupted target surfaces its fail-closed UI on the
          // unlock screen). The target's unlock makes it the sole `Unlocked`
          // slot (SYNC-1 — no pointer-flip).
          return {
            name: "unlock",
            initialStatus: { kind: "Exists" },
            vaultId: action.vaultId,
          };
        case "editor.restore-backup":
          // Settings → Storage entry. The flow is pre-unlock-class; the
          // vault stays Unlocked (restore never touches the slot map) and
          // the reprobe exit routes by slot priority.
          return { name: "restore-backup", entry: "settings" };
        case "editor.create-vault":
          // "Create another vault" footer in the account-chip switcher
          // dropdown (MYND-205 task 5) → existing vault-creation flow. Same
          // target as `picker.create-vault`, dispatched from the editor stage.
          return { name: "create-vault" };
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
          // component. The action's `vaultId` (the recovery's selected
          // target) keeps the post-cancel unlock vault-addressed
          // (MYND-219 / SYNC-17).
          return { name: "unlock", initialStatus: { kind: "Exists" }, vaultId: action.vaultId };
        case "recover.complete-success":
          // PasswordResetStep dispatches this on A8f success. Same
          // reasoning as recover.cancel — Stage trusts the dispatch
          // site. The recovered vault's id threads onto the editor
          // stage (MYND-219 / SYNC-17).
          return { name: "editor", vaultId: action.vaultId };
        default:
          return rejectIllegal(prev, action);
      }
    case "picker":
      switch (action.type) {
        case "picker.select-vault":
          // User selected a vault row. Route to the unlock screen for
          // that vault; `initialStatus` is `Exists` (the picker lists
          // discovered vaults — a corrupted one surfaces its fail-closed
          // UI on the unlock screen, not via a separate stage). The chosen
          // `vaultId` rides on the resulting `unlock` Stage's payload so
          // `<Unlock>` threads it into the vault-addressed `unlock` IPC
          // (SYNC-6 targeting); the runtime evicts any prior `Unlocked`
          // entry at the IPC layer (SYNC-1 — lock-on-pick, no extra Stage
          // hop). Carrying the id on the Stage (rather than App-side
          // mutable state) keeps the targeting survivable across the React
          // re-render between dispatch and the Unlock mount.
          //
          // `fromPicker: true` marks this unlock as picker-reached so
          // `<Unlock>` renders the "Choose a different vault" back affordance
          // (`unlock.back-to-picker` → picker). It is the ONLY transition that
          // sets the flag — every other path to unlock has no picker to
          // return to.
          return {
            name: "unlock",
            initialStatus: { kind: "Exists" },
            vaultId: action.vaultId,
            fromPicker: true,
          };
        case "picker.restore-backup":
          return { name: "restore-backup", entry: "picker" };
        case "picker.create-vault":
          // "Create another" affordance → existing vault-creation flow.
          return { name: "create-vault" };
        case "picker.join-success":
          // The picker's join door (myne#221) — the same landing as the welcome
          // one: `sync_join_account` already bootstrapped and unlocked the
          // vault, so the editor entry is direct and vault-addressed.
          return { name: "editor", vaultId: action.vaultId };
        default:
          return rejectIllegal(prev, action);
      }
    case "restore-backup":
      // No transition exits: the flow leaves via App.tsx's `reprobe()`
      // (MYND-219 / SYNC-16), so every (restore-backup × action) pair is
      // illegal by design.
      return rejectIllegal(prev, action);
    case "account-entry":
      switch (action.type) {
        case "create-vault.start":
          // The one genuine exit (`decisions.md` 2026-08-15): a user with no
          // account, on a client that can now make one. It is a stage change
          // rather than a reprobe because nothing about the container has
          // changed — the user is choosing a different door, not reporting a
          // new fact about disk.
          //
          // `briefing: true`, matching `welcome`: this is a first-run entry,
          // and the pre-create safety briefing (MYND-114) is exactly as owed to
          // someone starting in a browser as to someone starting on a desktop.
          return { name: "create-vault", briefing: true };
        default:
          // Otherwise the same posture as before: a validated account number is
          // not a stage change, it is the input to the unlock that follows
          // (task 32's flow), which re-enters through `reprobe()` once the vault
          // container exists. Modelling an `account-entry.success` action would
          // put the same fact in two places — the reducer and the screen — and
          // they would drift.
          return rejectIllegal(prev, action);
      }
    case "pending-approval":
      // Same posture again, and here it is load-bearing rather than tidy
      // (MYND-635). Approval is granted on ANOTHER device; this one learns of
      // it by polling. An action-driven exit would mean the screen deciding it
      // is approved, which is the shape of the bug being fixed — a state the
      // client believed instead of read. The exit is `reprobe()`, so the same
      // on-disk fact that put the user here is what takes them out.
      return rejectIllegal(prev, action);
    default:
      return assertNever(prev);
  }
}

/**
 * Per-vault runtime-slot view consumed by `initialStageFromProbe`
 * (MYND-204, multi-vault sub-feature 3 — SYNC-4 boot-routing rework).
 *
 * Maps each discovered `VaultId` to its in-memory `Slot` kind
 * (`vault_slot_kind` is per-vault under SYNC-6 — `probeSlotKind(vaultId)`).
 * Under SYNC-1 (one vault unlocked at a time) AT MOST ONE entry is
 * non-`Empty`. Missing keys are treated as `Empty` (a vault the runtime
 * has never touched this session has no live slot). Modeled as a plain
 * `Record` rather than a `Map` so it round-trips trivially over the
 * App.tsx probe boundary and is cheap to scan.
 */
export type SlotMap = Record<VaultId, SlotKind>;

/**
 * Map the multi-vault boot probes (`vault_list` on disk +
 * per-vault `vault_slot_kind` on runtime) to the initial Stage at app
 * boot (MYND-204, SYNC-4 rework of the former
 * `(vaultResult, slotKind)` single-vault signature).
 *
 * **Runtime slot trumps disk for non-Empty variants.** A live
 * `Recovering` or `Unlocked` slot (in ANY `slotMap` entry) means the
 * Rust process is mid-flow (typically post-WebView-reload — Tauri's
 * host outlives the JS runtime across Cmd+R / HMR). Under SYNC-1 at
 * most one slot is non-Empty. At cold boot every slot is `Empty` and
 * list-based routing applies.
 *
 * Decision tree (slot-priority first, then vault-count):
 * - any slot `Recovering`        → `recover` with `subStep = password-reset`
 *   (skip phrase-entry; A8d already produced the in-memory `root_key`
 *   in a prior session — `recovery-flow.md` §4.1's non-dismissible
 *   chained step continues from where the user left off).
 * - any slot `Unlocked`          → `editor` (auto-unlock parity;
 *   the Editor mount guard's `vault_is_unlocked()` probe is the
 *   reality check if Rust state somehow disagrees). `Recovering` wins
 *   over `Unlocked` if both somehow appear (defensive — SYNC-1 forbids
 *   it; the non-dismissible recovery step takes precedence).
 * - all slots Empty + `Err(IoError)`    → `unlock` with `initialStatus = IoError`
 *   (list-level IO failure — fail-closed regardless of vault count).
 * - all slots Empty + `Ok([])`          → `welcome` (0 vaults)
 * - all slots Empty + `Ok([v])`         → `unlock` for that one vault,
 *   mapping its `VaultSummary` status: `Exists` → `Exists`,
 *   `Corrupted` → `Corrupted` (fail-closed corrupted-vault UI).
 * - all slots Empty + `Ok([v0, v1, …])` → `picker` (≥2 vaults — SYNC-7a;
 *   the picker screen renders the full list, the user chooses).
 *
 * The IO-error path lands in `unlock` (not a separate `error` stage)
 * per Q10 α=3 — Unlock component renders `<FailClosedError reason="io-error">`
 * in place of the password form when `initialStatus.kind === "IoError"`.
 *
 * **`VaultSummary` has no `Missing` / `IoError` per-vault status** (unlike
 * the single-vault `VaultStatus`): a vault absent from disk is simply not
 * in the list (0-count → welcome), and IO failure is a *list-level* error
 * (`VaultListResult` err arm). So the three fail-closed mappings
 * (Exists/Corrupted/IoError) are preserved: Exists/Corrupted come from the
 * single-vault `status`, IoError from the list-level err arm.
 *
 * **Exotic disagreements** (a slot says Recovering/Unlocked but the list
 * is empty / IoError) are routed by slot anyway; the downstream A8f /
 * editor mount surfaces the real failure. Keeping the boot decision tree
 * slot-priority preserves the silent-recovery posture (Q4) at the boundary.
 */
export function initialStageFromProbe(
  vaultList: VaultListResult,
  slotMap: SlotMap,
  /**
   * Whether this device has enrolled against an account but is still awaiting
   * approval from one that already has access (MYND-635).
   *
   * A third probe input because the first two cannot express it: the disk says
   * a `vault.meta` exists — the join writes it *before* the enrolment that
   * comes back pending — and the runtime slot says nothing, because a refresh
   * empties it. So the only two signals boot had both reported a perfectly
   * ordinary vault, and routing sent a device that can sync nothing to the
   * unlock screen.
   *
   * Optional, defaulting to "no": every desktop caller is unchanged by
   * construction rather than by remembering to pass `false`.
   */
  pendingApproval = false,
): Stage {
  // Slot-priority: a non-Empty runtime slot pins the boot stage
  // regardless of disk state / vault count. Under SYNC-1 at most one
  // slot is non-Empty; we scan defensively and let `Recovering` win
  // over `Unlocked` (the non-dismissible chained recovery step).
  const slots = Object.values(slotMap);
  if (slots.includes("Recovering")) {
    return { name: "recover", subStep: "password-reset" };
  }
  if (slots.includes("Unlocked")) {
    return { name: "editor" };
  }

  // All slots Empty (or no live slots) — fall through to list-based
  // routing. A list-level IO failure is fail-closed regardless of count.
  if ("err" in vaultList) {
    return {
      name: "unlock",
      initialStatus: { kind: "IoError", ioKind: vaultList.err.detail.io_error_kind },
    };
  }

  const vaults = vaultList.ok;
  if (vaults.length === 0) {
    // On the web client the empty state is not "no vault yet, make one", it is
    // "this browser has not been told which account to pull"
    // (phase3-web-client task 85: the `Missing → welcome` mapping is wrong
    // there, and it is wrong in the direction that dead-ends the user).
    //
    // **Gated on `localOnlyVault`, not on `vaultCreation`** (`decisions.md`
    // 2026-08-15). Those two were the same question for as long as the web
    // client could not create an account; they stopped being the same question
    // the day it could. What actually decides this arm is whether a vault on
    // this client may be the only copy: where sync is required, the first
    // question is still which account, and `AccountBootstrap` is what asks it —
    // now with a "create one" affordance beside the sign-in, since creation
    // ships here too. Keeping the old `vaultCreation` gate would have routed the
    // browser to `welcome`, which is substituted out of that bundle and would
    // have rendered a stub as the entry screen.
    return has("localOnlyVault") ? { name: "welcome" } : { name: "account-entry" };
  }
  if (vaults.length === 1) {
    // Exactly one vault — unlock it directly (SYNC-7a: no picker for the
    // single-vault user). Map its on-disk health to the unlock screen's
    // fail-closed surfaces. Carry the lone vault's id as the unlock target
    // (task 8) so the single-vault path also unlocks explicitly — parity
    // with the picker path, and a clean migration to the vault-addressed
    // `unlock` IPC even when there is only one vault on disk. (A `Corrupted`
    // vault never reaches an unlock IPC — `<Unlock>` renders the fail-closed
    // surface for the first frame — so its `vaultId` is moot, but set for
    // uniformity.)
    const vaultId = vaults[0].id;
    const status = vaults[0].status;
    switch (status.kind) {
      case "Exists":
        // A device still awaiting approval goes back to the wait, not to the
        // unlock form (MYND-635). Its `vault.meta` is real — the join fetched
        // the account's own and wrote it BEFORE enrolling — so the password
        // works and the vault opens; it is simply EMPTY, because a pending
        // device holds no token and can pull nothing. Offering unlock there
        // hands the user a working door onto an empty room and no way back to
        // the screen that explains why.
        //
        // Deliberately only under `Exists`. A `Corrupted` container cannot be
        // unlocked at all, so its answer stays the web re-bootstrap below —
        // waiting for approval on a vault that will not open is a longer dead
        // end than the one it replaces. And this sits AFTER the slot-priority
        // checks above on purpose: an `Unlocked` runtime slot means a vault is
        // genuinely open, and no enrolment fact should evict a user from it.
        //
        // Gated on the same capability the arms above use, and the gate is
        // load-bearing rather than tidy. A DESKTOP device can be pending too —
        // enrol from Settings, quit before another device approves — and sending
        // it here would lock the user out of a vault that opens perfectly well:
        // on desktop, awaiting sync approval does not block local use, and the
        // wait already has a home in the Settings panel. The browser is the only
        // client with nowhere else to put it and nothing else to do until the
        // approval lands.
        // Same regate as the empty-vault arm above (`decisions.md` 2026-08-15):
        // the question is "is this the client whose vault came from a server",
        // which `localOnlyVault` answers directly and `vaultCreation` only used
        // to answer by coincidence.
        if (pendingApproval && !has("localOnlyVault")) {
          return { name: "pending-approval" };
        }
        return { name: "unlock", initialStatus: { kind: "Exists" }, vaultId };
      case "Corrupted":
        // On a client whose vault came from a server, a corrupt local container
        // is **not data loss** — `decisions.md` 2026-07-26 ("TOFU re-bootstrap
        // is routine") is explicit that eviction and its cousins are a
        // re-bootstrap, because every byte is on the server. Routing there to
        // the fail-closed "restore from a backup" surface would offer a remedy
        // that does not exist on web (backup is an absent capability) while the
        // real one — re-enter the account number and re-sync — sits one screen
        // away. Task 22 makes that path incremental; this is its entry point.
        return has("backup")
          ? { name: "unlock", initialStatus: { kind: "Corrupted" }, vaultId }
          : { name: "account-entry" };
      default:
        return assertNever(status);
    }
  }
  // ≥2 vaults — show the picker (SYNC-7a).
  return { name: "picker" };
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

import { has } from "../platform/capabilities";
import type { SlotKind } from "../types/slot-kind";
import type { VaultListResult, VaultSummary } from "../types/vault-summary";

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
  // `decisions.md` 2026-08-15. The web client's entry screen gained a "create an
  // account" affordance, so `account-entry` has one legal exit that is a real
  // stage change rather than a reprobe.
  "account-entry|create-vault.start": "create-vault",
  // Back-from-create is reprobe-based (MYND-219 / SYNC-16) — no
  // `create-vault.back` action exists; App.tsx calls `reprobe()`.
  "create-vault|create-vault.commit-success": "unlock",
  "create-vault|create-vault.auto-unlock-success": "editor",
  "unlock|unlock.success": "editor",
  "editor|editor.lock": "unlock",
  "editor|editor.switch-vault": "unlock",
  "editor|editor.create-vault": "create-vault",
  "unlock|unlock.start-recovery": "recover",
  "unlock|unlock.resume-recovery": "recover",
  "recover|recover.cancel": "unlock",
  "recover|recover.complete-success": "editor",
  "picker|picker.select-vault": "unlock",
  "unlock|unlock.back-to-picker": "picker",
  "picker|picker.create-vault": "create-vault",
  // Restore-from-backup entries (MYND-56). Exit is reprobe-based — no
  // `restore-backup.*` exit arms exist by design (same posture as
  // back-from-create).
  "welcome|welcome.restore-backup": "restore-backup",
  // The three device-join doors (MYND-424 welcome; myne#221 picker + switcher).
  // One action per SOURCE stage, as with `*.create-vault` / `*.restore-backup`.
  // The switcher's is keyed on `unlock` because that entry locks the active
  // vault and routes there before the join runs.
  "welcome|welcome.join-success": "editor",
  "picker|picker.join-success": "editor",
  "unlock|unlock.join-success": "editor",
  "picker|picker.restore-backup": "restore-backup",
  "unlock|unlock.restore-backup": "restore-backup",
  "editor|editor.restore-backup": "restore-backup",
};

const ALL_STAGES_FOR_VERIFICATION: Stage[] = [
  { name: "welcome" },
  // The web first-run identity step. It has no outgoing transitions in the
  // table yet — the account number is carried into unlock by the screen itself
  // (task 32's flow), not by a stage action — so this entry asserts the
  // stage does not accidentally accept one.
  { name: "account-entry" },
  // The web approval wait (MYND-635). Like `account-entry` it has no outgoing
  // transitions — approval happens on another device and is discovered by
  // polling, never by an action — so this entry asserts it accepts none.
  { name: "pending-approval" },
  { name: "create-vault" },
  // Coverage entry for the optional `briefing` payload field (MYND-114).
  // Payload, not the `name` discriminator — `transition` ignores it on
  // every (Stage × Action) pair; this entry confirms its presence does
  // not change transition outcomes.
  { name: "create-vault", briefing: true },
  { name: "unlock", initialStatus: { kind: "Exists" } },
  // Coverage entry for the optional `suspicionReason` payload field
  // (`decisions.md` 2026-05-08). The `transition` fn ignores the field;
  // this entry exercises every (Stage × Action) pair to confirm the
  // field's presence does not change transition outcomes.
  { name: "unlock", initialStatus: { kind: "Exists" }, suspicionReason: "vault-meta-changed-externally" },
  // Coverage entry for the optional `vaultId` payload field (MYND-204
  // task 8). Like `suspicionReason`, it is payload (not the `name`
  // discriminator), so `transition` ignores it on every (Stage × Action)
  // pair — this entry confirms its presence does not change outcomes.
  { name: "unlock", initialStatus: { kind: "Exists" }, vaultId: "00000000-0000-7000-8000-00000000000a" },
  // Coverage entry for the optional `fromPicker` payload field (picker →
  // unlock back affordance). Payload, not the `name` discriminator — this
  // entry confirms its presence does not change transition outcomes on any
  // (Stage × Action) pair.
  { name: "unlock", initialStatus: { kind: "Exists" }, fromPicker: true },
  { name: "editor" },
  // Coverage entry for the editor stage's optional `vaultId` payload
  // (MYND-219 / SYNC-17) — same payload-ignoring contract as the unlock
  // entries above.
  { name: "editor", vaultId: "00000000-0000-7000-8000-00000000000a" },
  { name: "recover", subStep: "select" },
  // Restore-from-backup flow (MYND-56). `entry` is payload (copy only);
  // one entry exercises the variant across every (Stage × Action) pair.
  { name: "restore-backup", entry: "welcome" },
  { name: "recover", subStep: "phrase-entry" },
  { name: "recover", subStep: "decrypting" },
  { name: "recover", subStep: "password-reset" },
  { name: "recover", subStep: "delete-confirm" },
  { name: "picker" },
];

const ALL_ACTIONS_FOR_VERIFICATION: Action[] = [
  { type: "welcome.join-success" },
  { type: "picker.join-success" },
  { type: "unlock.join-success" },
  { type: "create-vault.start" },
  { type: "create-vault.commit-success" },
  { type: "create-vault.auto-unlock-success" },
  { type: "unlock.success" },
  { type: "editor.lock" },
  // `editor.switch-vault` carries a `vaultId`; the verification walk only
  // inspects the resulting `Stage["name"]`, so a placeholder id suffices
  // (the legality table tracks `name` only, not payload — like
  // `picker.select-vault`).
  { type: "editor.switch-vault", vaultId: "00000000-0000-7000-8000-000000000000" },
  { type: "editor.create-vault" },
  { type: "unlock.start-recovery" },
  { type: "unlock.resume-recovery" },
  { type: "recover.cancel" },
  { type: "recover.complete-success" },
  // `picker.select-vault` carries a `vaultId`; the verification walk
  // only inspects the resulting `Stage["name"]`, so a placeholder id
  // suffices (the legality table tracks `name` only, not payload).
  { type: "picker.select-vault", vaultId: "00000000-0000-7000-8000-000000000000" },
  { type: "unlock.back-to-picker" },
  { type: "picker.create-vault" },
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
 * Walk the `(vaultList × slotMap)` boot-probe cross-product and assert
 * `initialStageFromProbe` produces the expected Stage (MYND-204 SYNC-4
 * rework). Catches regressions where a refactor on either side (Rust enum
 * drift, TS mapping change, picker-visibility threshold) breaks the boot
 * routing — the load-bearing routing test that runs at `pnpm dev` boot and
 * hard-fails on regression.
 *
 * Coverage (vault-count buckets {0, 1, ≥2} × slot-priority {all-Empty,
 * one-Recovering, one-Unlocked} × per-vault status {Exists, Corrupted}
 * where relevant + the list-level IoError fail-closed path):
 * - all-Empty slots:
 *   - 0 vaults                       → welcome
 *   - 1 vault Exists                 → unlock(Exists)
 *   - 1 vault Corrupted              → unlock(Corrupted)
 *   - ≥2 vaults (Exists/Corrupted mix) → picker
 *   - list-level Err(IoError, …)     → unlock(IoError) (count-independent)
 * - one-Recovering slot (post-reload mid-recovery): slot-priority wins for
 *   0 / 1 / ≥2 vault counts AND the exotic IoError-list disagreement →
 *   recover(password-reset).
 * - one-Unlocked slot (post-reload mid-edit): slot-priority wins for
 *   0 / 1 / ≥2 vault counts → editor.
 */
function verifyInitialStageFromProbe(): void {
  // ---- Small fixture builders (keep the case table readable) ----
  const VID_A = "00000000-0000-7000-8000-00000000000a";
  const VID_B = "00000000-0000-7000-8000-00000000000b";
  const existsVault = (id: VaultId): VaultSummary => ({
    id,
    status: { kind: "Exists" },
    label: null,
    icon: null,
    last_unlock: null,
  });
  const corruptVault = (id: VaultId): VaultSummary => ({
    id,
    status: { kind: "Corrupted" },
    label: null,
    icon: null,
    last_unlock: null,
  });
  const okList = (...vaults: VaultSummary[]): VaultListResult => ({ ok: vaults });
  const errList = (ioKind: IoFailureKind): VaultListResult => ({
    err: { kind: "IoError", detail: { io_error_kind: ioKind } },
  });
  const allEmpty: SlotMap = {};
  const oneRecovering: SlotMap = { [VID_A]: "Recovering" };
  const oneUnlocked: SlotMap = { [VID_A]: "Unlocked" };

  type Case = {
    label: string;
    vaultList: VaultListResult;
    slotMap: SlotMap;
    expectedName: Stage["name"];
    expectedInitialStatus?: { kind: "Exists" | "Corrupted" | "IoError"; ioKind?: IoFailureKind };
    expectedSubStep?: RecoverSubStep;
    // Single-vault boot arm threads the lone vault's id as the unlock target
    // (task 8). `undefined` here means "do not assert" (multi-vault picker
    // route + list-level IoError carry no targeting id).
    expectedVaultId?: VaultId;
    /** The third probe input (MYND-635). Omitted = not pending, as on desktop. */
    pendingApproval?: boolean;
  };
  const cases: Array<Case> = [
    // ---- All slots Empty: list-based routing (cold boot path) ----
    {
      // Capability-DERIVED rather than hardcoded (phase3-web-client task 85):
      // an empty container means "make a vault" only where vault creation
      // exists. Writing `"welcome"` here would be a second statement of the
      // routing rule, and it is the copy that would drift — this harness runs
      // at module load, so a client whose routing legitimately differs would
      // fail to boot rather than fail a test.
      label: "AllEmpty + 0 vaults",
      vaultList: okList(),
      slotMap: allEmpty,
      expectedName: has("localOnlyVault") ? "welcome" : "account-entry",
    },
    {
      label: "AllEmpty + 1 vault Exists",
      vaultList: okList(existsVault(VID_A)),
      slotMap: allEmpty,
      expectedName: "unlock",
      expectedInitialStatus: { kind: "Exists" },
      expectedVaultId: VID_A,
    },
    {
      // Same reasoning: the fail-closed surface's remedy is "restore from a
      // backup", so it is the right destination only where backup exists.
      label: "AllEmpty + 1 vault Corrupted",
      vaultList: okList(corruptVault(VID_A)),
      slotMap: allEmpty,
      expectedName: has("backup") ? "unlock" : "account-entry",
      expectedInitialStatus: { kind: "Corrupted" },
      expectedVaultId: VID_A,
    },
    {
      label: "AllEmpty + 2 vaults (Exists, Exists)",
      vaultList: okList(existsVault(VID_A), existsVault(VID_B)),
      slotMap: allEmpty,
      expectedName: "picker",
    },
    {
      label: "AllEmpty + 2 vaults (Exists, Corrupted) — picker still",
      vaultList: okList(existsVault(VID_A), corruptVault(VID_B)),
      slotMap: allEmpty,
      expectedName: "picker",
    },
    {
      label: "AllEmpty + Err(IoError, PermissionDenied) — list-level fail-closed",
      vaultList: errList("PermissionDenied"),
      slotMap: allEmpty,
      expectedName: "unlock",
      expectedInitialStatus: { kind: "IoError", ioKind: "PermissionDenied" },
    },
    {
      label: "AllEmpty + Err(IoError, Other) — list-level fail-closed",
      vaultList: errList("Other"),
      slotMap: allEmpty,
      expectedName: "unlock",
      expectedInitialStatus: { kind: "IoError", ioKind: "Other" },
    },
    // ---- One Recovering slot: slot-priority wins over any count ----
    {
      label: "Recovering + 1 vault Exists",
      vaultList: okList(existsVault(VID_A)),
      slotMap: oneRecovering,
      expectedName: "recover",
      expectedSubStep: "password-reset",
    },
    {
      label: "Recovering + 2 vaults — slot-priority over picker",
      vaultList: okList(existsVault(VID_A), existsVault(VID_B)),
      slotMap: oneRecovering,
      expectedName: "recover",
      expectedSubStep: "password-reset",
    },
    {
      label: "Recovering + 0 vaults (exotic) — still recover",
      vaultList: okList(),
      slotMap: oneRecovering,
      expectedName: "recover",
      expectedSubStep: "password-reset",
    },
    {
      label: "Recovering + Err(IoError) (exotic) — still recover",
      vaultList: errList("Other"),
      slotMap: oneRecovering,
      expectedName: "recover",
      expectedSubStep: "password-reset",
    },
    // ---- One Unlocked slot: slot-priority wins over any count ----
    {
      label: "Unlocked + 1 vault Exists",
      vaultList: okList(existsVault(VID_A)),
      slotMap: oneUnlocked,
      expectedName: "editor",
    },
    {
      label: "Unlocked + 2 vaults — slot-priority over picker",
      vaultList: okList(existsVault(VID_A), existsVault(VID_B)),
      slotMap: oneUnlocked,
      expectedName: "editor",
    },
    {
      label: "Unlocked + 0 vaults (exotic) — still editor",
      vaultList: okList(),
      slotMap: oneUnlocked,
      expectedName: "editor",
    },

    // ---- Awaiting approval (MYND-635) ----
    //
    // The bug, as a case: a device that enrolled and is waiting has a real
    // `vault.meta` on disk, because the join writes it BEFORE the enrolment
    // that comes back pending. The first two probes therefore describe an
    // ordinary vault, and boot offered the unlock form — which works, and opens
    // an empty vault, because a pending device holds no token and can pull
    // nothing.
    {
      // Capability-DERIVED, like the two cases above it: the wait is for the
      // client that cannot approve itself and has nowhere else to show it.
      // Desktop can be pending too, and routing it here would lock a user out
      // of a vault that opens fine — awaiting approval does not block local use
      // where the Settings panel already surfaces the wait.
      label: "AllEmpty + 1 vault Exists + pending",
      vaultList: okList(existsVault(VID_A)),
      slotMap: allEmpty,
      pendingApproval: true,
      expectedName: has("localOnlyVault") ? "unlock" : "pending-approval",
    },
    {
      // The default is silence. Every desktop caller omits the argument, so
      // this pins that omitting it changes nothing — the case directly above
      // the pending pair, asserted a second time from the other direction.
      label: "AllEmpty + 1 vault Exists + NOT pending — unchanged",
      vaultList: okList(existsVault(VID_A)),
      slotMap: allEmpty,
      pendingApproval: false,
      expectedName: "unlock",
      expectedInitialStatus: { kind: "Exists" },
      expectedVaultId: VID_A,
    },
    {
      // A corrupt container cannot be unlocked at all, so waiting on it is a
      // longer dead end than the re-bootstrap. Pending must NOT override the
      // corrupted arm.
      label: "AllEmpty + 1 vault Corrupted + pending — corruption still wins",
      vaultList: okList(corruptVault(VID_A)),
      slotMap: allEmpty,
      pendingApproval: true,
      expectedName: has("backup") ? "unlock" : "account-entry",
      expectedInitialStatus: { kind: "Corrupted" },
      expectedVaultId: VID_A,
    },
    {
      // Slot-priority outranks the enrolment fact. A genuinely open vault must
      // not be closed by a stale-looking pending read — the user is inside it.
      label: "Unlocked + 1 vault + pending — an open vault is not evicted",
      vaultList: okList(existsVault(VID_A)),
      slotMap: oneUnlocked,
      pendingApproval: true,
      expectedName: "editor",
    },
  ];

  for (const c of cases) {
    const actual = initialStageFromProbe(c.vaultList, c.slotMap, c.pendingApproval);
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
    if (c.expectedVaultId !== undefined && actual.name === "unlock") {
      if (actual.vaultId !== c.expectedVaultId) {
        throw new Error(
          `[stage] regression: initialStageFromProbe(${c.label}) vaultId=${actual.vaultId}; expected ${c.expectedVaultId}`,
        );
      }
    }
  }
}

if (import.meta.env.DEV) {
  verifyTransitionTable();
  verifyInitialStageFromProbe();
}
