// SPDX-License-Identifier: AGPL-3.0-only
//! Central `cli_excluded_folders` enforcement (cli-thin-client task 5;
//! MYND-490).
//!
//! **This is the one place the door's reach gets narrowed.** Placed ahead of
//! the individual command tasks (6–9) on purpose: a filter retrofitted onto
//! existing commands fails silently — a missed call site does not error, it
//! just shows an excluded note. Every command that hands a note (or a folder
//! destination) across the wire calls into this module rather than
//! re-deriving the check.
//!
//! "Out of scope" is TWO rules, not one, because the socket path reaches the
//! vault below the layer that applies the second:
//!
//! 1. the user's `cli_excluded_folders` list, and
//! 2. the liveness rule every note surface in the app already applies — a
//!    trashed, sync-tombstoned or template note is not a note the user is
//!    working with.
//!
//! Rule 2 lives client-side in TS (`loadNoteBatch.ts`, `tagBrowser.ts`,
//! `dailyNote.ts`) because every WebView surface goes through the note batch
//! loader; `note_list_from_host` itself returns every id in `notes/` with no
//! filtering at all. This socket never reaches that TS layer, so without
//! rule 2 here `myne list` enumerates notes the user deleted and the
//! documented `myne list | while read id; do myne show $id; done` idiom
//! resurrects trashed plaintext into the pipeline. `daily.rs` already
//! applies the same rule via `daily_match::note_matches_daily` — this module
//! is where `list`/`show`/`search` get it.
//!
//! A note's folder lives in its frontmatter, so the check runs **after**
//! decrypt — this is not a new leak (the desktop can already decrypt; it
//! declines to hand the result to the CLI), but it is the reason `list` must
//! decrypt every note to filter it, and the reason the `MYS1` search index
//! (folder-blind) cannot be queried pre-narrowed (task 7's problem).
//!
//! The canonicalization itself lives in
//! [`myne_core::plugins::prefs::folder_scope`] — this module supplies the
//! desktop-only wiring (decrypt-to-get-folder, read `cli_excluded_folders`
//! from `vault.prefs`) around that shared, pure predicate.
//!
//! See: src-tauri/AGENTS.md "Secret-handling logging discipline" — this
//! module never logs a note id, a folder name, or a body; the one `tracing`
//! call site here carries a bounded outcome tag only.

use myne_core::host::HostCtx;
use myne_core::plugins::notes::commands::note_read_from_host;
use myne_core::plugins::notes::daily_match::{
    fm_deleted_value_strict, fm_template_value_strict, fm_trashed_value_strict,
};
use myne_core::plugins::notes::error::NoteReadError;
use myne_core::plugins::notes::search_sync_core::note_search_core;
use myne_core::plugins::notes::title_extract::{extract_title_slices, fm_folder};
use myne_core::plugins::prefs::commands::prefs_read_from_host;
use myne_core::plugins::prefs::error::PrefsReadError;
use myne_core::plugins::prefs::folder_scope::folder_is_excluded;
use myne_core::plugins::vault_unlock::state::{SlotKind, VaultRuntimeState};
use myne_core::search::SearchIndexState;
use myne_core::vault_io::VaultIo;

/// The canonical trailing-slash folder read from a decrypted note body's
/// frontmatter (`""`/absent = root). Pure. An independent copy rather than a
/// shared helper, for the same reason `folder_scope`'s predicate is:
/// `cli_bridge` must keep working in a
/// `--no-default-features` build, and this is four lines over
/// `title_extract`'s own frontmatter slice + `fm_folder`.
pub fn folder_of(body: &str) -> Option<String> {
    extract_title_slices(body.as_bytes())
        .frontmatter_bytes
        .and_then(fm_folder)
}

/// Whether a decrypted note is one the app itself would not show in an
/// ordinary note surface: trashed, sync-tombstoned (`deleted:`), or a
/// template. The Rust half of the rule `loadNoteBatch.ts` applies TS-side
/// before any WebView list sees a note — see module docs for why the socket
/// path has to apply it itself.
///
/// Value-strict via the same `daily_match` readers
/// `note_matches_daily` already uses, so a user's own non-timestamp
/// `trashed: true` or a quoted `template: "true"` leaves the note live here
/// exactly as it does everywhere else (markdown-dialect.md §3.6.1's
/// collision mitigation). One reader family, one answer.
pub fn note_is_not_live(body: &str) -> bool {
    let Some(fm) = extract_title_slices(body.as_bytes()).frontmatter_bytes else {
        return false; // no frontmatter at all — an ordinary live note
    };
    fm_trashed_value_strict(fm).is_some()
        || fm_deleted_value_strict(fm).is_some()
        || fm_template_value_strict(fm)
}

/// Read `cli_excluded_folders` from `vault.prefs`, mapping the prefs-read
/// failures onto this module's two-state error. Every `*_from_host` helper
/// below opens with this call, so the mapping (a locked vault is
/// [`ScopeError::VaultLocked`], anything else is [`ScopeError::Io`]) has one
/// owner rather than one copy per enforcement point.
async fn excluded_folders(
    host: &dyn HostCtx,
    state: &VaultRuntimeState,
    io: &dyn VaultIo,
) -> Result<Vec<String>, ScopeError> {
    match prefs_read_from_host(host, state, io).await {
        Ok(view) => Ok(view.cli_excluded_folders),
        Err(PrefsReadError::SlotNotUnlocked) => Err(ScopeError::VaultLocked),
        Err(PrefsReadError::Io { .. }) | Err(PrefsReadError::InvalidVaultMeta) => {
            Err(ScopeError::Io)
        }
    }
}

/// Closed outcome of a scope check — collapses every failure to the two
/// states [`super::dispatch::ListOutcome`] already distinguishes, so a
/// caller maps 1:1 without inventing a third wire-visible failure class.
#[derive(Debug, PartialEq, Eq)]
pub enum ScopeError {
    /// The vault locked between the request arriving and the scope check
    /// running — the same narrow race `list_notes` itself already surfaces
    /// as `ListOutcome::VaultLocked`.
    VaultLocked,
    Io,
}

/// Filter `note_ids` down to the ones in CLI scope: not in an excluded
/// folder, and not trashed/tombstoned/a template. Decrypts every candidate to
/// read its frontmatter (there is no cheaper source of truth — see module
/// docs) and applies [`note_is_out_of_scope`].
///
/// **No short-circuit on an empty exclusion list.** An earlier revision
/// returned `note_ids` untouched when `cli_excluded_folders` was empty, which
/// was correct while folder exclusion was the only rule; the liveness rule
/// applies to every vault, so the scan is unconditional now. That makes `list`
/// and `search` O(vault) AEAD work per request even with the door's default
/// settings — the same cost the app's own note-batch loader pays for the same
/// answer, and the reason the rate limit's default budget matters.
///
/// **Fails closed.** A note that cannot be decrypted or read for any reason
/// during the scan is OMITTED rather than included — an unreadable note must
/// never bypass the filter just because its own read happened to fail; the
/// caller sees the same "it isn't there" shape a genuinely excluded note
/// produces, not a fresh error class. `VaultNotUnlocked` from mid-scan
/// (a lock racing the request) still propagates as [`ScopeError::VaultLocked`]
/// rather than being swallowed by the fail-closed rule, matching `list`'s own
/// pre-existing race handling.
pub async fn filter_note_ids_by_scope(
    host: &dyn HostCtx,
    state: &VaultRuntimeState,
    io: &dyn VaultIo,
    note_ids: Vec<String>,
) -> Result<Vec<String>, ScopeError> {
    let excluded = excluded_folders(host, state, io).await?;

    let mut in_scope = Vec::with_capacity(note_ids.len());
    for id in note_ids {
        match note_read_from_host(host, state, id.clone(), io).await {
            Ok(body) => {
                if !note_is_out_of_scope(&body, &excluded) {
                    in_scope.push(id);
                }
            }
            Err(NoteReadError::VaultNotUnlocked) => return Err(ScopeError::VaultLocked),
            Err(_) => {
                // Fail closed (see doc comment): omit rather than risk a
                // filter bypass on an unrelated read failure. No id, no
                // failure detail, crosses this log line (DENY-list: note_id).
                tracing::debug!(
                    stage = "cli_bridge_scope",
                    outcome = "note_unreadable_during_scope_scan"
                );
            }
        }
    }
    Ok(in_scope)
}

/// Rank `query` against the live search index, then narrow the ranked hits
/// to the ones NOT excluded by `cli_excluded_folders` (task 7). The search
/// counterpart to [`filter_note_ids_by_scope`] — reuses it for the actual
/// exclusion decrypt-and-check rather than re-deriving the rule, so `list`
/// and `search` can never drift on what "excluded" means.
///
/// **The oracle property this exists to protect** (task 7's own acceptance
/// criteria — "a count is an oracle"): an excluded hit and a genuine
/// non-match are BOTH just an absence from the returned vector. Nothing in
/// this function's return shape distinguishes "N hits were hidden" from
/// "there were never any hits" — a caller varying the query term cannot use
/// a count difference to infer an excluded folder's contents.
///
/// Checks `Slot::Unlocked` itself, ahead of querying — unlike
/// `filter_note_ids_by_scope`'s prefs-read, [`note_search_core`]'s own gate
/// silently degrades to an empty result on a locked vault instead of
/// erroring. Left unchecked, that would collapse "locked" into "no
/// matches" here in exactly the coincidental way an excluded hit already
/// collapses into "no matches" — and that coincidence must not swallow the
/// wire's `vault_locked` exit code.
pub async fn search_in_scope(
    host: &dyn HostCtx,
    state: &VaultRuntimeState,
    io: &dyn VaultIo,
    search: &SearchIndexState,
    query: &str,
) -> Result<Vec<(String, String)>, ScopeError> {
    if !matches!(state.slot_kind_active().await, SlotKind::Unlocked) {
        return Err(ScopeError::VaultLocked);
    }

    let hits = note_search_core(state, search, query).await;

    // De-dup by note id, keeping the first (highest-ranked) occurrence — an
    // attachment-text hit and its embedding note's own body hit both carry
    // the same `note_id`, and this command's flat id+title shape (unlike
    // the WebView palette) has no attachment badge to tell them apart with.
    let mut seen = std::collections::HashSet::new();
    let mut titles = std::collections::HashMap::new();
    let mut ordered_ids = Vec::new();
    for hit in hits {
        if seen.insert(hit.note_id.clone()) {
            titles.insert(hit.note_id.clone(), hit.title.clone());
            ordered_ids.push(hit.note_id);
        }
    }

    let in_scope_ids = filter_note_ids_by_scope(host, state, io, ordered_ids).await?;
    Ok(in_scope_ids
        .into_iter()
        .filter_map(|id| titles.remove(&id).map(|title| (id, title)))
        .collect())
}

/// Whether a single already-decrypted note body is OUT of CLI scope, against
/// an exclusion list the caller already has in hand — both rules from the
/// module docs, in one predicate so no call site can apply half of them. The
/// pure half of [`body_out_of_scope_from_host`] below, split out so a test can
/// exercise it without a `HostCtx`/`VaultIo` fixture.
pub fn note_is_out_of_scope(body: &str, excluded: &[String]) -> bool {
    note_is_not_live(body) || folder_is_excluded(folder_of(body).as_deref(), excluded)
}

/// Whether a single already-decrypted note body is out of CLI scope, reading
/// `cli_excluded_folders` fresh from `vault.prefs`. The single-note
/// counterpart to [`filter_note_ids_by_scope`] — `show` (task 6) already
/// holds the decrypted body to serve it, so re-decrypting here (as
/// `filter_note_ids_by_scope` does per-id for `list`) would be wasted work.
/// Same failure shape as `filter_note_ids_by_scope`'s prefs read: a locked
/// vault surfaces as [`ScopeError::VaultLocked`], any other prefs-read
/// failure as [`ScopeError::Io`].
pub async fn body_out_of_scope_from_host(
    host: &dyn HostCtx,
    state: &VaultRuntimeState,
    io: &dyn VaultIo,
    body: &str,
) -> Result<bool, ScopeError> {
    let excluded = excluded_folders(host, state, io).await?;
    Ok(note_is_out_of_scope(body, &excluded))
}

/// Whether `folder` (already-normalized, not yet embedded in a note body) is
/// excluded, reading `cli_excluded_folders` fresh from `vault.prefs`. The
/// write-path counterpart to [`body_out_of_scope_from_host`] — `new` (task 8)
/// must refuse BEFORE calling into the core create path, not check post-hoc
/// against a note that already got written. Same failure shape as every
/// other `*_from_host` helper in this module: a locked vault surfaces as
/// [`ScopeError::VaultLocked`], any other prefs-read failure as
/// [`ScopeError::Io`].
pub async fn folder_excluded_from_host(
    host: &dyn HostCtx,
    state: &VaultRuntimeState,
    io: &dyn VaultIo,
    folder: Option<&str>,
) -> Result<bool, ScopeError> {
    let excluded = excluded_folders(host, state, io).await?;
    Ok(folder_is_excluded(folder, &excluded))
}

#[cfg(test)]
mod tests {
    use super::*;
    use myne_core::host::test_host::TestHost;
    use myne_core::paths::{notes_dir_under, vault_root_for_id_from_base};
    use myne_core::plugins::notes::commands::note_create_with_dir;
    use myne_core::plugins::prefs::commands::set_cli_excluded_folders_from_host;
    use myne_core::plugins::vault_unlock::state::{fixture_unlocked_with_keys, test_vault_id};
    use myne_core::test_support::{seed_real_vault_meta, ScopedTempDir};
    use std::path::PathBuf;

    fn rt() -> tokio::runtime::Runtime {
        tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .expect("current-thread runtime build")
    }

    fn noop_hooks() -> myne_core::hooks::Hooks {
        std::sync::Arc::new(myne_core::hooks::NoopHooks)
    }

    /// `note_read_from_host` / `prefs_read_from_host` (the functions under
    /// test go through, not the `_with_dir` cores) resolve their vault
    /// directory from `host.app_data_dir()` + the active vault id — always
    /// `<app_data_dir>/vaults/<id>/`, per `active_vault_root_from_base`. A
    /// `TestHost` rooted at `tmp.path()` plus that exact join is what makes
    /// the fixture resolve the same way production does; `NoopHost` (whose
    /// `app_data_dir()` always errors) would fail path resolution before
    /// ever reaching the slot check, masking the `VaultLocked` case this
    /// module exists to distinguish from `Io`.
    async fn make_temp_vault_with_unlocked_state(
        seed_account_hash: u8,
    ) -> (ScopedTempDir, TestHost, VaultRuntimeState, PathBuf) {
        let tmp = ScopedTempDir::new("cli-bridge-scope-it").expect("scoped tempdir");
        let vault_root = vault_root_for_id_from_base(tmp.path(), test_vault_id());
        std::fs::create_dir_all(&vault_root).expect("mkdir vault root");
        seed_real_vault_meta(&vault_root, seed_account_hash);
        let host = TestHost::with_dirs(tmp.path().to_path_buf(), tmp.path().join("config"));
        let state = VaultRuntimeState::default();
        state
            .set_unlocked(test_vault_id(), fixture_unlocked_with_keys(0x61, 0x62, 1))
            .await;
        (tmp, host, state, vault_root)
    }

    async fn create_note(
        vault_root: &std::path::Path,
        state: &VaultRuntimeState,
        folder: Option<&str>,
        body: &str,
    ) -> String {
        let plaintext = match folder {
            Some(f) => format!("---\nfolder: {f}\n---\n{body}"),
            None => body.to_string(),
        };
        create_note_with_plaintext(vault_root, state, &plaintext).await
    }

    async fn create_note_with_plaintext(
        vault_root: &std::path::Path,
        state: &VaultRuntimeState,
        plaintext: &str,
    ) -> String {
        let notes_dir = notes_dir_under(vault_root).expect("notes dir");
        let plaintext = plaintext.to_string();
        note_create_with_dir(
            notes_dir,
            state,
            plaintext,
            &myne_core::vault_io::StdVaultIo,
            &myne_core::host::NoopHost,
        )
        .await
        .expect("note_create must succeed")
    }

    #[test]
    fn folder_of_reads_frontmatter_folder() {
        assert_eq!(
            folder_of("---\nfolder: Private/\n---\nbody"),
            Some("Private/".to_string())
        );
        assert_eq!(folder_of("no frontmatter here"), None);
        assert_eq!(folder_of("---\ntitle: X\n---\nbody"), None);
    }

    #[test]
    fn an_empty_exclusion_list_leaves_every_live_note_in_scope() {
        rt().block_on(async {
            let (_tmp, host, state, vault_root) = make_temp_vault_with_unlocked_state(0x71).await;
            let id = create_note(&vault_root, &state, Some("Private/"), "secret").await;

            let result = filter_note_ids_by_scope(
                &host,
                &state,
                &myne_core::vault_io::StdVaultIo,
                vec![id.clone()],
            )
            .await
            .expect("filter must succeed");
            assert_eq!(result, vec![id]);
        });
    }

    #[test]
    fn trashed_tombstoned_and_template_notes_are_out_of_scope_with_no_exclusion_list_at_all() {
        // The gap this closes: `note_list_from_host` returns every id in
        // `notes/`, and the trashed/template filter the app applies lives in
        // TS (`loadNoteBatch.ts`) where this socket never reaches. With no
        // liveness rule here, `myne list` enumerates deleted notes and
        // `myne show` prints their plaintext back.
        rt().block_on(async {
            let (_tmp, host, state, vault_root) = make_temp_vault_with_unlocked_state(0x7c).await;
            let trashed = create_note_with_plaintext(
                &vault_root,
                &state,
                "---\ntrashed: 2026-07-29T10:00:00Z\n---\ndeleted secret",
            )
            .await;
            let tombstoned = create_note_with_plaintext(
                &vault_root,
                &state,
                "---\ndeleted: 2026-07-29T10:00:00Z\n---\nsynced away",
            )
            .await;
            let template = create_note_with_plaintext(
                &vault_root,
                &state,
                "---\ntemplate: true\n---\nscaffold",
            )
            .await;
            let live = create_note(&vault_root, &state, None, "an ordinary note").await;

            let result = filter_note_ids_by_scope(
                &host,
                &state,
                &myne_core::vault_io::StdVaultIo,
                vec![
                    trashed.clone(),
                    tombstoned.clone(),
                    template.clone(),
                    live.clone(),
                ],
            )
            .await
            .expect("filter must succeed");
            assert_eq!(result, vec![live], "only the live note stays in scope");
        });
    }

    #[test]
    fn the_liveness_rule_is_value_strict_like_every_other_note_surface() {
        // A user's own non-timestamp `trashed:` / quoted `template: "true"`
        // leaves the note LIVE (markdown-dialect.md §3.6.1's collision
        // mitigation) — the same answer `daily_match::note_matches_daily`
        // gives, because it is literally the same reader family.
        assert!(note_is_not_live(
            "---\ntrashed: 2026-07-29T10:00:00Z\n---\nx"
        ));
        assert!(!note_is_not_live("---\ntrashed: true\n---\nx"));
        assert!(note_is_not_live("---\ntemplate: true\n---\nx"));
        assert!(!note_is_not_live("---\ntemplate: \"true\"\n---\nx"));
        assert!(!note_is_not_live("---\nfolder: Work/\n---\nx"));
        assert!(!note_is_not_live("no frontmatter at all"));
    }

    #[test]
    fn excluded_folder_notes_are_omitted_entirely() {
        rt().block_on(async {
            let (_tmp, host, state, vault_root) = make_temp_vault_with_unlocked_state(0x72).await;
            let hidden = create_note(&vault_root, &state, Some("Private/"), "secret body").await;
            let nested = create_note(
                &vault_root,
                &state,
                Some("Private/Journal/"),
                "nested secret",
            )
            .await;
            let sibling =
                create_note(&vault_root, &state, Some("PrivateStuff/"), "not excluded").await;
            let root = create_note(&vault_root, &state, None, "root note, no folder").await;

            set_cli_excluded_folders_from_host(
                &host,
                &state,
                &noop_hooks(),
                myne_core::plugins::prefs::set_mutation::SetMutation::adding_all(vec![
                    "Private/".to_string()
                ]),
                &myne_core::vault_io::StdVaultIo,
            )
            .await
            .expect("set exclusions must succeed");

            let all_ids = vec![
                hidden.clone(),
                nested.clone(),
                sibling.clone(),
                root.clone(),
            ];
            let mut result =
                filter_note_ids_by_scope(&host, &state, &myne_core::vault_io::StdVaultIo, all_ids)
                    .await
                    .expect("filter must succeed");
            result.sort();

            let mut expected = vec![sibling, root];
            expected.sort();
            assert_eq!(
                result, expected,
                "excluded + nested-excluded omitted with no trace"
            );
        });
    }

    #[test]
    fn nfc_and_case_differing_exclusion_still_filters() {
        rt().block_on(async {
            let (_tmp, host, state, vault_root) = make_temp_vault_with_unlocked_state(0x73).await;
            // Folder stored with a differently-cased, NFD-normalized form.
            let id = create_note(&vault_root, &state, Some("cafe\u{0301}/"), "body").await;

            set_cli_excluded_folders_from_host(
                &host,
                &state,
                &noop_hooks(),
                myne_core::plugins::prefs::set_mutation::SetMutation::adding_all(vec![
                    "Caf\u{00E9}/".to_string(),
                ]),
                &myne_core::vault_io::StdVaultIo,
            )
            .await
            .expect("set exclusions must succeed");

            let result =
                filter_note_ids_by_scope(&host, &state, &myne_core::vault_io::StdVaultIo, vec![id])
                    .await
                    .expect("filter must succeed");
            assert!(
                result.is_empty(),
                "NFC/case-differing exclusion must still match"
            );
        });
    }

    #[test]
    fn vault_locked_mid_scan_surfaces_as_vault_locked() {
        rt().block_on(async {
            let tmp = ScopedTempDir::new("cli-bridge-scope-locked").expect("scoped tempdir");
            let vault_root = vault_root_for_id_from_base(tmp.path(), test_vault_id());
            std::fs::create_dir_all(&vault_root).expect("mkdir vault root");
            seed_real_vault_meta(&vault_root, 0x74);
            let host = TestHost::with_dirs(tmp.path().to_path_buf(), tmp.path().join("config"));
            let state = VaultRuntimeState::default(); // never unlocked

            let result = filter_note_ids_by_scope(
                &host,
                &state,
                &myne_core::vault_io::StdVaultIo,
                vec!["01970e83-4f2f-7000-8000-000000000031".to_string()],
            )
            .await;
            assert_eq!(result, Err(ScopeError::VaultLocked));
        });
    }

    #[test]
    fn note_is_out_of_scope_matches_the_same_predicate() {
        let excluded = vec!["Private/".to_string()];
        assert!(note_is_out_of_scope(
            "---\nfolder: Private/Sub/\n---\nbody",
            &excluded
        ));
        assert!(!note_is_out_of_scope(
            "---\nfolder: Work/\n---\nbody",
            &excluded
        ));
        // A non-canonical `folder:` — what the Obsidian importer preserves
        // verbatim and what a hand-edited note carries — must not escape the
        // same exclusion (`folder_scope::canonical_folder`).
        assert!(note_is_out_of_scope(
            "---\nfolder: Private\n---\nbody",
            &excluded
        ));
        assert!(note_is_out_of_scope(
            "---\nfolder: /Private/Sub\n---\nbody",
            &excluded
        ));
        // Both rules, independently: a trashed note is out of scope even
        // when its folder is not excluded at all.
        assert!(note_is_out_of_scope(
            "---\nfolder: Work/\ntrashed: 2026-07-29T10:00:00Z\n---\nbody",
            &excluded
        ));
        assert!(note_is_out_of_scope(
            "---\ntemplate: true\n---\nbody",
            &[] as &[String]
        ));
    }

    #[test]
    fn body_out_of_scope_from_host_reads_prefs_fresh_and_applies_the_predicate() {
        rt().block_on(async {
            let (_tmp, host, state, _vault_root) = make_temp_vault_with_unlocked_state(0x75).await;

            set_cli_excluded_folders_from_host(
                &host,
                &state,
                &noop_hooks(),
                myne_core::plugins::prefs::set_mutation::SetMutation::adding_all(vec![
                    "Private/".to_string()
                ]),
                &myne_core::vault_io::StdVaultIo,
            )
            .await
            .expect("set exclusions must succeed");

            let excluded = body_out_of_scope_from_host(
                &host,
                &state,
                &myne_core::vault_io::StdVaultIo,
                "---\nfolder: Private/\n---\nsecret",
            )
            .await
            .expect("scope check must succeed");
            assert!(excluded);

            let in_scope = body_out_of_scope_from_host(
                &host,
                &state,
                &myne_core::vault_io::StdVaultIo,
                "---\nfolder: Work/\n---\nnot secret",
            )
            .await
            .expect("scope check must succeed");
            assert!(!in_scope);
        });
    }

    #[test]
    fn body_out_of_scope_from_host_surfaces_vault_locked() {
        rt().block_on(async {
            let tmp = ScopedTempDir::new("cli-bridge-scope-body-locked").expect("scoped tempdir");
            let vault_root = vault_root_for_id_from_base(tmp.path(), test_vault_id());
            std::fs::create_dir_all(&vault_root).expect("mkdir vault root");
            seed_real_vault_meta(&vault_root, 0x76);
            let host = TestHost::with_dirs(tmp.path().to_path_buf(), tmp.path().join("config"));
            let state = VaultRuntimeState::default(); // never unlocked

            let result = body_out_of_scope_from_host(
                &host,
                &state,
                &myne_core::vault_io::StdVaultIo,
                "---\nfolder: Private/\n---\nbody",
            )
            .await;
            assert_eq!(result, Err(ScopeError::VaultLocked));
        });
    }

    #[test]
    fn search_in_scope_vault_locked_when_not_unlocked() {
        rt().block_on(async {
            let tmp = ScopedTempDir::new("cli-bridge-scope-search-locked").expect("scoped tempdir");
            let vault_root = vault_root_for_id_from_base(tmp.path(), test_vault_id());
            std::fs::create_dir_all(&vault_root).expect("mkdir vault root");
            seed_real_vault_meta(&vault_root, 0x77);
            let host = TestHost::with_dirs(tmp.path().to_path_buf(), tmp.path().join("config"));
            let state = VaultRuntimeState::default(); // never unlocked
            let search = SearchIndexState::default();

            let result = search_in_scope(
                &host,
                &state,
                &myne_core::vault_io::StdVaultIo,
                &search,
                "anything",
            )
            .await;
            assert_eq!(result, Err(ScopeError::VaultLocked));
        });
    }

    #[test]
    fn search_in_scope_excludes_hits_in_excluded_folders() {
        rt().block_on(async {
            let (_tmp, host, state, vault_root) = make_temp_vault_with_unlocked_state(0x78).await;
            let hidden_id =
                create_note(&vault_root, &state, Some("Private/"), "kwyjibo term inside").await;
            let visible_id =
                create_note(&vault_root, &state, Some("Work/"), "another note body").await;

            set_cli_excluded_folders_from_host(
                &host,
                &state,
                &noop_hooks(),
                myne_core::plugins::prefs::set_mutation::SetMutation::adding_all(vec![
                    "Private/".to_string()
                ]),
                &myne_core::vault_io::StdVaultIo,
            )
            .await
            .expect("set exclusions must succeed");

            let search = SearchIndexState::default();
            search.upsert(&hidden_id, "Hidden Title", "kwyjibo term inside");
            search.upsert(&visible_id, "Visible Title", "another note body");

            let excluded_hit = search_in_scope(
                &host,
                &state,
                &myne_core::vault_io::StdVaultIo,
                &search,
                "kwyjibo",
            )
            .await
            .expect("search must succeed");
            assert!(
                excluded_hit.is_empty(),
                "excluded hit must be omitted with no trace"
            );

            let visible_hit = search_in_scope(
                &host,
                &state,
                &myne_core::vault_io::StdVaultIo,
                &search,
                "another",
            )
            .await
            .expect("search must succeed");
            assert_eq!(visible_hit, vec![(visible_id, "Visible Title".to_string())]);
        });
    }

    /// The single defect this feature is most exposed on (task 7's own
    /// text): a count is an oracle. Two queries that differ ONLY in whether
    /// they hit an excluded note must be observably identical — not just
    /// "both empty", but the exact same value, so there is no way to build
    /// a side channel out of the difference.
    #[test]
    fn search_in_scope_oracle_excluded_hit_is_indistinguishable_from_a_genuine_miss() {
        rt().block_on(async {
            let (_tmp, host, state, vault_root) = make_temp_vault_with_unlocked_state(0x79).await;
            let hidden_id =
                create_note(&vault_root, &state, Some("Private/"), "quxbazwibble term").await;

            set_cli_excluded_folders_from_host(
                &host,
                &state,
                &noop_hooks(),
                myne_core::plugins::prefs::set_mutation::SetMutation::adding_all(vec![
                    "Private/".to_string()
                ]),
                &myne_core::vault_io::StdVaultIo,
            )
            .await
            .expect("set exclusions must succeed");

            let search = SearchIndexState::default();
            search.upsert(&hidden_id, "Hidden Title", "quxbazwibble term");

            // A query that hits ONLY the excluded note...
            let excluded_hit = search_in_scope(
                &host,
                &state,
                &myne_core::vault_io::StdVaultIo,
                &search,
                "quxbazwibble",
            )
            .await
            .expect("search must succeed");
            // ...versus a query with no match anywhere in the index at all.
            let genuine_miss = search_in_scope(
                &host,
                &state,
                &myne_core::vault_io::StdVaultIo,
                &search,
                "nonexistentquery999",
            )
            .await
            .expect("search must succeed");

            assert_eq!(
                excluded_hit, genuine_miss,
                "an excluded hit must be observably identical to a genuine no-match"
            );
            assert!(excluded_hit.is_empty());
        });
    }

    #[test]
    fn folder_excluded_from_host_reads_prefs_fresh_and_applies_the_predicate() {
        rt().block_on(async {
            let (_tmp, host, state, _vault_root) = make_temp_vault_with_unlocked_state(0x7a).await;

            set_cli_excluded_folders_from_host(
                &host,
                &state,
                &noop_hooks(),
                myne_core::plugins::prefs::set_mutation::SetMutation::adding_all(vec![
                    "Private/".to_string()
                ]),
                &myne_core::vault_io::StdVaultIo,
            )
            .await
            .expect("set exclusions must succeed");

            let excluded = folder_excluded_from_host(
                &host,
                &state,
                &myne_core::vault_io::StdVaultIo,
                Some("Private/"),
            )
            .await
            .expect("scope check must succeed");
            assert!(excluded, "an excluded destination must be refused");

            let nested_excluded = folder_excluded_from_host(
                &host,
                &state,
                &myne_core::vault_io::StdVaultIo,
                Some("Private/Journal/"),
            )
            .await
            .expect("scope check must succeed");
            assert!(nested_excluded, "a nested destination must be refused too");

            let in_scope = folder_excluded_from_host(
                &host,
                &state,
                &myne_core::vault_io::StdVaultIo,
                Some("Work/"),
            )
            .await
            .expect("scope check must succeed");
            assert!(!in_scope);

            let root =
                folder_excluded_from_host(&host, &state, &myne_core::vault_io::StdVaultIo, None)
                    .await
                    .expect("scope check must succeed");
            assert!(!root, "the vault root is never excluded by a real entry");
        });
    }

    #[test]
    fn folder_excluded_from_host_surfaces_vault_locked() {
        rt().block_on(async {
            let tmp = ScopedTempDir::new("cli-bridge-scope-folder-locked").expect("scoped tempdir");
            let vault_root = vault_root_for_id_from_base(tmp.path(), test_vault_id());
            std::fs::create_dir_all(&vault_root).expect("mkdir vault root");
            seed_real_vault_meta(&vault_root, 0x7b);
            let host = TestHost::with_dirs(tmp.path().to_path_buf(), tmp.path().join("config"));
            let state = VaultRuntimeState::default(); // never unlocked

            let result = folder_excluded_from_host(
                &host,
                &state,
                &myne_core::vault_io::StdVaultIo,
                Some("Private/"),
            )
            .await;
            assert_eq!(result, Err(ScopeError::VaultLocked));
        });
    }
}
