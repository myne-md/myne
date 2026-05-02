// TODO(Phase-1-end): Replace this hand-written file with a `ts-rs`
// auto-generated artifact + a CI drift check. The Rust type lives at:
//   - src-tauri/src/plugins/vault_unlock/state.rs (SlotKind)
//
// Plan: derive `ts_rs::TS` on the enum, run `cargo test` to emit the
// file at this path, and have CI fail if `git diff --exit-code` shows
// drift between the committed file and the regenerated one.
//
// Until then: this file is the manual mirror. Every variant change in
// the Rust enum must be reflected here in the same change.

/**
 * Discriminator for the three-state slot machine in
 * `src-tauri/src/plugins/vault_unlock/state.rs::Slot`. Returned by
 * the `vault_unlock:vault_slot_kind` Tauri command (see
 * `src-tauri/src/plugins/vault_unlock/commands.rs::vault_slot_kind`)
 * for frontend routing decisions:
 *
 * - `"Empty"` — no vault unlocked, no recovery in flight. Frontend
 *   routes to the unlock screen (or vault-creation if no
 *   `vault.meta` exists on disk; that secondary check lives in the
 *   `vault_status` disk probe — `src/lib/vault-status.ts` — not this
 *   type).
 * - `"Recovering"` — A8d (`vault_recover_with_phrase`) succeeded
 *   and the user has not yet committed a new master password via
 *   `vault_complete_recovery` (A8f). Per
 *   `docs/spec/recovery-flow.md` § 4.1, the password-reset form is
 *   non-dismissible from this state. Frontend routes to the
 *   password-reset form.
 * - `"Unlocked"` — vault is fully unlocked. Frontend routes to the
 *   editor.
 *
 * ## Distinct from `vault_status`
 *
 * `vault_status` (`src/types/vault-status.ts`) probes `vault.meta`
 * **on disk** — Exists / Missing / Corrupted. `vault_slot_kind`
 * probes the **in-memory** `VaultRuntimeState` slot. Together they
 * cover the full boot decision tree (disk presence → runtime state).
 *
 * ## Wire shape
 *
 * Bare quoted variant name. The Rust enum derives only `Serialize`
 * with no `#[serde(tag = ...)]`, so unit variants serialize as JSON
 * strings — `"Empty"`, `"Recovering"`, `"Unlocked"`. The TS mirror
 * is therefore a string-literal union, NOT an object with a `kind`
 * field.
 *
 * ## Not the post-recovery happy path
 *
 * `vault_slot_kind` is for **boot-time** and **post-WebView-reload**
 * routing only. The post-recovery happy path is the in-process
 * `Slot::Recovering` → `Slot::Unlocked` transition with the IPC
 * `Ok(())` from `vault_complete_recovery` as the success signal —
 * frontend (B4b) navigates directly to the editor route on success
 * without a defensive `vault_slot_kind` round-trip. Adding such a
 * round-trip would be paranoia per `docs/decisions.md` 2026-05-02
 * (the IPC contract pins `Slot::Unlocked` as the success
 * postcondition).
 */
export type SlotKind = "Empty" | "Recovering" | "Unlocked";
