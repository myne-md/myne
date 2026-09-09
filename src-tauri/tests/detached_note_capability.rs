// Capability-shape test for the detached (pop-out) note window (myne-md/myne#677, epic #173).
//
// A text grep over the capability JSON is fooled by its own description prose (which names
// `prefs:allow-set-*` to say it is withheld), so the grant/deny shape is asserted STRUCTURALLY:
// parse the JSON and inspect the `permissions` array. Both directions are checked, per the
// repo-root CLAUDE.md guard discipline: the split-pane editor surface is present, and every
// privileged surface a detached window must not hold (prefs setters per decision 0136,
// vault-lifecycle, egress/management, window/webview create) is absent.

use serde_json::Value;
use std::fs;

fn load_capability() -> Value {
    let path = concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/capabilities/detached-note.json"
    );
    let raw = fs::read_to_string(path).expect("read capabilities/detached-note.json");
    serde_json::from_str(&raw).expect("parse detached-note.json as JSON")
}

/// The identifier of each permission entry (a bare string, or the `identifier` of a scoped object).
fn permission_identifiers(cap: &Value) -> Vec<String> {
    cap["permissions"]
        .as_array()
        .expect("capability has a permissions array")
        .iter()
        .map(|entry| match entry {
            Value::String(s) => s.clone(),
            Value::Object(o) => o
                .get("identifier")
                .and_then(Value::as_str)
                .expect("scoped permission entry has an identifier")
                .to_string(),
            other => panic!("unexpected permission entry shape: {other}"),
        })
        .collect()
}

#[test]
fn scoped_to_the_note_glob_never_main() {
    let cap = load_capability();
    assert_eq!(cap["identifier"], "detached-note");
    let windows = cap["windows"].as_array().expect("windows array");
    assert_eq!(windows.len(), 1, "exactly one window pattern");
    assert_eq!(
        windows[0], "note-*",
        "the detached capability must be scoped to the note-* label glob (SYNC-1), never main"
    );
}

#[test]
fn grants_the_split_pane_editor_surface() {
    let ids = permission_identifiers(&load_capability());
    for required in [
        "prefs:allow-prefs-read",
        "notes:detached",
        "attachments:detached-read",
        "themes:detached-read",
        "sync:detached-status",
        "snapshots:default",
        "vault-indices:default",
        "agent:default",
        "spell:default",
        "pdf-export:default",
        "clipboard-manager:allow-write-text",
    ] {
        assert!(
            ids.iter().any(|id| id == required),
            "detached capability is missing required editor grant: {required}"
        );
    }
}

#[test]
fn withholds_prefs_write_and_every_privileged_surface() {
    let ids = permission_identifiers(&load_capability());

    // Decision 0136: no preference setter, and not the bundle that carries them.
    for id in &ids {
        assert!(
            !id.starts_with("prefs:allow-set"),
            "detached window must not receive any prefs setter (decision 0136): {id}"
        );
        assert_ne!(
            id, "prefs:default",
            "detached window must not receive prefs:default (it bundles the setters)"
        );
    }

    // No vault-lifecycle, no management/egress, no window-create surface. Namespace-exact so
    // pdf-export / secret-export are not confused with the `export` plugin.
    let forbidden_namespaces = [
        "vault-creation",
        "vault-unlock",
        "vault-recover",
        "vault-change-password",
        "vault-delete",
        "vault-migrate",
        "vault-repair",
        "quick-unlock",
        "importer",
        "backup",
        "export",
        "secret-export",
        "clipper-pairing",
        "cli-bridge",
        "deep-link",
        "screen-capture",
        "workspace",
        "graph-layout",
    ];
    for id in &ids {
        let namespace = id.split(':').next().unwrap_or_default();
        assert!(
            !forbidden_namespaces.contains(&namespace),
            "detached window must not receive a `{namespace}` grant: {id}"
        );
    }

    // Page context in the detached window may not create further webviews.
    assert!(
        !ids.iter().any(|id| id.starts_with("core:webview")),
        "detached window must not receive a webview-create grant"
    );
}

/// The permission identifiers listed in the `[[set]]` whose `identifier =
/// "detached"`, read from the TOML text. Deliberately NOT via a `toml` crate: a
/// dev-dependency here is a dependency-surface change. Scoped to the block
/// between that set's identifier line and the next `[[` table header, so the
/// individual `[[permission]]` blocks (which name every command) are excluded.
fn detached_notes_set_permissions(toml: &str) -> Vec<&str> {
    let after_id = toml
        .split_once("identifier = \"detached\"")
        .expect("permissions/notes/default.toml has a [[set]] identifier = \"detached\"")
        .1;
    let block = after_id.split("\n[[").next().unwrap_or(after_id);
    block
        .lines()
        .filter_map(|line| {
            let t = line.trim().trim_end_matches(',');
            t.strip_prefix('"').and_then(|s| s.strip_suffix('"'))
        })
        .collect()
}

#[test]
fn the_detached_notes_set_withholds_delete_and_batch_rewrite() {
    // #677 task-1 AC6, the deny-direction on the notes SET itself. The capability
    // JSON only names `notes:detached`; the SET's contents live in the notes
    // permission TOML, so a future edit adding note_delete there would slip past
    // every JSON-level check above with the window still barred from deleting.
    let path = concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/permissions/notes/default.toml"
    );
    let toml = fs::read_to_string(path).expect("read permissions/notes/default.toml");
    let set = detached_notes_set_permissions(&toml);

    // Non-vacuity: the extraction really found the set (a mis-scoped extraction
    // returning [] would pass the deny checks below for the wrong reason).
    assert!(
        set.contains(&"allow-note-update"),
        "extraction did not find the detached set's permissions (expected allow-note-update)"
    );

    for withheld in ["allow-note-delete", "allow-note-write-batch-transactional"] {
        assert!(
            !set.contains(&withheld),
            "the notes:detached set must withhold {withheld} (#677 task-1 AC6, decision 0136)"
        );
    }
}
