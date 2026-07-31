// SPDX-License-Identifier: AGPL-3.0
//! The command router: one IPC name in, one [`Outcome`] out.
//!
//! This is the wasm counterpart of `generate_handler!`. It exists as a `match`
//! rather than a registry map because the arms are not uniform — each command
//! deserializes its own argument struct, and a map of
//! `fn(serde_json::Value) -> Outcome` would erase exactly the type information
//! that makes the arguments checkable at compile time.
//!
//! # What lands here, task by task
//!
//! Three arms so far, and each one crossed a boundary the previous had not:
//! `device_platform` (task 11) proved the path itself, `vault_status` (task 17)
//! the storage seam, and `unlock` (task 12) the first state that outlives its
//! own call. Tasks 13–33 and 40–48 each move their plugin's commands from
//! [`Class::Pending`] into an arm here, which is why `capability.rs` records the
//! owning task per plugin.

use crate::capability::{classify, Class};
use crate::outcome::Outcome;
use myne_core::host::HostCtx;
use myne_core::vault_io::VaultIo;

/// Whether this client can pin a server certificate. It cannot.
///
/// A page never sees the leaf certificate — `decisions.md` 2026-07-26 records
/// that as permanent, and `threat-model.md` qualifies A4 per client. Named here
/// rather than passed as a bare `false` at each call so the two endpoint arms
/// cannot drift apart on it, and so the reason is attached to the value.
const CLIENT_CAN_PIN: bool = false;

// ── the two seam implementations this crate dispatches through ───────────────
//
// Selected by target rather than by a `cfg` on each router arm, so the arms stay
// target-independent and the router is fully exercised by the host-run tests.
//
// The host arms are **not** a second client. `NoopHost` refuses to resolve a
// path, so a host-run command reaches a real `IoError` — which is the correct
// answer for "this crate is being compiled for a target it does not run on", and
// crucially is NOT `NotPorted`. That distinction is what the router-agreement
// test checks.

// `pub(crate)`, like `vault_io` below: the lifecycle hooks need the same answer
// to "which host does this build use", and a second copy there would be a way
// for the two to disagree.
#[cfg(target_arch = "wasm32")]
pub(crate) fn host_ctx() -> &'static dyn HostCtx {
    &crate::host::WebHost
}
#[cfg(not(target_arch = "wasm32"))]
pub(crate) fn host_ctx() -> &'static dyn HostCtx {
    &myne_core::host::NoopHost
}

#[cfg(target_arch = "wasm32")]
pub(crate) fn vault_io() -> &'static dyn VaultIo {
    &crate::opfs::OpfsVaultIo
}
#[cfg(not(target_arch = "wasm32"))]
pub(crate) fn vault_io() -> &'static dyn VaultIo {
    &myne_core::vault_io::StdVaultIo
}

/// Route one command.
///
/// `args` is the raw JSON payload as the page sent it, so a command that takes
/// no arguments simply ignores it — matching Tauri, which also permits an empty
/// or absent payload for a zero-argument command.
#[allow(unused_variables, reason = "not every arm reads the payload")]
pub async fn dispatch(cmd: &str, args: serde_json::Value) -> Outcome {
    match cmd {
        // ── prefs ───────────────────────────────────────────────────────────
        //
        // The one command with no host coupling of any kind: it reads
        // `std::env::consts::OS`, takes no state, does no IO, and is
        // deliberately not `Slot::Unlocked`-gated because the join flow needs it
        // before a vault exists (`core/src/plugins/prefs/commands.rs`).
        //
        // On `wasm32-unknown-unknown` that constant is the EMPTY STRING — not
        // `"unknown"`, which is the natural guess and is wrong (measured in a
        // real browser, task 11's probe run, not assumed). The consequence is
        // already handled rather than surprising: `src/lib/device-name.ts` looks
        // the token up as `sync.devices.platform.<token>` with
        // `sync.devices.platform.unknown` as its fallback key, and an empty
        // token misses the first and lands on the second — "This device".
        // Correct, if bland, and pinned by `tests/web/device-name-web.test.ts`
        // so it cannot silently become the literal key string.
        //
        // Introducing a `"web"` token would be a product change (a new i18n key
        // in 24 catalogues, which Weblate owns) and belongs to the task that
        // ships web enrolment, not here. Recorded so the next agent does not
        // read it as a bug.
        "plugin:prefs|device_platform" => {
            Outcome::ok(&myne_core::plugins::prefs::commands::device_platform_value())
        }

        // ── themes (task 45) ────────────────────────────────────────────────
        //
        // `MYT1` is vault CONTENT — encrypted, synced, backed up — so a web
        // user's themes follow them. Nothing about the blob changes: same
        // magic, same `custom-themes-key` subkey role, same
        // `custom-themes-blob` AAD role, same bytes a desktop wrote.
        //
        // Validation goes through the `theme-validator` crate compiled to wasm,
        // never a TypeScript reimplementation. That crate is the value-shape
        // allowlist and is the injection guard; a second implementation would be
        // a second security boundary to keep in step, and the one that drifts is
        // the one nobody is watching.
        // ── graph layout (task 46) ──────────────────────────────────────────
        //
        // `MYG1` is a REBUILDABLE device-local cache: §9.19.4 says any read
        // failure — absent, AEAD-fail, unsupported, non-UTF-8 — means "recompute
        // the layout", never "the vault is damaged". That property is what makes
        // it safe on a store the browser may evict (task 22): an evicted
        // `vault.graph` costs one force-layout pass, not data.
        //
        // Ported rather than omitted behind a capability flag, which was the
        // task's open question: the assessment marks it `needs-io-seam` with a
        // 2-command surface and no runtime seam, so the port is smaller than the
        // descriptor entry, the UI gating and the "why is my graph forgetting
        // itself" support answer that omitting it would have cost.
        "plugin:graph-layout|graph_layout_read" => {
            use myne_core::plugins::graph_layout::commands::graph_layout_read_from_host;
            match graph_layout_read_from_host(host_ctx(), vault_io(), crate::session::state()).await
            {
                Ok(v) => Outcome::ok(&v),
                Err(e) => Outcome::error(&e),
            }
        }

        "plugin:graph-layout|graph_layout_write" => {
            use myne_core::plugins::graph_layout::commands::graph_layout_write_from_host;
            #[derive(serde::Deserialize)]
            struct Args {
                payload: String,
            }
            let a: Args = match serde_json::from_value(args) {
                Ok(a) => a,
                Err(e) => {
                    return Outcome::BadArgs {
                        command: cmd.to_string(),
                        detail: e.to_string(),
                    }
                }
            };
            match graph_layout_write_from_host(
                host_ctx(),
                vault_io(),
                crate::session::state(),
                a.payload,
            )
            .await
            {
                Ok(()) => Outcome::ok(&()),
                Err(e) => Outcome::error(&e),
            }
        }

        // ── workspace / pane layout (task 65) ───────────────────────────────
        //
        // `MYW1` carries the pane tree: which notes are open, in which split, at
        // which cursor offset. Ported rather than gated because a browser tab is
        // the client that needs it MOST — a desktop window survives a reload of
        // the page inside it, a tab does not, so without this every refresh
        // costs the user their whole layout.
        //
        // **The write cadence is the part to not get clever about.** The blob is
        // written on graceful exit only; staging is RAM. A browser tempts you to
        // "just write it on `visibilitychange`", which is every tab switch —
        // that turns `vault.workspace`'s mtime into a log of when the user was
        // reading, in plaintext metadata next to an encrypted vault. The rule
        // from the 2026-06-01 grill is unchanged here, and `workspace_stage` is
        // what makes keeping it cheap.
        "plugin:workspace|workspace_read" => {
            use myne_core::plugins::workspace::commands::workspace_read_from_host;
            match workspace_read_from_host(host_ctx(), vault_io(), crate::session::state()).await {
                Ok(v) => Outcome::ok(&v),
                Err(e) => Outcome::error(&e),
            }
        }

        "plugin:workspace|workspace_write" => {
            use myne_core::plugins::workspace::commands::workspace_write_from_host;
            #[derive(serde::Deserialize)]
            struct Args {
                descriptor: String,
            }
            let a: Args = match serde_json::from_value(args) {
                Ok(a) => a,
                Err(e) => {
                    return Outcome::BadArgs {
                        command: cmd.to_string(),
                        detail: e.to_string(),
                    }
                }
            };
            match workspace_write_from_host(
                host_ctx(),
                vault_io(),
                crate::session::state(),
                a.descriptor,
            )
            .await
            {
                Ok(()) => Outcome::ok(&()),
                Err(e) => Outcome::error(&e),
            }
        }

        // RAM only, no slot gate, no IO — it is a string until the flush. The
        // desktop command is `async` because Tauri wants it so; here the core's
        // sync `stage_descriptor` is called directly.
        "plugin:workspace|workspace_stage" => {
            #[derive(serde::Deserialize)]
            struct Args {
                descriptor: String,
            }
            let a: Args = match serde_json::from_value(args) {
                Ok(a) => a,
                Err(e) => {
                    return Outcome::BadArgs {
                        command: cmd.to_string(),
                        detail: e.to_string(),
                    }
                }
            };
            myne_core::plugins::workspace::commands::stage_descriptor(a.descriptor);
            Outcome::ok(&())
        }

        // ── attachments (task 44) ───────────────────────────────────────────
        //
        // The plugin's command cores moved onto the storage seam and the host
        // clock, so they run here unchanged: same `MYA1` / `MYC1` bytes, same
        // `AttachmentsCatalogKey` subkey role, same content-addressed ids a
        // desktop wrote.
        //
        // `attachment_import`'s `{ kind: "path" }` source arm cannot arrive
        // here — the picker seam (task 76) hands a browser a `File`, and the web
        // host turns that into `{ kind: "bytes" }` — but the arm is not removed:
        // the payload shape is shared with desktop, and a narrowed enum would be
        // a second definition of the IPC contract. A path that did reach the
        // OPFS store simply reads as absent.
        "plugin:attachments|catalog_list" => {
            use myne_core::plugins::attachments::commands::catalog_list_from_host;
            match catalog_list_from_host(host_ctx(), vault_io(), crate::session::state()).await {
                Ok(rows) => Outcome::ok(&rows),
                Err(e) => Outcome::error(&e),
            }
        }

        "plugin:attachments|attachment_import" => {
            use myne_core::plugins::attachments::commands::{
                attachment_import_from_host, ImportSource,
            };
            #[derive(serde::Deserialize)]
            struct Args {
                source: ImportSource,
            }
            let a: Args = match serde_json::from_value(args) {
                Ok(a) => a,
                Err(e) => {
                    return Outcome::BadArgs {
                        command: cmd.to_string(),
                        detail: e.to_string(),
                    }
                }
            };
            match attachment_import_from_host(
                host_ctx(),
                vault_io(),
                crate::session::state(),
                crate::session::hooks(),
                a.source,
            )
            .await
            {
                Ok(v) => Outcome::ok(&v),
                Err(e) => Outcome::error(&e),
            }
        }

        "plugin:attachments|attachment_delete" => {
            use myne_core::plugins::attachments::commands::attachment_delete_from_host;
            #[derive(serde::Deserialize)]
            struct Args {
                id: String,
            }
            let a: Args = match serde_json::from_value(args) {
                Ok(a) => a,
                Err(e) => {
                    return Outcome::BadArgs {
                        command: cmd.to_string(),
                        detail: e.to_string(),
                    }
                }
            };
            match attachment_delete_from_host(
                host_ctx(),
                vault_io(),
                crate::session::state(),
                crate::session::hooks(),
                a.id,
            )
            .await
            {
                Ok(()) => Outcome::ok(&()),
                Err(e) => Outcome::error(&e),
            }
        }

        "plugin:attachments|attachment_rename" => {
            use myne_core::plugins::attachments::commands::attachment_rename_from_host;
            #[derive(serde::Deserialize)]
            struct Args {
                id: String,
                filename: String,
            }
            let a: Args = match serde_json::from_value(args) {
                Ok(a) => a,
                Err(e) => {
                    return Outcome::BadArgs {
                        command: cmd.to_string(),
                        detail: e.to_string(),
                    }
                }
            };
            match attachment_rename_from_host(
                host_ctx(),
                vault_io(),
                crate::session::state(),
                crate::session::hooks(),
                a.id,
                a.filename,
            )
            .await
            {
                Ok(()) => Outcome::ok(&()),
                Err(e) => Outcome::error(&e),
            }
        }

        "plugin:attachments|attachment_unused_list" => {
            use myne_core::plugins::attachments::commands::attachment_unused_list_from_host;
            match attachment_unused_list_from_host(host_ctx(), vault_io(), crate::session::state())
                .await
            {
                Ok(rows) => Outcome::ok(&rows),
                Err(e) => Outcome::error(&e),
            }
        }

        "plugin:attachments|attachment_clean_unused" => {
            use myne_core::plugins::attachments::commands::attachment_clean_unused_from_host;
            #[derive(serde::Deserialize)]
            struct Args {
                ids: Vec<String>,
            }
            let a: Args = match serde_json::from_value(args) {
                Ok(a) => a,
                Err(e) => {
                    return Outcome::BadArgs {
                        command: cmd.to_string(),
                        detail: e.to_string(),
                    }
                }
            };
            match attachment_clean_unused_from_host(
                host_ctx(),
                vault_io(),
                crate::session::state(),
                crate::session::hooks(),
                a.ids,
            )
            .await
            {
                Ok(v) => Outcome::ok(&v),
                Err(e) => Outcome::error(&e),
            }
        }

        // The browser's counterpart of the desktop `attachment://` protocol
        // handler. It returns a `blob:` URL STRING, not bytes: the outcome
        // envelope is JSON, and a 64 MiB attachment would base64 to ~85 MiB of
        // string per render. The `Blob` is minted next to the plaintext that
        // produced it and cached by id, so a re-render reuses one object rather
        // than leaking one per paint; `plugin:vault-unlock|lock` revokes them
        // all.
        //
        // Not a Tauri command name — there is no desktop twin, because desktop
        // resolves the same need through a URI scheme. It is reached through
        // `web/src/platform/core.ts`'s `convertFileSrc`, which is the seam
        // member the shared `EditorHost.attachments.resolveRef` calls.
        "plugin:attachments|attachment_object_url" => {
            use myne_core::plugins::attachments::commands::attachment_serve_from_host;
            #[derive(serde::Deserialize)]
            struct Args {
                id: String,
            }
            let a: Args = match serde_json::from_value(args) {
                Ok(a) => a,
                Err(e) => {
                    return Outcome::BadArgs {
                        command: cmd.to_string(),
                        detail: e.to_string(),
                    }
                }
            };
            // The cache is consulted BEFORE the decrypt: a cache hit means this
            // session already holds a `Blob` for these exact bytes, so decrypting
            // again would produce a second copy of the same plaintext for nothing.
            if let Some(url) = crate::attachment_url::cached(&a.id) {
                return Outcome::ok(&url);
            }
            match attachment_serve_from_host(host_ctx(), vault_io(), crate::session::state(), &a.id)
                .await
            {
                Ok(served) => {
                    let url =
                        crate::attachment_url::mint(&a.id, served.content_type, &served.bytes);
                    Outcome::ok(&url)
                }
                Err(e) => Outcome::error(&e),
            }
        }

        "plugin:themes|themes_list" => {
            use myne_core::plugins::themes::commands::themes_list_from_host;
            match themes_list_from_host(host_ctx(), vault_io(), crate::session::state()).await {
                Ok(v) => Outcome::ok(&v),
                Err(e) => Outcome::error(&e),
            }
        }

        "plugin:themes|themes_read" | "plugin:themes|themes_export" => {
            // One arm for both: `themes_export` IS the read core byte-for-byte
            // (`commands.rs` says so) — the separately-grantable permission is
            // what differs, and that lives at the desktop ACL, which a browser
            // does not have. Splitting them here would imply a second code path
            // that does not exist.
            use myne_core::plugins::themes::commands::themes_read_from_host;
            #[derive(serde::Deserialize)]
            #[serde(rename_all = "camelCase")]
            struct Args {
                name: String,
            }
            let a: Args = match serde_json::from_value(args) {
                Ok(a) => a,
                Err(e) => {
                    return Outcome::BadArgs {
                        command: cmd.to_string(),
                        detail: e.to_string(),
                    }
                }
            };
            match themes_read_from_host(host_ctx(), vault_io(), crate::session::state(), a.name)
                .await
            {
                Ok(v) => Outcome::ok(&v),
                Err(e) => Outcome::error(&e),
            }
        }

        "plugin:themes|themes_import" => {
            use myne_core::plugins::themes::commands::themes_import_from_host;
            #[derive(serde::Deserialize)]
            #[serde(rename_all = "camelCase")]
            struct Args {
                name: String,
                palette_json: String,
            }
            let a: Args = match serde_json::from_value(args) {
                Ok(a) => a,
                Err(e) => {
                    return Outcome::BadArgs {
                        command: cmd.to_string(),
                        detail: e.to_string(),
                    }
                }
            };
            match themes_import_from_host(
                host_ctx(),
                vault_io(),
                crate::session::state(),
                a.name,
                a.palette_json,
            )
            .await
            {
                Ok(()) => Outcome::ok(&()),
                Err(e) => Outcome::error(&e),
            }
        }

        "plugin:themes|themes_delete" => {
            use myne_core::plugins::themes::commands::themes_delete_from_host;
            #[derive(serde::Deserialize)]
            #[serde(rename_all = "camelCase")]
            struct Args {
                name: String,
            }
            let a: Args = match serde_json::from_value(args) {
                Ok(a) => a,
                Err(e) => {
                    return Outcome::BadArgs {
                        command: cmd.to_string(),
                        detail: e.to_string(),
                    }
                }
            };
            match themes_delete_from_host(host_ctx(), vault_io(), crate::session::state(), a.name)
                .await
            {
                Ok(()) => Outcome::ok(&()),
                Err(e) => Outcome::error(&e),
            }
        }

        // ── vault-unlock ────────────────────────────────────────────────────
        //
        // The first command that touches storage (task 17). Read-only, no keys,
        // no derivation, no unlock precondition — and it is what the shared UI
        // calls at boot (`src/lib/vault-status.ts`), so a browser reporting
        // `Exists` after a reload is a real end-to-end persistence proof rather
        // than a synthetic one.
        //
        // Both seams are constructed here rather than held in a global: they are
        // unit structs, so there is nothing to cache, and passing them per call
        // keeps the wasm entry surface stateless. State that must outlive a call
        // (the unlocked vault's keys) arrives with task 12, and it will be
        // explicit rather than ambient for exactly the reason `HostCtx` keeps
        // state out of itself (`core-hostctx-design.md`).
        //
        // The ARM is not cfg-gated; only its two implementations are. Gating the
        // arm would have made the host build fall through to `NotPorted`, and
        // `dispatched_names_match_the_router` — the test that keeps the
        // capability table honest — runs on the host. A wasm-only arm is a
        // routing decision no gate in `pre-push` can see.
        // A LOCAL well-formedness check of a typed account number
        // (phase3-web-client task 30). No IO, no state, no network — which is
        // the point: the web client's first-run identity step must reject a typo
        // without asking a server, and every other caller of
        // `parse_account_number` in this codebase sits inside a device-enrolment
        // round trip.
        //
        // One bit out, deliberately (`account-number.md` §5): the caller learns
        // "not valid", never which character failed.
        // Locking, and therefore ZEROIZING (task 43). Taking the slot drops the
        // `Zeroizing<[u8; 32]>` wrappers around `root_key` and `items_key`, so
        // the keys are wiped by the same code path desktop uses — there is no
        // web-specific zeroize to get wrong.
        //
        // Ported here rather than with the rest of `vault-unlock` because the
        // web idle timer (`useIdleAutoLock`) has nothing to call otherwise: a
        // lock that only routed the UI would leave the keys live in this Worker
        // while the page showed the unlock screen.
        "plugin:vault-unlock|lock" => {
            use myne_core::plugins::vault_unlock::commands::lock_from_host;
            let outcome =
                match lock_from_host(crate::session::state(), crate::session::hooks()).await {
                    Ok(()) => Outcome::ok(&()),
                    Err(e) => Outcome::error(&e),
                };
            // Revoke every attachment object URL this session minted (task 44).
            //
            // This is not tidy-up: an object URL is a GC ROOT for its `Blob`, so
            // an unrevoked one is decrypted plaintext pinned in memory for the
            // life of the page — precisely what locking exists to end. It runs
            // AFTER the slot drop and UNCONDITIONALLY, including on the error
            // arm: a lock that failed for some other reason must not leave the
            // decrypted bytes behind, and revocation cannot fail.
            crate::attachment_url::revoke_all();
            outcome
        }

        // Erase this browser's copy (task 72). The command name, its payload and
        // its error taxonomy are the desktop's, unchanged — what differs is what
        // it MEANS here, and that difference lives in the UI rather than in the
        // dispatcher: the web client's OPFS container is a cache of a sync-held
        // vault, so this is a sign-out that takes the local copy with it. The
        // account, and everything already synced, are on the server and are not
        // touched by anything below. There is no remote-wipe call here and there
        // must never be one added under this name.
        //
        // The attachment object URLs are revoked exactly as on `lock`, and for a
        // stronger reason: each one pins decrypted plaintext in the page, and the
        // vault they came from is about to stop existing locally.
        "plugin:vault-delete|vault_delete" => {
            use myne_core::plugins::vault_delete::commands::vault_delete_via_io_from_host;
            #[derive(serde::Deserialize)]
            #[serde(rename_all = "camelCase")]
            struct Args {
                #[serde(default)]
                vault_id: Option<String>,
            }
            let a: Args = match serde_json::from_value(args) {
                Ok(a) => a,
                Err(e) => {
                    return Outcome::BadArgs {
                        command: cmd.to_string(),
                        detail: e.to_string(),
                    }
                }
            };
            let outcome = match vault_delete_via_io_from_host(
                crate::session::state(),
                crate::session::hooks(),
                host_ctx(),
                vault_io(),
                a.vault_id,
            )
            .await
            {
                Ok(()) => Outcome::ok(&()),
                Err(e) => Outcome::error(&e),
            };
            crate::attachment_url::revoke_all();
            outcome
        }

        "plugin:vault-unlock|account_number_check" => {
            use myne_core::plugins::vault_unlock::commands::account_number_is_valid;
            #[derive(serde::Deserialize)]
            #[serde(rename_all = "camelCase")]
            struct Args {
                account_number: String,
            }
            let a: Args = match serde_json::from_value(args) {
                Ok(a) => a,
                Err(e) => {
                    return Outcome::BadArgs {
                        command: cmd.to_string(),
                        detail: e.to_string(),
                    }
                }
            };
            Outcome::ok(&account_number_is_valid(&a.account_number))
        }

        "plugin:vault-unlock|vault_status" => {
            use myne_core::plugins::vault_unlock::commands::vault_status_from_host;
            match vault_status_from_host(host_ctx(), vault_io()).await {
                Ok(status) => Outcome::ok(&status),
                Err(e) => Outcome::error(&e),
            }
        }

        // The Editor's mount-time reality check (`src/CLAUDE.md`, the Q5β-1
        // belt-and-suspenders guard): React's Stage machine says `editor`, and
        // this asks the Rust side whether the slot is actually populated. It
        // has to be answered rather than left unported — the guard treats an
        // IPC REJECTION as "slot empty" and fail-closes, so an unported command
        // does not degrade the editor, it replaces it with "Unexpected state.
        // Please restart."
        //
        // That is exactly what shipped: a browser could enrol, be approved,
        // unlock (SCRAM 200, `sync/pull` 200, the SSE stream open — the whole
        // session working) and then land on the dead-end error screen, because
        // the LAST call in the chain had no arm here. Every automated check was
        // green: the command surface gate reads `capability.rs`, and this
        // command was missing from BOTH files, so the two agreed with each
        // other about a command neither knew existed. Found by signing in.
        "plugin:vault-unlock|vault_is_unlocked" => {
            use myne_core::plugins::vault_unlock::commands::vault_is_unlocked_from_host;
            match vault_is_unlocked_from_host(crate::session::state()).await {
                Ok(unlocked) => Outcome::ok(&unlocked),
                Err(e) => Outcome::error(&e),
            }
        }

        // Task 22. The BOOT probe above cannot express the condition this client
        // exists to survive: the browser evicting the origin's storage while a
        // session is live. Whole-body shared — nothing here is browser-specific
        // (a desktop directory can vanish too); what differs is the remedy, and
        // this reports the condition without naming one.
        "plugin:vault-unlock|vault_storage_health" => {
            use myne_core::plugins::vault_unlock::storage_health::probe_storage_health;
            Outcome::ok(
                &probe_storage_health(host_ctx(), vault_io(), crate::session::state()).await,
            )
        }

        // The first command that produces state outliving the call — the
        // unwrapped `root_key` and `items_key`, held in `crate::session`.
        //
        // Argon2id at `m=256 MiB, t=3, p=2` runs here, which is the whole reason
        // the Worker exists: measured at 464 ms (Chrome) / 558 (Safari) / 680
        // (Firefox) against 412 ms native (`protocol.md` §4.1). On the main
        // thread that would freeze the unlock screen for half a second; here the
        // page keeps painting.
        //
        // Parameters come from `vault.meta` and are AAD-bound (§4.3), so they
        // are neither hardcoded nor lowerable for a browser — a downgrade
        // invalidates the tag on both wrapped root-key copies.
        "plugin:vault-unlock|unlock" => {
            use myne_core::plugins::vault_unlock::commands::unlock_from_host;
            #[derive(serde::Deserialize)]
            #[serde(rename_all = "camelCase")]
            struct Args {
                // Optional, matching the desktop command: `None` is the
                // sole-vault fallback.
                #[serde(default)]
                vault_id: Option<String>,
                password: String,
            }
            // `BadArgs` rather than a panic: a malformed payload is a caller
            // bug, and a panic here would trap the instance permanently.
            let args: Args = match serde_json::from_value(args) {
                Ok(a) => a,
                Err(e) => {
                    return Outcome::BadArgs {
                        command: cmd.to_string(),
                        detail: e.to_string(),
                    }
                }
            };
            match unlock_from_host(
                args.vault_id,
                args.password,
                crate::session::state(),
                crate::session::hooks(),
                host_ctx(),
                vault_io(),
            )
            .await
            {
                Ok(()) => Outcome::ok(&()),
                Err(e) => Outcome::error(&e),
            }
        }

        // ── notes: the read path (task 13) ──────────────────────────────────
        //
        // Read-only, so no `atomic_write` and no `note_txn` WAL — the write path
        // is a separate unit, for the reason recorded on the task: the seam's
        // closed 4-variant error vocabulary cannot express `AlreadyExists`,
        // which `note_create` uses as its UUIDv7-collision canary.
        //
        // All three hold the slot read guard across their IO, exactly as on
        // desktop, so a concurrent lock waits for an in-flight decrypt rather
        // than racing it.
        "plugin:notes|note_list" => {
            use myne_core::plugins::notes::commands::note_list_from_host;
            match note_list_from_host(host_ctx(), crate::session::state(), vault_io()).await {
                Ok(ids) => Outcome::ok(
                    &ids.iter()
                        .map(|i| i.as_uuid().to_string())
                        .collect::<Vec<_>>(),
                ),
                Err(e) => Outcome::error(&e),
            }
        }

        "plugin:notes|note_read" => {
            use myne_core::plugins::notes::commands::note_read_from_host;
            #[derive(serde::Deserialize)]
            #[serde(rename_all = "camelCase")]
            struct Args {
                note_id: String,
            }
            let a: Args = match serde_json::from_value(args) {
                Ok(a) => a,
                Err(e) => {
                    return Outcome::BadArgs {
                        command: cmd.to_string(),
                        detail: e.to_string(),
                    }
                }
            };
            match note_read_from_host(host_ctx(), crate::session::state(), a.note_id, vault_io())
                .await
            {
                Ok(plaintext) => Outcome::ok(&plaintext),
                Err(e) => Outcome::error(&e),
            }
        }

        "plugin:notes|note_titles_batch" => {
            use myne_core::plugins::notes::commands::note_titles_batch_from_host;
            #[derive(serde::Deserialize)]
            #[serde(rename_all = "camelCase")]
            struct Args {
                ids: Vec<String>,
            }
            let a: Args = match serde_json::from_value(args) {
                Ok(a) => a,
                Err(e) => {
                    return Outcome::BadArgs {
                        command: cmd.to_string(),
                        detail: e.to_string(),
                    }
                }
            };
            match note_titles_batch_from_host(
                host_ctx(),
                crate::session::state(),
                a.ids,
                vault_io(),
            )
            .await
            {
                // Per-item `Result`s cross verbatim — the shared UI already
                // renders a failed row differently from a failed batch, and
                // collapsing them here would lose that.
                Ok(slices) => Outcome::ok(&slices),
                Err(e) => Outcome::error(&e),
            }
        }

        // ── notes: the write path (task 13) ─────────────────────────────────
        //
        // This block once carried a note saying `note_update` and
        // `note_write_batch_transactional` were held back — the first for a wall
        // clock inside its blocking closure, the second because `note_txn.rs`'s
        // rename WAL rests on `File::open(parent).sync_all()`, which OPFS has no
        // counterpart for. **Both questions have since been answered elsewhere,
        // and the note outlived them**, which is its own small lesson: a comment
        // recording a blocker has to be deleted by whoever unblocks it, and the
        // person who unblocks it is usually working in a different file.
        //
        // The clock became `HostCtx::now_unix_millis` in task 12 — a WALL clock
        // deliberately, since the snapshot-coalescing gate compares against a
        // timestamp persisted in a previous session, which no per-process
        // monotonic reading can be compared to.
        //
        // The WAL is durable on OPFS **without** a parent fsync, because task 86
        // changed what it relies on. Publish is write-then-remove rather than
        // rename, so a crash mid-publish leaves the temp AND a destination that
        // is either old or new — which the roll-forward marker already covers,
        // idempotently. The marker itself is a content-free PRESENCE signal: the
        // weakest thing a store can get wrong, whose only failure mode is "not
        // there", which recovery treats as roll-BACK, and at that point every
        // live `.myn` is still the pre-transaction one. On the web store the
        // destination is a `SingleLive` container, so each publish also lands in
        // the non-live slot and retires the old one — the per-blob crash
        // property comes free on top of the journal's.
        "plugin:notes|note_create" => {
            use myne_core::plugins::notes::commands::note_create_from_host;
            #[derive(serde::Deserialize)]
            #[serde(rename_all = "camelCase")]
            struct Args {
                plaintext: String,
            }
            let a: Args = match serde_json::from_value(args) {
                Ok(a) => a,
                Err(e) => {
                    return Outcome::BadArgs {
                        command: cmd.to_string(),
                        detail: e.to_string(),
                    }
                }
            };
            match note_create_from_host(
                host_ctx(),
                crate::session::state(),
                crate::session::hooks(),
                a.plaintext,
                vault_io(),
            )
            .await
            {
                Ok(id) => Outcome::ok(&id),
                Err(e) => Outcome::error(&e),
            }
        }

        "plugin:notes|note_update" => {
            use myne_core::plugins::notes::commands::note_update_from_host;
            #[derive(serde::Deserialize)]
            #[serde(rename_all = "camelCase")]
            struct Args {
                note_id: String,
                plaintext: String,
                // The §11.3 expected-base guard. `None` is legacy
                // last-write-wins; `Some` rejects the write when a sync
                // pull-apply advanced the note under the editor. Optional here
                // exactly as in the desktop command — the shared UI decides.
                #[serde(default)]
                expected_base_hash_hex: Option<String>,
            }
            let a: Args = match serde_json::from_value(args) {
                Ok(a) => a,
                Err(e) => {
                    return Outcome::BadArgs {
                        command: cmd.to_string(),
                        detail: e.to_string(),
                    }
                }
            };
            match note_update_from_host(
                host_ctx(),
                crate::session::state(),
                crate::session::hooks(),
                a.note_id,
                a.plaintext,
                a.expected_base_hash_hex,
                vault_io(),
            )
            .await
            {
                Ok(()) => Outcome::ok(&()),
                Err(e) => Outcome::error(&e),
            }
        }

        // §8.3 / WL-7: a title rename rewrites the renamed note's own body PLUS
        // every inbound `[[…]]`-bearing note, and the whole set must land
        // together — a partial commit leaves an un-rewritten `[[Old Title]]`
        // resolving to no note, which is a broken link rather than a stale one.
        // The query door for the index tasks 14 + 83 populate. Gated on
        // `Slot::Unlocked` inside the core and answering an EMPTY list when it is
        // not — a locked vault has nothing to say about its contents, and an
        // index not yet zeroized must not answer through this door.
        //
        // `attachment_id` is always `None` here, structurally: this client's
        // index carries no `att:` documents because the `MYE1` producer that
        // builds them does not exist on `wasm32`.
        "plugin:notes|note_search" => {
            use myne_core::plugins::notes::search_sync_core::note_search_core;
            #[derive(serde::Deserialize)]
            #[serde(rename_all = "camelCase")]
            struct Args {
                query: String,
            }
            let a: Args = match serde_json::from_value(args) {
                Ok(a) => a,
                Err(e) => {
                    return Outcome::BadArgs {
                        command: cmd.to_string(),
                        detail: e.to_string(),
                    }
                }
            };
            let hits =
                note_search_core(crate::session::state(), crate::session::search(), &a.query).await;
            Outcome::ok(&hits)
        }

        "plugin:notes|note_write_batch_transactional" => {
            use myne_core::plugins::notes::commands::{
                note_write_batch_transactional_from_host, NoteBatchUpdate,
            };
            #[derive(serde::Deserialize)]
            #[serde(rename_all = "camelCase")]
            struct Args {
                notes: Vec<NoteBatchUpdate>,
            }
            let a: Args = match serde_json::from_value(args) {
                Ok(a) => a,
                Err(e) => {
                    return Outcome::BadArgs {
                        command: cmd.to_string(),
                        detail: e.to_string(),
                    }
                }
            };
            match note_write_batch_transactional_from_host(
                host_ctx(),
                vault_io(),
                crate::session::state(),
                crate::session::hooks(),
                a.notes,
            )
            .await
            {
                Ok(()) => Outcome::ok(&()),
                Err(e) => Outcome::error(&e),
            }
        }

        "plugin:notes|note_delete" => {
            use myne_core::plugins::notes::commands::note_delete_from_host;
            #[derive(serde::Deserialize)]
            #[serde(rename_all = "camelCase")]
            struct Args {
                note_id: String,
            }
            let a: Args = match serde_json::from_value(args) {
                Ok(a) => a,
                Err(e) => {
                    return Outcome::BadArgs {
                        command: cmd.to_string(),
                        detail: e.to_string(),
                    }
                }
            };
            match note_delete_from_host(
                host_ctx(),
                crate::session::state(),
                crate::session::hooks(),
                a.note_id,
                vault_io(),
            )
            .await
            {
                Ok(()) => Outcome::ok(&()),
                Err(e) => Outcome::error(&e),
            }
        }

        // ── vault-indices (task 14) ─────────────────────────────────────────
        //
        // Twelve of the fourteen commands are pure in-RAM queries over
        // `VaultIndicesState` — no host, no IO, no clock — so they port by being
        // dispatched. `persist` and `hydrate` are the two that touch storage and
        // take the seam.
        "plugin:vault-indices|vault_indices_all_edges" => {
            use myne_core::plugins::vault_indices::commands::vault_indices_all_edges_from_host;
            match vault_indices_all_edges_from_host(
                crate::session::state(),
                crate::session::indices(),
            )
            .await
            {
                Ok(v) => Outcome::ok(&v),
                Err(e) => Outcome::error(&e),
            }
        }

        "plugin:vault-indices|vault_indices_orphans" => {
            use myne_core::plugins::vault_indices::commands::vault_indices_orphans_from_host;
            match vault_indices_orphans_from_host(
                crate::session::state(),
                crate::session::indices(),
            )
            .await
            {
                Ok(v) => Outcome::ok(&v),
                Err(e) => Outcome::error(&e),
            }
        }

        "plugin:vault-indices|vault_indices_tag_tree" => {
            use myne_core::plugins::vault_indices::commands::vault_indices_tag_tree_from_host;
            match vault_indices_tag_tree_from_host(
                crate::session::state(),
                crate::session::indices(),
            )
            .await
            {
                Ok(v) => Outcome::ok(&v),
                Err(e) => Outcome::error(&e),
            }
        }

        "plugin:vault-indices|vault_indices_property_keys" => {
            use myne_core::plugins::vault_indices::commands::vault_indices_property_keys_from_host;
            match vault_indices_property_keys_from_host(
                crate::session::state(),
                crate::session::indices(),
            )
            .await
            {
                Ok(v) => Outcome::ok(&v),
                Err(e) => Outcome::error(&e),
            }
        }

        "plugin:vault-indices|vault_indices_persist" => {
            use myne_core::plugins::vault_indices::commands::vault_indices_persist_from_host;
            match vault_indices_persist_from_host(
                host_ctx(),
                crate::session::state(),
                crate::session::indices(),
                vault_io(),
            )
            .await
            {
                Ok(()) => Outcome::ok(&()),
                Err(e) => Outcome::error(&e),
            }
        }

        "plugin:vault-indices|vault_indices_hydrate" => {
            use myne_core::plugins::vault_indices::commands::vault_indices_hydrate_from_host;
            match vault_indices_hydrate_from_host(
                host_ctx(),
                crate::session::state(),
                crate::session::indices(),
                vault_io(),
            )
            .await
            {
                Ok(stale) => Outcome::ok(&stale),
                Err(e) => Outcome::error(&e),
            }
        }

        // ── prefs (task 14) ─────────────────────────────────────────────────
        //
        // `prefs_read` and two representative setters. The remaining ~43 setters
        // are the same three-line shape over a different field; they land with
        // the settings UI that calls them rather than being pre-wired blind.
        //
        // The write path is the one that mattered: its §10.2 last-write-wins
        // field clock was `SystemTime::now()`, which PANICS on wasm32 — so the
        // entire `set_*` surface would have aborted the instance the first time
        // a user changed a setting. It reads `HostCtx::now_unix_millis` now.
        // ── sync: the endpoint config ───────────────────────────────────────
        //
        // The first two sync commands the browser can answer (task 84). They are
        // the whole data plane's precondition — nothing else in the plugin has
        // anywhere to talk to until an endpoint is configured — and they are the
        // two whose cores had no target-independent home until this pass moved
        // them out of the host-gated `commands.rs` into `config.rs`.
        //
        // `CLIENT_CAN_PIN` is `false` here, and that is a decision rather than a
        // gap: a page never sees a leaf certificate, so it cannot TOFU-pin one.
        // What it reports instead is `PinSource::PlatformTrustStore` — "verified,
        // by the browser" — because the alternative answer (`None`, meaning no
        // pin) renders in the shared UI as "connected to a local server", which
        // would be a false statement about a real `https://` endpoint.
        "plugin:sync|sync_get_endpoint" => {
            match myne_core::plugins::sync::config::get_endpoint_view(
                host_ctx(),
                vault_io(),
                CLIENT_CAN_PIN,
            )
            .await
            {
                Ok(v) => Outcome::ok(&v),
                Err(e) => Outcome::error(&e),
            }
        }

        "plugin:sync|sync_set_endpoint" => {
            #[derive(serde::Deserialize)]
            #[serde(rename_all = "camelCase")]
            struct Args {
                endpoint_url: Option<String>,
            }
            let a: Args = match serde_json::from_value(args) {
                Ok(a) => a,
                Err(e) => {
                    return Outcome::BadArgs {
                        command: cmd.to_string(),
                        detail: e.to_string(),
                    }
                }
            };
            // `cert_pin_hex: None` — not a placeholder. The desktop wrapper
            // passes a pin it fetched over raw TLS; this client has no way to
            // fetch one and no way to check one, so it passes none and lets the
            // core report who did the verifying.
            match myne_core::plugins::sync::config::set_endpoint(
                host_ctx(),
                vault_io(),
                a.endpoint_url,
                None,
                CLIENT_CAN_PIN,
            )
            .await
            {
                Ok(v) => Outcome::ok(&v),
                Err(e) => Outcome::error(&e),
            }
        }

        // The status indicator. Read-only, no transport, no keys — it derives
        // from the endpoint config, the device-local token, the persisted
        // identity and the conflict staging dir, all of which this client can
        // already read.
        //
        // `live: None` is not a stub with a shrug: the overlay's producer is the
        // background loop, and the browser has no loop yet (the tick driver
        // waits on the cycle). What the user sees until then is the honest base
        // state — `Disabled` / `NotEnrolled` / `Pending` / `Idle` — never a
        // fabricated "Syncing".
        "plugin:sync|sync_status" => {
            match myne_core::plugins::sync::status::read_status(
                host_ctx(),
                vault_io(),
                crate::session::state(),
                None,
            )
            .await
            {
                Ok(v) => Outcome::ok(&v),
                Err(e) => Outcome::error(&e),
            }
        }

        // Task 39. The readout that makes a multi-second first sync legible.
        // Whole-body shared and host-independent — three atomic loads — which is
        // why it can be polled on a short beat while thousands of notes land.
        "plugin:sync|sync_materialisation_progress" => {
            Outcome::ok(&myne_core::plugins::sync::progress::read())
        }

        // Tasks 41 + 88. The one credential-management action that stays on web,
        // because the password is already typed into the page at every unlock and
        // adds no new exposure.
        //
        // **Gated on a server acknowledgement, and that gate is the task.** The
        // local rewrite is the same shared core desktop runs; what differs is what
        // counts as done. On desktop a best-effort push that fails leaves a
        // `vault.meta-dirty` marker and a later cycle carries it — durable storage,
        // legitimate deferral. On web that marker and `meta_baseline_hex` both
        // live in the evictable OPFS container, so losing them turns a deferred
        // push into a SILENT REVERT: the meta phase adopts the server's older copy
        // and the new password stops working (task 88's whole argument; the
        // refusal side of it is `MetaPhaseOutcome::CredentialAmbiguous`).
        //
        // So: rewrite, then push, and report `ServerAckPending` when the push does
        // not land. Deliberately NOT an `Err` that implies the change failed —
        // the new password works on this device right now, and copy that said
        // otherwise would send the user to change it again.
        "plugin:vault-change-password|change_password" => {
            use myne_core::plugins::vault_change_password::commands::change_password_from_host;
            #[derive(serde::Deserialize)]
            #[serde(rename_all = "camelCase")]
            struct Args {
                current_password: String,
                new_password: String,
            }
            let a: Args = match serde_json::from_value(args) {
                Ok(v) => v,
                Err(e) => {
                    return Outcome::BadArgs {
                        command: cmd.to_string(),
                        detail: e.to_string(),
                    }
                }
            };
            match change_password_from_host(
                a.current_password,
                a.new_password,
                crate::session::state(),
                crate::session::hooks(),
                host_ctx(),
            )
            .await
            {
                Ok(()) => {
                    // The push is a SEPARATE step here, not folded into the core:
                    // the core's own post-change push is host-gated precisely so
                    // this arm can decide what an unacknowledged push means,
                    // rather than the core silently skipping it.
                    let acked = myne_core::plugins::sync::cycle::push_vault_meta_now_via_io(
                        host_ctx(),
                        vault_io(),
                        crate::session::state(),
                    )
                    .await;
                    if acked {
                        Outcome::ok(&serde_json::Value::Null)
                    } else {
                        Outcome::error(
                            &myne_core::plugins::vault_change_password::error::VaultChangePasswordError::ServerAckPending,
                        )
                    }
                }
                Err(e) => Outcome::error(&e),
            }
        }

        // Task 23. Whole-body shared, because unlike `sync_status` it has no
        // host-shaped input to leave behind — no live-status cell, no
        // `Manager::try_state`. The browser is the client that needs it most:
        // its local copy is an OPFS cache the browser may evict without asking,
        // so an edit the server has not acknowledged is the one thing between
        // the user and real loss.
        "plugin:sync|sync_unsynced_edits" => {
            match myne_core::plugins::sync::unsynced::read_unsynced(
                host_ctx(),
                vault_io(),
                crate::session::state(),
            )
            .await
            {
                Ok(v) => Outcome::ok(&v),
                Err(e) => Outcome::error(&e),
            }
        }

        // ── sync: the device roster + account projection ────────────────────
        //
        // Four commands that share one precondition and no `root_key`: device
        // management is TOKEN-authed, so `authed_transport_from_host` is the
        // whole of what they needed from the host, and porting it ported them as
        // a group. This is also task 33's client half — a browser can now see the
        // roster it must appear in, and approve from a desktop shows up here.
        //
        // The blocking request goes through `crate::task::run_blocking`, which
        // is `spawn_blocking` natively and INLINE on wasm. Inline is correct
        // here rather than a compromise: the browser transport is synchronous
        // XHR in a dedicated Worker by decision (task 35), so blocking this
        // thread is the design, not an accident.
        "plugin:sync|sync_list_devices" => {
            match myne_core::plugins::sync::devices::list_devices_from_host(
                host_ctx(),
                vault_io(),
                crate::session::state(),
            )
            .await
            {
                Ok(v) => Outcome::ok(&v),
                Err(e) => Outcome::error(&e),
            }
        }

        "plugin:sync|sync_approve_device" | "plugin:sync|sync_remove_device" => {
            #[derive(serde::Deserialize)]
            #[serde(rename_all = "camelCase")]
            struct Args {
                device_id_hex: String,
            }
            let a: Args = match serde_json::from_value(args) {
                Ok(a) => a,
                Err(e) => {
                    return Outcome::BadArgs {
                        command: cmd.to_string(),
                        detail: e.to_string(),
                    }
                }
            };
            // One arm, two commands, and the branch is on the NAME rather than
            // the two arms being written out: their argument shape and error
            // type are identical, so a split would duplicate the deserialize and
            // invite the two copies to drift.
            let approve = cmd.ends_with("approve_device");
            let host = host_ctx();
            let io = vault_io();
            let state = crate::session::state();
            let r = if approve {
                myne_core::plugins::sync::devices::approve_device_from_host(
                    host,
                    io,
                    state,
                    &a.device_id_hex,
                )
                .await
            } else {
                myne_core::plugins::sync::devices::remove_device_from_host(
                    host,
                    io,
                    state,
                    &a.device_id_hex,
                )
                .await
            };
            match r {
                Ok(()) => Outcome::ok(&()),
                Err(e) => Outcome::error(&e),
            }
        }

        "plugin:sync|sync_account_status" => {
            match myne_core::plugins::sync::devices::account_status_from_host(
                host_ctx(),
                vault_io(),
                crate::session::state(),
            )
            .await
            {
                Ok(v) => Outcome::ok(&v),
                Err(e) => Outcome::error(&e),
            }
        }

        // ── sync: one cycle, on demand ──────────────────────────────────────
        //
        // The data plane itself. Everything before this pass was a precondition
        // for it — the endpoint, the token, the status — and this is the command
        // that actually pulls and pushes ciphertext.
        //
        // It looks small here because the whole gather, the process-wide
        // serializer and the four event emits are shared: see
        // `myne_core::plugins::sync::cycle`. The one genuinely per-target thing
        // is HOW the cycle is driven, and that lives behind
        // `task::run_blocking_future` — `spawn_blocking` + `block_on` natively so
        // a tokio worker is not parked on a 60 s round trip, and a plain `await`
        // here, where blocking this Worker is the design.
        //
        // No background loop yet, so this is the browser's only way to sync —
        // which makes the honest `NotEnrolled`-not-`Idle` mapping in the core
        // matter more, not less: a user clicking "Sync now" on an unenrolled
        // browser must not see the dot go green.
        "plugin:sync|sync_now" => {
            let status = myne_core::plugins::sync::cycle::sync_now_from_host(
                host_ctx(),
                vault_io(),
                crate::session::state(),
            )
            .await;
            Outcome::ok(&status)
        }

        // ── the pending-approval wait's two halves (MYND-635) ────────────────
        //
        // Both are called by `AccountBootstrap`, the WEB-ONLY entry screen, and
        // neither was dispatched — so the screen that exists to hold a browser
        // until an existing device approves it could not detect the approval and
        // could not abort. Ported together because they are one flow: the poll
        // and the way out of it.
        //
        // `head_fingerprint_from_host` reads the device-local sync state's last
        // head observation. `None` means "no head adopted yet", which is the
        // normal answer for the whole time the device is pending — the caller
        // treats the transition to `Some` as the signal, so an honest `None` is
        // load-bearing rather than a stub.
        "plugin:sync|sync_head_fingerprint" => {
            match myne_core::plugins::sync::devices::head_fingerprint_from_host(
                host_ctx(),
                vault_io(),
                crate::session::state(),
            )
            .await
            {
                Ok(v) => Outcome::ok(&v),
                Err(e) => Outcome::error(&e),
            }
        }

        // The abort. Clears this device's token and sync baseline; touches no
        // note, no attachment and no `vault.meta`, and never calls the server.
        // Its failure must SURFACE — the caller's whole reason to press it is
        // that it no longer trusts what this device adopted, and a swallowed
        // error there reads as success.
        "plugin:sync|sync_reset_local" => {
            match myne_core::plugins::sync::devices::reset_local_from_host(
                host_ctx(),
                vault_io(),
                crate::session::state(),
            )
            .await
            {
                Ok(()) => Outcome::ok(&()),
                Err(e) => Outcome::error(&e),
            }
        }

        // ── sync: enrolment ─────────────────────────────────────────────────
        //
        // What puts this browser INTO the device roster — task 33's remaining
        // half, and the first extracted core that carries KEY MATERIAL across
        // the seam. The discipline is inherited rather than re-derived: the
        // credential is `Zeroizing`-wrapped on the core's first statement and
        // dies with the blocking closure; `root_key` and the derived `ServerAuth`
        // secret never leave that closure. What crosses back is an identity and
        // a revocable token, never a key.
        //
        // On approval the desktop bumps a `Manager::try_state` counter so the
        // loop's next tick runs a bootstrap push. The browser's equivalent is its
        // own scheduler, so the signal is fired here — the same one-shot
        // coalesced-push trigger, not an edit-timing disclosure.
        "plugin:sync|sync_enroll" => {
            #[derive(serde::Deserialize)]
            #[serde(rename_all = "camelCase")]
            struct Args {
                account_number: String,
                credential: String,
                credential_kind: myne_core::plugins::sync::enroll::EnrollCredential,
            }
            let a: Args = match serde_json::from_value(args) {
                Ok(a) => a,
                Err(e) => {
                    return Outcome::BadArgs {
                        command: cmd.to_string(),
                        detail: e.to_string(),
                    }
                }
            };
            // **The recovery credential kind is REFUSED here, structurally**
            // (task 92). The UI cannot offer it — the phrase grid is substituted
            // out of the web bundle and the credential-kind control does not
            // render — but a caller reaching this command through the seam's
            // `invoke` from a devtools console bypasses every one of those.
            //
            // Two things would go wrong if it did not: the 24-word phrase would
            // have been typed into served code, which `decisions.md` 2026-07-26
            // forbids permanently and `protocol.md` §7 makes irreversible (the
            // phrase survives every password change and there is no rotation
            // command, so one exposure has no in-app remedy); and per
            // `server-protocol.md` §3.1 the recovery path **self-approves**, so
            // it would also walk straight past the device-approval gate task 33
            // exists to honour. A refusal at the last door is the one that
            // cannot be routed around.
            if matches!(
                a.credential_kind,
                myne_core::plugins::sync::enroll::EnrollCredential::Recovery
            ) {
                return Outcome::Unsupported {
                    operation: "plugin:sync|sync_enroll?credential=recovery".to_string(),
                };
            }
            match myne_core::plugins::sync::enroll::enroll_device_from_host(
                host_ctx(),
                vault_io(),
                crate::session::state(),
                a.account_number,
                a.credential,
                a.credential_kind,
            )
            .await
            {
                Ok(out) => {
                    if out.approved {
                        crate::sync_loop::signal_local_change();
                    }
                    Outcome::ok(&out)
                }
                Err(e) => Outcome::error(&e),
            }
        }

        // ── sync: first-run bootstrap ───────────────────────────────────────
        //
        // Task 85's "log in" leg: point at a server, fetch the account's
        // `vault.meta` pre-auth, mint the local vault, unlock it, enrol. It is
        // the LAST precondition for a browser that has never seen this account —
        // everything else in this plugin assumes a vault already exists.
        //
        // Two arguments carry the whole per-client difference. The vault id is
        // `paths::web_single_vault_id()`, a CONSTANT: a browser holds one vault
        // per origin, so there is nothing to enumerate, and a constant is what
        // makes re-running this idempotent by construction ("never mints a
        // second container") and the `VaultId` stable across reloads. And
        // `can_pin: false` — a page cannot see a leaf certificate, so the result
        // reports `PinSource::PlatformTrustStore` rather than an empty pin that
        // would read as unverified.
        "plugin:sync|sync_join_account" => {
            #[derive(serde::Deserialize)]
            #[serde(rename_all = "camelCase")]
            struct Args {
                server_url: String,
                account_number: String,
                password: String,
            }
            let a: Args = match serde_json::from_value(args) {
                Ok(a) => a,
                Err(e) => {
                    return Outcome::BadArgs {
                        command: cmd.to_string(),
                        detail: e.to_string(),
                    }
                }
            };
            match myne_core::plugins::sync::enroll::join_account_from_host(
                host_ctx(),
                vault_io(),
                crate::session::state(),
                myne_core::plugins::sync::enroll::JoinClient {
                    vault_id: myne_core::paths::web_single_vault_id(),
                    can_pin: false,
                },
                myne_core::plugins::sync::enroll::JoinRequest {
                    server_url: a.server_url,
                    account_number: a.account_number,
                    password: a.password,
                    // `confirmed_fingerprint: None` — not a placeholder either.
                    // The out-of-band compare (MYND-650 task 5) guards a TOFU
                    // pin captured over Tor, and this client captures no pin at
                    // all (`can_pin: false`, above) because a page never sees a
                    // leaf certificate. Nothing to confirm, so nothing is asked.
                    // A web user who wants Tor uses Tor Browser (task 12).
                    confirmed_fingerprint: None,
                },
            )
            .await
            {
                Ok(out) => Outcome::ok(&out),
                Err(e) => Outcome::error(&e),
            }
        }

        // ── sync: the quarantine surface ────────────────────────────────────
        //
        // `quarantine/` is where `sync-protocol.md` §11.3's "moved aside, never
        // destroyed" rule lands on disk, and these four are the only way a user
        // gets a note back out of it. A browser that could not reach them would
        // drop notes into a directory with no door — which is why they ship
        // together rather than read-first (task 87).
        //
        // The listing needed one seam addition, `VaultIo::stat`: it shows each
        // entry's size and age, which `std::fs::DirEntry::metadata` gave for
        // free and the seam's `DirEntry` deliberately does not carry. A listing
        // is cheap on both arms; a stat is not — OPFS needs a handle per entry —
        // so the cost sits at the call site, after the name filter.
        "plugin:sync|sync_list_quarantine" => {
            let state = crate::session::state();
            match myne_core::paths::active_vault_root_io_from_host(
                host_ctx(),
                state.active_vault_id().await,
            ) {
                Ok(dir) => {
                    let rows = myne_core::plugins::sync::conflict::list_quarantine_entries(
                        vault_io(),
                        &dir,
                    )
                    .await;
                    Outcome::ok(&rows)
                }
                // No active vault: an EMPTY listing, not an error. The panel
                // renders "nothing recovered", which is true, rather than a
                // failure banner about a vault the user has not opened.
                Err(_) => {
                    Outcome::ok(&Vec::<myne_core::plugins::sync::conflict::QuarantineEntry>::new())
                }
            }
        }

        "plugin:sync|sync_read_quarantine" | "plugin:sync|sync_delete_quarantine" => {
            #[derive(serde::Deserialize)]
            #[serde(rename_all = "camelCase")]
            struct Args {
                file_name: String,
            }
            let a: Args = match serde_json::from_value(args) {
                Ok(a) => a,
                Err(e) => {
                    return Outcome::BadArgs {
                        command: cmd.to_string(),
                        detail: e.to_string(),
                    }
                }
            };
            let state = crate::session::state();
            let Ok(dir) = myne_core::paths::active_vault_root_io_from_host(
                host_ctx(),
                state.active_vault_id().await,
            ) else {
                return Outcome::error(
                    &myne_core::plugins::sync::devices::SyncDeviceError::Internal,
                );
            };
            // One arm, two commands: identical argument shape and error type,
            // and both are name-validated before they touch anything.
            if cmd.ends_with("read_quarantine") {
                match myne_core::plugins::sync::conflict::read_quarantine_with_dir(
                    vault_io(),
                    &dir,
                    state,
                    &a.file_name,
                )
                .await
                {
                    Ok(body) => Outcome::ok(&body),
                    Err(e) => Outcome::error(&e),
                }
            } else {
                match myne_core::plugins::sync::conflict::delete_quarantine_in(
                    vault_io(),
                    &dir,
                    &a.file_name,
                )
                .await
                {
                    Ok(()) => Outcome::ok(&()),
                    Err(e) => Outcome::error(&e),
                }
            }
        }

        // Restore: the quarantine door's other side. Dispatched separately from
        // list/read/delete because it MINTS A NOTE — `note_create_with_dir` —
        // so it could only land once the notes write path did (task 13). It has.
        //
        // The post-write side effects are the ones `note_create`'s own wrapper
        // owns, reproduced here because this calls the core directly: search
        // indexing so the restored note is findable in-session, and the
        // local-change signal so it pushes on the next cycle. On web the second
        // one goes to the scheduler rather than to a `Manager::try_state`
        // counter — `NoopHooks::bump_local_change` is a no-op, so relying on it
        // would leave a restored note sitting unpushed until something else
        // happened to dirty the vault.
        "plugin:sync|sync_restore_quarantine" => {
            #[derive(serde::Deserialize)]
            #[serde(rename_all = "camelCase")]
            struct Args {
                file_name: String,
            }
            let a: Args = match serde_json::from_value(args) {
                Ok(a) => a,
                Err(e) => {
                    return Outcome::BadArgs {
                        command: cmd.to_string(),
                        detail: e.to_string(),
                    }
                }
            };
            let state = crate::session::state();
            let Ok(dir) = myne_core::paths::active_vault_root_io_from_host(
                host_ctx(),
                state.active_vault_id().await,
            ) else {
                return Outcome::error(
                    &myne_core::plugins::sync::devices::SyncDeviceError::Internal,
                );
            };
            let Ok(notes_dir) = myne_core::paths::notes_dir_under(&dir) else {
                return Outcome::error(
                    &myne_core::plugins::sync::devices::SyncDeviceError::Internal,
                );
            };
            match myne_core::plugins::sync::conflict::restore_quarantine_with_dirs(
                vault_io(),
                &dir,
                notes_dir,
                state,
                &a.file_name,
                host_ctx(),
            )
            .await
            {
                Ok((new_id, _body)) => {
                    crate::sync_loop::signal_local_change();
                    Outcome::ok(&new_id)
                }
                Err(e) => Outcome::error(&e),
            }
        }

        // The vault roster (task 85's remaining half). ONE summary, from the
        // constant vault id — `resolveActiveVaultId()` is how several shared
        // modules learn which vault they operate on, and a command declared
        // unsupported would return `null` and leave every one of them silently
        // no-opping forever. That is the failure this arm exists to prevent.
        //
        // The id it reports is stable across reloads and carries no account
        // number, no hash bytes and no path — the DENY list `src/lib/vault-list.ts`
        // documents — because it is a constant chosen for exactly that.
        "plugin:vault-unlock|vault_list" => {
            let rows = myne_core::plugins::vault_unlock::commands::vault_list_single_from_host(
                host_ctx(),
                vault_io(),
                crate::session::state(),
                myne_core::paths::web_single_vault_id(),
            )
            .await;
            Outcome::ok(&rows)
        }

        // ── sync: keep-both conflict staging ────────────────────────────────
        //
        // `conflicts/<id>.myn` is where `sync-protocol.md` §10.1's keep-both
        // puts the REMOTE revision when two devices edited one note; the local
        // edit is never touched. These four are how the notes layer finishes
        // that resolution — list what is staged, decrypt one to a body,
        // adopt-and-clear, and queue the tombstone. A browser without them would
        // STAGE conflicts it could not resolve, which is the same dead end
        // quarantine had before its own pass.
        //
        // No vault open resolves to `Internal` for the three that need a root,
        // matching the desktop wrappers exactly (they map the same failure the
        // same way). `pending_conflicts` answers an EMPTY list instead, because
        // "nothing is staged" is true and a panel does not need an error to say
        // it.
        "plugin:sync|sync_pending_conflicts" => {
            let state = crate::session::state();
            match myne_core::paths::active_vault_root_io_from_host(
                host_ctx(),
                state.active_vault_id().await,
            ) {
                Ok(dir) => Outcome::ok(
                    &myne_core::plugins::sync::conflict::pending_conflicts(vault_io(), &dir).await,
                ),
                Err(_) => Outcome::ok(&Vec::<String>::new()),
            }
        }

        "plugin:sync|sync_take_conflict"
        | "plugin:sync|sync_resolve_conflict"
        | "plugin:sync|sync_mark_tombstone" => {
            #[derive(serde::Deserialize)]
            #[serde(rename_all = "camelCase")]
            struct Args {
                // `take`/`resolve` name the ORIGINAL note; `mark_tombstone`
                // names the note being deleted. One optional field each rather
                // than three arms, because the shapes are otherwise identical.
                original_id_hex: Option<String>,
                note_id_hex: Option<String>,
            }
            let a: Args = match serde_json::from_value(args) {
                Ok(a) => a,
                Err(e) => {
                    return Outcome::BadArgs {
                        command: cmd.to_string(),
                        detail: e.to_string(),
                    }
                }
            };
            let state = crate::session::state();
            let Ok(dir) = myne_core::paths::active_vault_root_io_from_host(
                host_ctx(),
                state.active_vault_id().await,
            ) else {
                return Outcome::error(
                    &myne_core::plugins::sync::devices::SyncDeviceError::Internal,
                );
            };
            let io = vault_io();
            if cmd.ends_with("mark_tombstone") {
                let Some(id) = a.note_id_hex else {
                    return Outcome::error(
                        &myne_core::plugins::sync::devices::SyncDeviceError::BadRequest,
                    );
                };
                match myne_core::plugins::sync::conflict::mark_tombstone(io, &dir, &id).await {
                    Ok(()) => Outcome::ok(&()),
                    Err(e) => Outcome::error(&e),
                }
            } else {
                let Some(id) = a.original_id_hex else {
                    return Outcome::error(
                        &myne_core::plugins::sync::devices::SyncDeviceError::BadRequest,
                    );
                };
                if cmd.ends_with("take_conflict") {
                    match myne_core::plugins::sync::conflict::take_conflict(io, &dir, state, &id)
                        .await
                    {
                        Ok(body) => Outcome::ok(&body),
                        Err(e) => Outcome::error(&e),
                    }
                } else {
                    match myne_core::plugins::sync::conflict::resolve_conflict(io, &dir, &id).await
                    {
                        Ok(()) => Outcome::ok(&()),
                        Err(e) => Outcome::error(&e),
                    }
                }
            }
        }

        "plugin:prefs|prefs_read" => {
            use myne_core::plugins::prefs::commands::prefs_read_from_host;
            match prefs_read_from_host(host_ctx(), crate::session::state(), vault_io()).await {
                Ok(view) => Outcome::ok(&view),
                Err(e) => Outcome::error(&e),
            }
        }

        // ── prefs setters (phase3-web-client task 14) ───────────────────────
        //
        // Forty-five arms of one shape, because `myne-core` already has forty-five
        // `*_from_host` setters of one shape — the port is the dispatch, not the
        // logic.
        //
        // **`set_screen_capture_protection` is deliberately NOT here**: it is
        // `Class::Unsupported` by decision (a page cannot ask the compositor to
        // exclude it from a capture), so it must answer the typed refusal rather
        // than write a pref the client cannot honour.
        //
        // **Everything else IS here, including the settings whose FEATURE is
        // absent** — spell, AI, attachment OCR, auto-lock timeout. The
        // distinction is the one `capability.rs` already draws for
        // `set_auto_lock_timeout`: the *pref* is vault content that syncs to
        // every client, and it is the native runtime that has no browser
        // equivalent. Refusing the write would corrupt a setting the user's
        // desktop depends on — a browser session would silently drop their spell
        // languages the first time they opened Settings.
        "plugin:prefs|set_spell_enabled" => {
            #[derive(serde::Deserialize)]
            #[serde(rename_all = "camelCase")]
            struct Args {
                enabled: bool,
            }
            let a: Args = match serde_json::from_value(args) {
                Ok(a) => a,
                Err(e) => {
                    return Outcome::BadArgs {
                        command: cmd.to_string(),
                        detail: e.to_string(),
                    }
                }
            };
            match myne_core::plugins::prefs::commands::set_spell_enabled_from_host(
                host_ctx(),
                crate::session::state(),
                crate::session::hooks(),
                a.enabled,
                vault_io(),
            )
            .await
            {
                Ok(()) => Outcome::ok(&serde_json::Value::Null),
                Err(e) => Outcome::error(&e),
            }
        }

        "plugin:prefs|set_editor_line_numbers" => {
            #[derive(serde::Deserialize)]
            #[serde(rename_all = "camelCase")]
            struct Args {
                enabled: bool,
            }
            let a: Args = match serde_json::from_value(args) {
                Ok(a) => a,
                Err(e) => {
                    return Outcome::BadArgs {
                        command: cmd.to_string(),
                        detail: e.to_string(),
                    }
                }
            };
            match myne_core::plugins::prefs::commands::set_editor_line_numbers_from_host(
                host_ctx(),
                crate::session::state(),
                crate::session::hooks(),
                a.enabled,
                vault_io(),
            )
            .await
            {
                Ok(()) => Outcome::ok(&serde_json::Value::Null),
                Err(e) => Outcome::error(&e),
            }
        }

        "plugin:prefs|set_editor_vim_mode" => {
            #[derive(serde::Deserialize)]
            #[serde(rename_all = "camelCase")]
            struct Args {
                enabled: bool,
            }
            let a: Args = match serde_json::from_value(args) {
                Ok(a) => a,
                Err(e) => {
                    return Outcome::BadArgs {
                        command: cmd.to_string(),
                        detail: e.to_string(),
                    }
                }
            };
            match myne_core::plugins::prefs::commands::set_editor_vim_mode_from_host(
                host_ctx(),
                crate::session::state(),
                crate::session::hooks(),
                a.enabled,
                vault_io(),
            )
            .await
            {
                Ok(()) => Outcome::ok(&serde_json::Value::Null),
                Err(e) => Outcome::error(&e),
            }
        }

        "plugin:prefs|set_active_workspace" => {
            #[derive(serde::Deserialize)]
            #[serde(rename_all = "camelCase")]
            struct Args {
                value: Option<String>,
            }
            let a: Args = match serde_json::from_value(args) {
                Ok(a) => a,
                Err(e) => {
                    return Outcome::BadArgs {
                        command: cmd.to_string(),
                        detail: e.to_string(),
                    }
                }
            };
            match myne_core::plugins::prefs::commands::set_active_workspace_from_host(
                host_ctx(),
                crate::session::state(),
                crate::session::hooks(),
                a.value,
                vault_io(),
            )
            .await
            {
                Ok(()) => Outcome::ok(&serde_json::Value::Null),
                Err(e) => Outcome::error(&e),
            }
        }

        "plugin:prefs|set_editor_default_view_mode" => {
            #[derive(serde::Deserialize)]
            #[serde(rename_all = "camelCase")]
            struct Args {
                value: Option<String>,
            }
            let a: Args = match serde_json::from_value(args) {
                Ok(a) => a,
                Err(e) => {
                    return Outcome::BadArgs {
                        command: cmd.to_string(),
                        detail: e.to_string(),
                    }
                }
            };
            match myne_core::plugins::prefs::commands::set_editor_default_view_mode_from_host(
                host_ctx(),
                crate::session::state(),
                crate::session::hooks(),
                a.value,
                vault_io(),
            )
            .await
            {
                Ok(()) => Outcome::ok(&serde_json::Value::Null),
                Err(e) => Outcome::error(&e),
            }
        }

        "plugin:prefs|set_editor_focus_dim_inactive" => {
            #[derive(serde::Deserialize)]
            #[serde(rename_all = "camelCase")]
            struct Args {
                enabled: bool,
            }
            let a: Args = match serde_json::from_value(args) {
                Ok(a) => a,
                Err(e) => {
                    return Outcome::BadArgs {
                        command: cmd.to_string(),
                        detail: e.to_string(),
                    }
                }
            };
            match myne_core::plugins::prefs::commands::set_editor_focus_dim_inactive_from_host(
                host_ctx(),
                crate::session::state(),
                crate::session::hooks(),
                a.enabled,
                vault_io(),
            )
            .await
            {
                Ok(()) => Outcome::ok(&serde_json::Value::Null),
                Err(e) => Outcome::error(&e),
            }
        }

        "plugin:prefs|set_editor_focus_typewriter" => {
            #[derive(serde::Deserialize)]
            #[serde(rename_all = "camelCase")]
            struct Args {
                enabled: bool,
            }
            let a: Args = match serde_json::from_value(args) {
                Ok(a) => a,
                Err(e) => {
                    return Outcome::BadArgs {
                        command: cmd.to_string(),
                        detail: e.to_string(),
                    }
                }
            };
            match myne_core::plugins::prefs::commands::set_editor_focus_typewriter_from_host(
                host_ctx(),
                crate::session::state(),
                crate::session::hooks(),
                a.enabled,
                vault_io(),
            )
            .await
            {
                Ok(()) => Outcome::ok(&serde_json::Value::Null),
                Err(e) => Outcome::error(&e),
            }
        }

        "plugin:prefs|set_show_note_timestamps" => {
            #[derive(serde::Deserialize)]
            #[serde(rename_all = "camelCase")]
            struct Args {
                enabled: bool,
            }
            let a: Args = match serde_json::from_value(args) {
                Ok(a) => a,
                Err(e) => {
                    return Outcome::BadArgs {
                        command: cmd.to_string(),
                        detail: e.to_string(),
                    }
                }
            };
            match myne_core::plugins::prefs::commands::set_show_note_timestamps_from_host(
                host_ctx(),
                crate::session::state(),
                crate::session::hooks(),
                a.enabled,
                vault_io(),
            )
            .await
            {
                Ok(()) => Outcome::ok(&serde_json::Value::Null),
                Err(e) => Outcome::error(&e),
            }
        }

        "plugin:prefs|set_spell_languages" => {
            #[derive(serde::Deserialize)]
            #[serde(rename_all = "camelCase")]
            struct Args {
                languages: Vec<String>,
            }
            let a: Args = match serde_json::from_value(args) {
                Ok(a) => a,
                Err(e) => {
                    return Outcome::BadArgs {
                        command: cmd.to_string(),
                        detail: e.to_string(),
                    }
                }
            };
            match myne_core::plugins::prefs::commands::set_spell_languages_from_host(
                host_ctx(),
                crate::session::state(),
                crate::session::hooks(),
                a.languages,
                vault_io(),
            )
            .await
            {
                Ok(()) => Outcome::ok(&serde_json::Value::Null),
                Err(e) => Outcome::error(&e),
            }
        }

        "plugin:prefs|set_keymap_binding" => {
            #[derive(serde::Deserialize)]
            #[serde(rename_all = "camelCase")]
            struct Args {
                command_id: String,
                chords: Option<Vec<String>>,
            }
            let a: Args = match serde_json::from_value(args) {
                Ok(a) => a,
                Err(e) => {
                    return Outcome::BadArgs {
                        command: cmd.to_string(),
                        detail: e.to_string(),
                    }
                }
            };
            match myne_core::plugins::prefs::commands::set_keymap_binding_from_host(
                host_ctx(),
                crate::session::state(),
                crate::session::hooks(),
                a.command_id,
                a.chords,
                vault_io(),
            )
            .await
            {
                Ok(()) => Outcome::ok(&serde_json::Value::Null),
                Err(e) => Outcome::error(&e),
            }
        }

        "plugin:prefs|set_deliberate_folders" => {
            #[derive(serde::Deserialize)]
            #[serde(rename_all = "camelCase")]
            struct Args {
                folders: Vec<String>,
            }
            let a: Args = match serde_json::from_value(args) {
                Ok(a) => a,
                Err(e) => {
                    return Outcome::BadArgs {
                        command: cmd.to_string(),
                        detail: e.to_string(),
                    }
                }
            };
            match myne_core::plugins::prefs::commands::set_deliberate_folders_from_host(
                host_ctx(),
                crate::session::state(),
                crate::session::hooks(),
                a.folders,
                vault_io(),
            )
            .await
            {
                Ok(()) => Outcome::ok(&serde_json::Value::Null),
                Err(e) => Outcome::error(&e),
            }
        }

        "plugin:prefs|set_archived_folders" => {
            #[derive(serde::Deserialize)]
            #[serde(rename_all = "camelCase")]
            struct Args {
                folders: Vec<String>,
            }
            let a: Args = match serde_json::from_value(args) {
                Ok(a) => a,
                Err(e) => {
                    return Outcome::BadArgs {
                        command: cmd.to_string(),
                        detail: e.to_string(),
                    }
                }
            };
            match myne_core::plugins::prefs::commands::set_archived_folders_from_host(
                host_ctx(),
                crate::session::state(),
                crate::session::hooks(),
                a.folders,
                vault_io(),
            )
            .await
            {
                Ok(()) => Outcome::ok(&serde_json::Value::Null),
                Err(e) => Outcome::error(&e),
            }
        }

        "plugin:prefs|set_ai_enabled" => {
            #[derive(serde::Deserialize)]
            #[serde(rename_all = "camelCase")]
            struct Args {
                enabled: bool,
            }
            let a: Args = match serde_json::from_value(args) {
                Ok(a) => a,
                Err(e) => {
                    return Outcome::BadArgs {
                        command: cmd.to_string(),
                        detail: e.to_string(),
                    }
                }
            };
            match myne_core::plugins::prefs::commands::set_ai_enabled_from_host(
                host_ctx(),
                crate::session::state(),
                crate::session::hooks(),
                a.enabled,
                vault_io(),
            )
            .await
            {
                Ok(()) => Outcome::ok(&serde_json::Value::Null),
                Err(e) => Outcome::error(&e),
            }
        }

        "plugin:prefs|set_attachment_compression_enabled" => {
            #[derive(serde::Deserialize)]
            #[serde(rename_all = "camelCase")]
            struct Args {
                enabled: bool,
            }
            let a: Args = match serde_json::from_value(args) {
                Ok(a) => a,
                Err(e) => {
                    return Outcome::BadArgs {
                        command: cmd.to_string(),
                        detail: e.to_string(),
                    }
                }
            };
            match myne_core::plugins::prefs::commands::set_attachment_compression_enabled_from_host(
                host_ctx(),
                crate::session::state(),
                crate::session::hooks(),
                a.enabled,
                vault_io(),
            )
            .await
            {
                Ok(()) => Outcome::ok(&serde_json::Value::Null),
                Err(e) => Outcome::error(&e),
            }
        }

        "plugin:prefs|set_attachment_ocr_enabled" => {
            #[derive(serde::Deserialize)]
            #[serde(rename_all = "camelCase")]
            struct Args {
                enabled: bool,
            }
            let a: Args = match serde_json::from_value(args) {
                Ok(a) => a,
                Err(e) => {
                    return Outcome::BadArgs {
                        command: cmd.to_string(),
                        detail: e.to_string(),
                    }
                }
            };
            match myne_core::plugins::prefs::commands::set_attachment_ocr_enabled_from_host(
                host_ctx(),
                crate::session::state(),
                crate::session::hooks(),
                a.enabled,
                vault_io(),
            )
            .await
            {
                Ok(()) => Outcome::ok(&serde_json::Value::Null),
                Err(e) => Outcome::error(&e),
            }
        }

        "plugin:prefs|set_developer_mode" => {
            #[derive(serde::Deserialize)]
            #[serde(rename_all = "camelCase")]
            struct Args {
                enabled: bool,
            }
            let a: Args = match serde_json::from_value(args) {
                Ok(a) => a,
                Err(e) => {
                    return Outcome::BadArgs {
                        command: cmd.to_string(),
                        detail: e.to_string(),
                    }
                }
            };
            match myne_core::plugins::prefs::commands::set_developer_mode_from_host(
                host_ctx(),
                crate::session::state(),
                crate::session::hooks(),
                a.enabled,
                vault_io(),
            )
            .await
            {
                Ok(()) => Outcome::ok(&serde_json::Value::Null),
                Err(e) => Outcome::error(&e),
            }
        }

        "plugin:prefs|set_ai_excluded_folders" => {
            #[derive(serde::Deserialize)]
            #[serde(rename_all = "camelCase")]
            struct Args {
                folders: Vec<String>,
            }
            let a: Args = match serde_json::from_value(args) {
                Ok(a) => a,
                Err(e) => {
                    return Outcome::BadArgs {
                        command: cmd.to_string(),
                        detail: e.to_string(),
                    }
                }
            };
            match myne_core::plugins::prefs::commands::set_ai_excluded_folders_from_host(
                host_ctx(),
                crate::session::state(),
                crate::session::hooks(),
                a.folders,
                vault_io(),
            )
            .await
            {
                Ok(()) => Outcome::ok(&serde_json::Value::Null),
                Err(e) => Outcome::error(&e),
            }
        }

        "plugin:prefs|set_item_order" => {
            #[derive(serde::Deserialize)]
            #[serde(rename_all = "camelCase")]
            struct Args {
                order: Vec<String>,
            }
            let a: Args = match serde_json::from_value(args) {
                Ok(a) => a,
                Err(e) => {
                    return Outcome::BadArgs {
                        command: cmd.to_string(),
                        detail: e.to_string(),
                    }
                }
            };
            match myne_core::plugins::prefs::commands::set_item_order_from_host(
                host_ctx(),
                crate::session::state(),
                crate::session::hooks(),
                a.order,
                vault_io(),
            )
            .await
            {
                Ok(()) => Outcome::ok(&serde_json::Value::Null),
                Err(e) => Outcome::error(&e),
            }
        }

        "plugin:prefs|set_hidden_bar_items" => {
            #[derive(serde::Deserialize)]
            #[serde(rename_all = "camelCase")]
            struct Args {
                items: Vec<String>,
            }
            let a: Args = match serde_json::from_value(args) {
                Ok(a) => a,
                Err(e) => {
                    return Outcome::BadArgs {
                        command: cmd.to_string(),
                        detail: e.to_string(),
                    }
                }
            };
            match myne_core::plugins::prefs::commands::set_hidden_bar_items_from_host(
                host_ctx(),
                crate::session::state(),
                crate::session::hooks(),
                a.items,
                vault_io(),
            )
            .await
            {
                Ok(()) => Outcome::ok(&serde_json::Value::Null),
                Err(e) => Outcome::error(&e),
            }
        }

        "plugin:prefs|upsert_saved_view" => {
            #[derive(serde::Deserialize)]
            #[serde(rename_all = "camelCase")]
            struct Args {
                view: protocol::SavedView,
            }
            let a: Args = match serde_json::from_value(args) {
                Ok(a) => a,
                Err(e) => {
                    return Outcome::BadArgs {
                        command: cmd.to_string(),
                        detail: e.to_string(),
                    }
                }
            };
            match myne_core::plugins::prefs::commands::upsert_saved_view_from_host(
                host_ctx(),
                crate::session::state(),
                crate::session::hooks(),
                a.view,
                vault_io(),
            )
            .await
            {
                Ok(()) => Outcome::ok(&serde_json::Value::Null),
                Err(e) => Outcome::error(&e),
            }
        }

        "plugin:prefs|delete_saved_view" => {
            #[derive(serde::Deserialize)]
            #[serde(rename_all = "camelCase")]
            struct Args {
                id: String,
            }
            let a: Args = match serde_json::from_value(args) {
                Ok(a) => a,
                Err(e) => {
                    return Outcome::BadArgs {
                        command: cmd.to_string(),
                        detail: e.to_string(),
                    }
                }
            };
            match myne_core::plugins::prefs::commands::delete_saved_view_from_host(
                host_ctx(),
                crate::session::state(),
                crate::session::hooks(),
                a.id,
                vault_io(),
            )
            .await
            {
                Ok(()) => Outcome::ok(&serde_json::Value::Null),
                Err(e) => Outcome::error(&e),
            }
        }

        "plugin:prefs|set_view_order" => {
            #[derive(serde::Deserialize)]
            #[serde(rename_all = "camelCase")]
            struct Args {
                order: Vec<String>,
            }
            let a: Args = match serde_json::from_value(args) {
                Ok(a) => a,
                Err(e) => {
                    return Outcome::BadArgs {
                        command: cmd.to_string(),
                        detail: e.to_string(),
                    }
                }
            };
            match myne_core::plugins::prefs::commands::set_view_order_from_host(
                host_ctx(),
                crate::session::state(),
                crate::session::hooks(),
                a.order,
                vault_io(),
            )
            .await
            {
                Ok(()) => Outcome::ok(&serde_json::Value::Null),
                Err(e) => Outcome::error(&e),
            }
        }

        "plugin:prefs|set_bar_items_order" => {
            #[derive(serde::Deserialize)]
            #[serde(rename_all = "camelCase")]
            struct Args {
                order: Vec<String>,
            }
            let a: Args = match serde_json::from_value(args) {
                Ok(a) => a,
                Err(e) => {
                    return Outcome::BadArgs {
                        command: cmd.to_string(),
                        detail: e.to_string(),
                    }
                }
            };
            match myne_core::plugins::prefs::commands::set_bar_items_order_from_host(
                host_ctx(),
                crate::session::state(),
                crate::session::hooks(),
                a.order,
                vault_io(),
            )
            .await
            {
                Ok(()) => Outcome::ok(&serde_json::Value::Null),
                Err(e) => Outcome::error(&e),
            }
        }

        "plugin:prefs|set_color_groups" => {
            #[derive(serde::Deserialize)]
            #[serde(rename_all = "camelCase")]
            struct Args {
                groups: Vec<protocol::ColorGroup>,
            }
            let a: Args = match serde_json::from_value(args) {
                Ok(a) => a,
                Err(e) => {
                    return Outcome::BadArgs {
                        command: cmd.to_string(),
                        detail: e.to_string(),
                    }
                }
            };
            match myne_core::plugins::prefs::commands::set_color_groups_from_host(
                host_ctx(),
                crate::session::state(),
                crate::session::hooks(),
                a.groups,
                vault_io(),
            )
            .await
            {
                Ok(()) => Outcome::ok(&serde_json::Value::Null),
                Err(e) => Outcome::error(&e),
            }
        }

        "plugin:prefs|set_right_panel_active_tab" => {
            #[derive(serde::Deserialize)]
            #[serde(rename_all = "camelCase")]
            struct Args {
                value: Option<String>,
            }
            let a: Args = match serde_json::from_value(args) {
                Ok(a) => a,
                Err(e) => {
                    return Outcome::BadArgs {
                        command: cmd.to_string(),
                        detail: e.to_string(),
                    }
                }
            };
            match myne_core::plugins::prefs::commands::set_right_panel_active_tab_from_host(
                host_ctx(),
                crate::session::state(),
                crate::session::hooks(),
                a.value,
                vault_io(),
            )
            .await
            {
                Ok(()) => Outcome::ok(&serde_json::Value::Null),
                Err(e) => Outcome::error(&e),
            }
        }

        "plugin:prefs|set_right_panel_hidden_tabs" => {
            #[derive(serde::Deserialize)]
            #[serde(rename_all = "camelCase")]
            struct Args {
                items: Vec<String>,
            }
            let a: Args = match serde_json::from_value(args) {
                Ok(a) => a,
                Err(e) => {
                    return Outcome::BadArgs {
                        command: cmd.to_string(),
                        detail: e.to_string(),
                    }
                }
            };
            match myne_core::plugins::prefs::commands::set_right_panel_hidden_tabs_from_host(
                host_ctx(),
                crate::session::state(),
                crate::session::hooks(),
                a.items,
                vault_io(),
            )
            .await
            {
                Ok(()) => Outcome::ok(&serde_json::Value::Null),
                Err(e) => Outcome::error(&e),
            }
        }

        "plugin:prefs|set_right_panel_tab_order" => {
            #[derive(serde::Deserialize)]
            #[serde(rename_all = "camelCase")]
            struct Args {
                order: Vec<String>,
            }
            let a: Args = match serde_json::from_value(args) {
                Ok(a) => a,
                Err(e) => {
                    return Outcome::BadArgs {
                        command: cmd.to_string(),
                        detail: e.to_string(),
                    }
                }
            };
            match myne_core::plugins::prefs::commands::set_right_panel_tab_order_from_host(
                host_ctx(),
                crate::session::state(),
                crate::session::hooks(),
                a.order,
                vault_io(),
            )
            .await
            {
                Ok(()) => Outcome::ok(&serde_json::Value::Null),
                Err(e) => Outcome::error(&e),
            }
        }

        "plugin:prefs|set_editor_toolbar_order" => {
            #[derive(serde::Deserialize)]
            #[serde(rename_all = "camelCase")]
            struct Args {
                order: Vec<String>,
            }
            let a: Args = match serde_json::from_value(args) {
                Ok(a) => a,
                Err(e) => {
                    return Outcome::BadArgs {
                        command: cmd.to_string(),
                        detail: e.to_string(),
                    }
                }
            };
            match myne_core::plugins::prefs::commands::set_editor_toolbar_order_from_host(
                host_ctx(),
                crate::session::state(),
                crate::session::hooks(),
                a.order,
                vault_io(),
            )
            .await
            {
                Ok(()) => Outcome::ok(&serde_json::Value::Null),
                Err(e) => Outcome::error(&e),
            }
        }

        "plugin:prefs|set_editor_toolbar_hidden" => {
            #[derive(serde::Deserialize)]
            #[serde(rename_all = "camelCase")]
            struct Args {
                items: Vec<String>,
            }
            let a: Args = match serde_json::from_value(args) {
                Ok(a) => a,
                Err(e) => {
                    return Outcome::BadArgs {
                        command: cmd.to_string(),
                        detail: e.to_string(),
                    }
                }
            };
            match myne_core::plugins::prefs::commands::set_editor_toolbar_hidden_from_host(
                host_ctx(),
                crate::session::state(),
                crate::session::hooks(),
                a.items,
                vault_io(),
            )
            .await
            {
                Ok(()) => Outcome::ok(&serde_json::Value::Null),
                Err(e) => Outcome::error(&e),
            }
        }

        "plugin:prefs|set_editor_slash_order" => {
            #[derive(serde::Deserialize)]
            #[serde(rename_all = "camelCase")]
            struct Args {
                order: Vec<String>,
            }
            let a: Args = match serde_json::from_value(args) {
                Ok(a) => a,
                Err(e) => {
                    return Outcome::BadArgs {
                        command: cmd.to_string(),
                        detail: e.to_string(),
                    }
                }
            };
            match myne_core::plugins::prefs::commands::set_editor_slash_order_from_host(
                host_ctx(),
                crate::session::state(),
                crate::session::hooks(),
                a.order,
                vault_io(),
            )
            .await
            {
                Ok(()) => Outcome::ok(&serde_json::Value::Null),
                Err(e) => Outcome::error(&e),
            }
        }

        "plugin:prefs|set_editor_slash_hidden" => {
            #[derive(serde::Deserialize)]
            #[serde(rename_all = "camelCase")]
            struct Args {
                items: Vec<String>,
            }
            let a: Args = match serde_json::from_value(args) {
                Ok(a) => a,
                Err(e) => {
                    return Outcome::BadArgs {
                        command: cmd.to_string(),
                        detail: e.to_string(),
                    }
                }
            };
            match myne_core::plugins::prefs::commands::set_editor_slash_hidden_from_host(
                host_ctx(),
                crate::session::state(),
                crate::session::hooks(),
                a.items,
                vault_io(),
            )
            .await
            {
                Ok(()) => Outcome::ok(&serde_json::Value::Null),
                Err(e) => Outcome::error(&e),
            }
        }

        "plugin:prefs|set_daily_date_format" => {
            #[derive(serde::Deserialize)]
            #[serde(rename_all = "camelCase")]
            struct Args {
                format: String,
            }
            let a: Args = match serde_json::from_value(args) {
                Ok(a) => a,
                Err(e) => {
                    return Outcome::BadArgs {
                        command: cmd.to_string(),
                        detail: e.to_string(),
                    }
                }
            };
            match myne_core::plugins::prefs::commands::set_daily_date_format_from_host(
                host_ctx(),
                crate::session::state(),
                crate::session::hooks(),
                a.format,
                vault_io(),
            )
            .await
            {
                Ok(()) => Outcome::ok(&serde_json::Value::Null),
                Err(e) => Outcome::error(&e),
            }
        }

        "plugin:prefs|set_daily_folder" => {
            #[derive(serde::Deserialize)]
            #[serde(rename_all = "camelCase")]
            struct Args {
                folder: String,
            }
            let a: Args = match serde_json::from_value(args) {
                Ok(a) => a,
                Err(e) => {
                    return Outcome::BadArgs {
                        command: cmd.to_string(),
                        detail: e.to_string(),
                    }
                }
            };
            match myne_core::plugins::prefs::commands::set_daily_folder_from_host(
                host_ctx(),
                crate::session::state(),
                crate::session::hooks(),
                a.folder,
                vault_io(),
            )
            .await
            {
                Ok(()) => Outcome::ok(&serde_json::Value::Null),
                Err(e) => Outcome::error(&e),
            }
        }

        "plugin:prefs|set_daily_template" => {
            #[derive(serde::Deserialize)]
            #[serde(rename_all = "camelCase")]
            struct Args {
                template_id: Option<String>,
            }
            let a: Args = match serde_json::from_value(args) {
                Ok(a) => a,
                Err(e) => {
                    return Outcome::BadArgs {
                        command: cmd.to_string(),
                        detail: e.to_string(),
                    }
                }
            };
            match myne_core::plugins::prefs::commands::set_daily_template_from_host(
                host_ctx(),
                crate::session::state(),
                crate::session::hooks(),
                a.template_id,
                vault_io(),
            )
            .await
            {
                Ok(()) => Outcome::ok(&serde_json::Value::Null),
                Err(e) => Outcome::error(&e),
            }
        }

        "plugin:prefs|set_new_note_location" => {
            #[derive(serde::Deserialize)]
            #[serde(rename_all = "camelCase")]
            struct Args {
                location: Option<String>,
                folder: Option<String>,
            }
            let a: Args = match serde_json::from_value(args) {
                Ok(a) => a,
                Err(e) => {
                    return Outcome::BadArgs {
                        command: cmd.to_string(),
                        detail: e.to_string(),
                    }
                }
            };
            match myne_core::plugins::prefs::commands::set_new_note_location_from_host(
                host_ctx(),
                crate::session::state(),
                crate::session::hooks(),
                a.location,
                a.folder,
                vault_io(),
            )
            .await
            {
                Ok(()) => Outcome::ok(&serde_json::Value::Null),
                Err(e) => Outcome::error(&e),
            }
        }

        "plugin:prefs|set_editor_text_size" => {
            #[derive(serde::Deserialize)]
            #[serde(rename_all = "camelCase")]
            struct Args {
                value: Option<String>,
            }
            let a: Args = match serde_json::from_value(args) {
                Ok(a) => a,
                Err(e) => {
                    return Outcome::BadArgs {
                        command: cmd.to_string(),
                        detail: e.to_string(),
                    }
                }
            };
            match myne_core::plugins::prefs::commands::set_editor_text_size_from_host(
                host_ctx(),
                crate::session::state(),
                crate::session::hooks(),
                a.value,
                vault_io(),
            )
            .await
            {
                Ok(()) => Outcome::ok(&serde_json::Value::Null),
                Err(e) => Outcome::error(&e),
            }
        }

        "plugin:prefs|set_editor_line_spacing" => {
            #[derive(serde::Deserialize)]
            #[serde(rename_all = "camelCase")]
            struct Args {
                value: Option<String>,
            }
            let a: Args = match serde_json::from_value(args) {
                Ok(a) => a,
                Err(e) => {
                    return Outcome::BadArgs {
                        command: cmd.to_string(),
                        detail: e.to_string(),
                    }
                }
            };
            match myne_core::plugins::prefs::commands::set_editor_line_spacing_from_host(
                host_ctx(),
                crate::session::state(),
                crate::session::hooks(),
                a.value,
                vault_io(),
            )
            .await
            {
                Ok(()) => Outcome::ok(&serde_json::Value::Null),
                Err(e) => Outcome::error(&e),
            }
        }

        "plugin:prefs|set_editor_content_width" => {
            #[derive(serde::Deserialize)]
            #[serde(rename_all = "camelCase")]
            struct Args {
                value: Option<String>,
            }
            let a: Args = match serde_json::from_value(args) {
                Ok(a) => a,
                Err(e) => {
                    return Outcome::BadArgs {
                        command: cmd.to_string(),
                        detail: e.to_string(),
                    }
                }
            };
            match myne_core::plugins::prefs::commands::set_editor_content_width_from_host(
                host_ctx(),
                crate::session::state(),
                crate::session::hooks(),
                a.value,
                vault_io(),
            )
            .await
            {
                Ok(()) => Outcome::ok(&serde_json::Value::Null),
                Err(e) => Outcome::error(&e),
            }
        }

        "plugin:prefs|set_editor_font_family" => {
            #[derive(serde::Deserialize)]
            #[serde(rename_all = "camelCase")]
            struct Args {
                value: Option<String>,
            }
            let a: Args = match serde_json::from_value(args) {
                Ok(a) => a,
                Err(e) => {
                    return Outcome::BadArgs {
                        command: cmd.to_string(),
                        detail: e.to_string(),
                    }
                }
            };
            match myne_core::plugins::prefs::commands::set_editor_font_family_from_host(
                host_ctx(),
                crate::session::state(),
                crate::session::hooks(),
                a.value,
                vault_io(),
            )
            .await
            {
                Ok(()) => Outcome::ok(&serde_json::Value::Null),
                Err(e) => Outcome::error(&e),
            }
        }

        "plugin:prefs|set_startup_open" => {
            #[derive(serde::Deserialize)]
            #[serde(rename_all = "camelCase")]
            struct Args {
                mode: Option<String>,
                note: Option<String>,
            }
            let a: Args = match serde_json::from_value(args) {
                Ok(a) => a,
                Err(e) => {
                    return Outcome::BadArgs {
                        command: cmd.to_string(),
                        detail: e.to_string(),
                    }
                }
            };
            match myne_core::plugins::prefs::commands::set_startup_open_from_host(
                host_ctx(),
                crate::session::state(),
                crate::session::hooks(),
                a.mode,
                a.note,
                vault_io(),
            )
            .await
            {
                Ok(()) => Outcome::ok(&serde_json::Value::Null),
                Err(e) => Outcome::error(&e),
            }
        }

        "plugin:prefs|set_favorites" => {
            #[derive(serde::Deserialize)]
            #[serde(rename_all = "camelCase")]
            struct Args {
                order: Vec<String>,
            }
            let a: Args = match serde_json::from_value(args) {
                Ok(a) => a,
                Err(e) => {
                    return Outcome::BadArgs {
                        command: cmd.to_string(),
                        detail: e.to_string(),
                    }
                }
            };
            match myne_core::plugins::prefs::commands::set_favorites_from_host(
                host_ctx(),
                crate::session::state(),
                crate::session::hooks(),
                a.order,
                vault_io(),
            )
            .await
            {
                Ok(()) => Outcome::ok(&serde_json::Value::Null),
                Err(e) => Outcome::error(&e),
            }
        }

        "plugin:prefs|set_auto_lock_timeout" => {
            #[derive(serde::Deserialize)]
            #[serde(rename_all = "camelCase")]
            struct Args {
                seconds: u32,
            }
            let a: Args = match serde_json::from_value(args) {
                Ok(a) => a,
                Err(e) => {
                    return Outcome::BadArgs {
                        command: cmd.to_string(),
                        detail: e.to_string(),
                    }
                }
            };
            match myne_core::plugins::prefs::commands::set_auto_lock_timeout_from_host(
                host_ctx(),
                crate::session::state(),
                crate::session::hooks(),
                a.seconds,
                vault_io(),
            )
            .await
            {
                Ok(()) => Outcome::ok(&serde_json::Value::Null),
                Err(e) => Outcome::error(&e),
            }
        }

        "plugin:prefs|set_editor_layout" => {
            #[derive(serde::Deserialize)]
            #[serde(rename_all = "camelCase")]
            struct Args {
                layout: protocol::EditorLayout,
            }
            let a: Args = match serde_json::from_value(args) {
                Ok(a) => a,
                Err(e) => {
                    return Outcome::BadArgs {
                        command: cmd.to_string(),
                        detail: e.to_string(),
                    }
                }
            };
            match myne_core::plugins::prefs::commands::set_editor_layout_from_host(
                host_ctx(),
                crate::session::state(),
                crate::session::hooks(),
                a.layout,
                vault_io(),
            )
            .await
            {
                Ok(()) => Outcome::ok(&serde_json::Value::Null),
                Err(e) => Outcome::error(&e),
            }
        }

        "plugin:prefs|set_custom_theme" => {
            #[derive(serde::Deserialize)]
            #[serde(rename_all = "camelCase")]
            struct Args {
                custom_theme: Option<String>,
            }
            let a: Args = match serde_json::from_value(args) {
                Ok(a) => a,
                Err(e) => {
                    return Outcome::BadArgs {
                        command: cmd.to_string(),
                        detail: e.to_string(),
                    }
                }
            };
            match myne_core::plugins::prefs::commands::set_custom_theme_from_host(
                host_ctx(),
                crate::session::state(),
                crate::session::hooks(),
                a.custom_theme,
                vault_io(),
            )
            .await
            {
                Ok(()) => Outcome::ok(&serde_json::Value::Null),
                Err(e) => Outcome::error(&e),
            }
        }

        "plugin:prefs|set_item_colors" => {
            #[derive(serde::Deserialize)]
            #[serde(rename_all = "camelCase")]
            struct Args {
                colors: std::collections::BTreeMap<String, String>,
            }
            let a: Args = match serde_json::from_value(args) {
                Ok(a) => a,
                Err(e) => {
                    return Outcome::BadArgs {
                        command: cmd.to_string(),
                        detail: e.to_string(),
                    }
                }
            };
            match myne_core::plugins::prefs::commands::set_item_colors_from_host(
                host_ctx(),
                crate::session::state(),
                crate::session::hooks(),
                a.colors,
                vault_io(),
            )
            .await
            {
                Ok(()) => Outcome::ok(&serde_json::Value::Null),
                Err(e) => Outcome::error(&e),
            }
        }

        "plugin:prefs|set_folder_icons" => {
            #[derive(serde::Deserialize)]
            #[serde(rename_all = "camelCase")]
            struct Args {
                icons: std::collections::BTreeMap<String, String>,
            }
            let a: Args = match serde_json::from_value(args) {
                Ok(a) => a,
                Err(e) => {
                    return Outcome::BadArgs {
                        command: cmd.to_string(),
                        detail: e.to_string(),
                    }
                }
            };
            match myne_core::plugins::prefs::commands::set_folder_icons_from_host(
                host_ctx(),
                crate::session::state(),
                crate::session::hooks(),
                a.icons,
                vault_io(),
            )
            .await
            {
                Ok(()) => Outcome::ok(&serde_json::Value::Null),
                Err(e) => Outcome::error(&e),
            }
        }

        "plugin:prefs|set_device_name" => {
            #[derive(serde::Deserialize)]
            #[serde(rename_all = "camelCase")]
            struct Args {
                device_id_hex: String,
                name: String,
            }
            let a: Args = match serde_json::from_value(args) {
                Ok(a) => a,
                Err(e) => {
                    return Outcome::BadArgs {
                        command: cmd.to_string(),
                        detail: e.to_string(),
                    }
                }
            };
            match myne_core::plugins::prefs::commands::set_device_name_from_host(
                host_ctx(),
                crate::session::state(),
                crate::session::hooks(),
                a.device_id_hex,
                a.name,
                vault_io(),
            )
            .await
            {
                Ok(()) => Outcome::ok(&serde_json::Value::Null),
                Err(e) => Outcome::error(&e),
            }
        }

        "plugin:prefs|vault_set_icon" => {
            #[derive(serde::Deserialize)]
            #[serde(rename_all = "camelCase")]
            struct Args {
                icon: Option<String>,
            }
            let a: Args = match serde_json::from_value(args) {
                Ok(a) => a,
                Err(e) => {
                    return Outcome::BadArgs {
                        command: cmd.to_string(),
                        detail: e.to_string(),
                    }
                }
            };
            match myne_core::plugins::prefs::commands::vault_set_icon_from_host(
                host_ctx(),
                crate::session::state(),
                crate::session::hooks(),
                a.icon,
                vault_io(),
            )
            .await
            {
                Ok(()) => Outcome::ok(&serde_json::Value::Null),
                Err(e) => Outcome::error(&e),
            }
        }

        "plugin:prefs|set_theme" => {
            use myne_core::plugins::prefs::commands::set_theme_from_host;
            #[derive(serde::Deserialize)]
            struct Args {
                // `ThemeChoice` lives in the protocol crate (it is a stored prefs
                // field), re-exported through the commands module only as a `use`.
                theme: Option<protocol::ThemeChoice>,
            }
            let a: Args = match serde_json::from_value(args) {
                Ok(a) => a,
                Err(e) => {
                    return Outcome::BadArgs {
                        command: cmd.to_string(),
                        detail: e.to_string(),
                    }
                }
            };
            match set_theme_from_host(
                host_ctx(),
                crate::session::state(),
                crate::session::hooks(),
                a.theme,
                vault_io(),
            )
            .await
            {
                Ok(()) => Outcome::ok(&()),
                Err(e) => Outcome::error(&e),
            }
        }

        // A SHARED (`ScalarLww`) field, dispatched alongside the device-local
        // `set_theme` on purpose: only shared fields carry a §10.2 field clock,
        // so this is the one that actually exercises the wall-clock port. A probe
        // against `set_theme` alone would have "passed" while proving nothing
        // about the clock — device-local fields are never stamped, by design.
        "plugin:prefs|set_archive_disabled" => {
            use myne_core::plugins::prefs::commands::set_archive_disabled_from_host;
            #[derive(serde::Deserialize)]
            struct Args {
                enabled: bool,
            }
            let a: Args = match serde_json::from_value(args) {
                Ok(a) => a,
                Err(e) => {
                    return Outcome::BadArgs {
                        command: cmd.to_string(),
                        detail: e.to_string(),
                    }
                }
            };
            match set_archive_disabled_from_host(
                host_ctx(),
                crate::session::state(),
                crate::session::hooks(),
                a.enabled,
                vault_io(),
            )
            .await
            {
                Ok(()) => Outcome::ok(&()),
                Err(e) => Outcome::error(&e),
            }
        }

        // Everything else is classified, not guessed.
        other => match classify(other) {
            // Unreachable in practice — a `Dispatched` name with no arm is
            // caught by `dispatched_names_match_the_router` below at test time.
            // Reported as `NotPorted` rather than `unreachable!()` because a
            // panic here traps the instance permanently (`panic = "abort"`),
            // turning a table/router mismatch into a dead vault.
            Class::Dispatched => Outcome::NotPorted {
                command: other.to_string(),
            },
            Class::Unsupported => Outcome::Unsupported {
                operation: other.to_string(),
            },
            Class::Pending => Outcome::NotPorted {
                command: other.to_string(),
            },
        },
    }
}

/// Route one command that arrives with a bulk BYTE payload beside its JSON.
///
/// See [`crate::entry::invoke_with_bytes`] for why the bytes travel outside the
/// JSON at all. This function is the narrow half of that decision: **one command
/// accepts a byte payload, and every other name is refused by name** rather than
/// falling through to [`dispatch`]. Falling through would be worse than an
/// error — it would silently DISCARD the payload, so an import would appear to
/// succeed with the wrong (or empty) content, which is the one failure mode a
/// content-addressed store cannot detect for you.
pub async fn dispatch_with_bytes(cmd: &str, args: serde_json::Value, bytes: Vec<u8>) -> Outcome {
    match cmd {
        "plugin:attachments|attachment_import" => {
            use myne_core::plugins::attachments::commands::{
                attachment_import_from_host, ImportSource,
            };
            /// Only the filename rides in the JSON; the content is the payload.
            #[derive(serde::Deserialize, Default)]
            #[serde(default)]
            struct Args {
                filename: Option<String>,
            }
            let a: Args = match serde_json::from_value(args) {
                Ok(a) => a,
                Err(e) => {
                    return Outcome::BadArgs {
                        command: cmd.to_string(),
                        detail: e.to_string(),
                    }
                }
            };
            // Identical to the `{ kind: "bytes" }` source the JSON path builds —
            // same core, same cap, same re-sniff, same content-addressed id. The
            // only difference is how the bytes got into this process, which is
            // exactly as much as should differ.
            match attachment_import_from_host(
                host_ctx(),
                vault_io(),
                crate::session::state(),
                crate::session::hooks(),
                ImportSource::Bytes {
                    bytes,
                    filename: a.filename,
                },
            )
            .await
            {
                Ok(v) => Outcome::ok(&v),
                Err(e) => Outcome::error(&e),
            }
        }
        other => Outcome::BadArgs {
            command: other.to_string(),
            detail: "this command does not take a byte payload".to_string(),
        },
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::capability::DISPATCHED;

    /// Block on a future without a runtime.
    ///
    /// The router's arms are `async` but none of them awaits anything that can
    /// pend — they are `async` because the ported commands will be. A hand-rolled
    /// poll is enough and avoids pulling a test-only executor into the crate.
    fn block_on<F: std::future::Future>(mut fut: F) -> F::Output {
        use std::task::{Context, Poll, RawWaker, RawWakerVTable, Waker};
        // A waker that does nothing: correct only because nothing here pends.
        // If a future ever returns `Pending`, this panics rather than hanging —
        // a loud failure beats a test that never finishes.
        const VTABLE: RawWakerVTable = RawWakerVTable::new(
            |_| RawWaker::new(std::ptr::null(), &VTABLE),
            |_| {},
            |_| {},
            |_| {},
        );
        let waker = unsafe { Waker::from_raw(RawWaker::new(std::ptr::null(), &VTABLE)) };
        let mut cx = Context::from_waker(&waker);
        // SAFETY: `fut` is owned by this frame and never moved after pinning.
        let mut fut = unsafe { std::pin::Pin::new_unchecked(&mut fut) };
        match fut.as_mut().poll(&mut cx) {
            Poll::Ready(v) => v,
            Poll::Pending => panic!("dispatch future pended; the router has no pending arms yet"),
        }
    }

    #[test]
    fn dispatched_names_match_the_router() {
        // The invariant: every name in `DISPATCHED` has a real arm. Without this
        // the two could drift, and the drift would surface at runtime as a
        // `NotPorted` for a command the table claims is implemented.
        for name in DISPATCHED {
            let outcome = block_on(dispatch(name, serde_json::Value::Null));
            assert!(
                !matches!(outcome, Outcome::NotPorted { .. }),
                "{name} is in DISPATCHED but the router has no arm for it"
            );
        }
    }

    /// Commands the router answers that are **web-only**, and therefore must NOT
    /// be in [`DISPATCHED`].
    ///
    /// The two rosters look like they should agree and deliberately do not.
    /// `DISPATCHED` is cross-checked by `scripts/check-web-command-coverage.mjs`
    /// against the SHARED command surface, and it rejects a name the shared tree
    /// never mentions — "a classification that outlives its command is a decision
    /// nobody can find the subject of". A web-only command has no such subject:
    /// `attachment_object_url` exists because desktop solves the same need with
    /// the `attachment://` URI scheme instead, so there is nothing to be
    /// classified against.
    ///
    /// So the exemption is here, narrow and named, rather than the roster being
    /// widened — which would have made the two guards contradict each other.
    const WEB_ONLY_ARMS: &[&str] = &["plugin:attachments|attachment_object_url"];

    /// The OTHER direction: every arm in the router is named in `DISPATCHED`.
    ///
    /// **This half was missing, and it was missing while `DISPATCHED`'s own doc
    /// comment claimed both directions were covered** — the exact shape this
    /// project has been bitten by twice (a guard whose comment promises more
    /// than its code checks). It was found the honest way: task 84 added two
    /// sync arms, forgot the roster entries, and every test still passed. It
    /// then immediately found a pre-existing case as well.
    ///
    /// What the gap costs is not a broken command — the arm is reached either
    /// way — but a LYING TABLE: `classify` keeps reporting the command as
    /// `Pending`, the coverage guard keeps counting it as unported, and any UI
    /// gate reading the capability answer hides a feature that works.
    ///
    /// Reads its own source rather than deriving from the `match`, because a
    /// `match` is not introspectable at runtime. Narrowly greppy: only a line
    /// whose first character is a quote and which contains `=>` counts, which is
    /// exactly the shape of an arm head here. Note that splitting such a line on
    /// `|` would split INSIDE a name (`plugin:x|y`), so the literals are read by
    /// scanning quote pairs instead.
    #[test]
    fn every_router_arm_is_named_in_the_dispatched_roster() {
        let src = include_str!("dispatch.rs");
        let roster: std::collections::HashSet<&str> = DISPATCHED
            .iter()
            .copied()
            .chain(WEB_ONLY_ARMS.iter().copied())
            .collect();
        let mut missing: Vec<String> = Vec::new();
        for line in src.lines() {
            let t = line.trim_start();
            if !t.starts_with('"') || !t.contains("=>") {
                continue;
            }
            let mut rest = t.split("=>").next().unwrap_or("");
            while let Some(open) = rest.find('"') {
                let after = &rest[open + 1..];
                let Some(close) = after.find('"') else { break };
                let name = &after[..close];
                if name.starts_with("plugin:") && !roster.contains(name) {
                    missing.push(name.to_string());
                }
                rest = &after[close + 1..];
            }
        }
        assert!(
            missing.is_empty(),
            "the router answers these commands but neither `capability::DISPATCHED` nor \
             `WEB_ONLY_ARMS` lists them, so `classify` still reports them unported: {missing:?}"
        );
    }

    /// Every web-only exemption is really an arm — the exemption list cannot rot.
    #[test]
    fn the_web_only_exemptions_are_real_arms() {
        for name in WEB_ONLY_ARMS {
            let outcome = block_on(dispatch(name, serde_json::Value::Null));
            assert!(
                !matches!(outcome, Outcome::NotPorted { .. }),
                "{name} is exempted as web-only but the router has no arm for it"
            );
        }
    }

    #[test]
    fn device_platform_round_trips_the_target_token() {
        let json = block_on(dispatch(
            "plugin:prefs|device_platform",
            serde_json::Value::Null,
        ))
        .to_json();
        let parsed: serde_json::Value = serde_json::from_str(&json).unwrap();
        assert_eq!(parsed["outcome"], "ok");
        // Asserted against the same constant the command reads rather than a
        // hardcoded token, so this test says the same thing on every target
        // (including the `"unknown"` the wasm build produces).
        assert_eq!(parsed["value"], std::env::consts::OS);
    }

    #[test]
    fn a_decided_absent_command_resolves_to_unsupported_not_an_error() {
        let json = block_on(dispatch(
            "plugin:backup|vault_export_backup",
            serde_json::Value::Null,
        ))
        .to_json();
        let parsed: serde_json::Value = serde_json::from_str(&json).unwrap();
        assert_eq!(parsed["outcome"], "unsupported");
        assert_eq!(parsed["operation"], "plugin:backup|vault_export_backup");
    }

    #[test]
    fn an_unported_command_is_loud_and_names_itself() {
        // The example is CHECKED against the capability table rather than
        // trusted. It was `plugin:notes|note_read` until task 13 ported that
        // command and `plugin:themes|themes_list` until task 45 ported this
        // one — each time the assertion below failed for the right reason and
        // named its own fix, which is the whole point: the test is about the
        // property (Pending is loud), not about a name that keeps moving.
        let pending = "plugin:vault-indices|indices_persist";
        assert_eq!(
            classify(pending),
            Class::Pending,
            "pick a still-Pending command for this test; {pending} has moved"
        );

        let json = block_on(dispatch(pending, serde_json::Value::Null)).to_json();
        let parsed: serde_json::Value = serde_json::from_str(&json).unwrap();
        assert_eq!(parsed["outcome"], "notported");
        assert_eq!(parsed["command"], pending);
    }

    #[test]
    fn zero_argument_commands_accept_any_payload_shape() {
        // Tauri permits an absent, empty, or populated payload for a
        // zero-argument command; the router must not be stricter than the thing
        // it replaces, or a call site that works on desktop fails on web.
        for args in [
            serde_json::Value::Null,
            serde_json::json!({}),
            serde_json::json!({ "unexpected": 1 }),
        ] {
            let json = block_on(dispatch("plugin:prefs|device_platform", args)).to_json();
            let parsed: serde_json::Value = serde_json::from_str(&json).unwrap();
            assert_eq!(parsed["outcome"], "ok", "{json}");
        }
    }
}
