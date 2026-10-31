// SPDX-License-Identifier: AGPL-3.0
//! The compiled-in tool surface: nine verbs, declared as data.
//!
//! **This file is the list, and it is the ONLY file a guard reads to answer
//! "what can an MCP connection do?"** `scripts/check-mcp-tool-surface.mjs` parses
//! the declarations below rather than a document about them, so the answer cannot
//! be a second opinion: a tool that exists here exists, and a capability named in
//! a description here is a capability the surface offers.
//!
//! **The list is a constant expression, and that is a security property.** Tool
//! descriptions are what a model decides to trust, so a description that a note
//! could contribute text to is an injection path into every later call. Nothing
//! here reads the vault, the filesystem, the environment or the client's frame;
//! the string literals below are the whole input, and the guard fails on any
//! `format!`, `concat!`, `include_str!` or `env!` in this file so the property is
//! checked rather than assumed.
//!
//! **Nine is a ceiling, not a starting point.** Every tool is an injection
//! surface and a scope-enforcement site, so a tenth verb is a deliberate cost
//! rather than a convenience. Three write classes are absent by decision, not by
//! omission: delete (a read is recoverable harm, a delete is not), rename (it
//! rewrites the notes that link to the target, and those notes are outside any
//! grant), and whole-body replace (two devices' splices both survive a merge and
//! the note comes back containing itself twice).
//!
//! **No tool reaches outside the vault.** No fetch, no mail, no shell, no
//! clipboard, no URL dereference, no attachment access. The moment one does,
//! Myne assembles all three legs of the lethal trifecta itself and becomes the
//! exfiltration path rather than the data source. Two witnesses hold that:
//! `tools_test.rs` scans the compiled list for the vocabulary, and
//! `scripts/check-mcp-tool-surface.mjs` does the same from outside the build so a
//! `cargo test` nobody ran cannot be the only gate.
//!
//! Scope is named in the descriptions because the caller must be able to tell a
//! refusal from a bug, but *enforcement* lives host-side
//! (`core/src/plugins/mcp/`). The words "granted read scope" and "write grant"
//! here are a promise about what the host will check, not a check this process
//! performs.

use serde_json::{json, Value};

/// The tool list, as the wire wants it: name, description, input schema.
pub fn catalog() -> Vec<Value> {
    vec![
        json!({
            "name": "note_search",
            "description": "Search the notes inside the folders this connection may read. \
                Returns each match with its note id, title, folder and a short excerpt around \
                the match, never the whole note. Read-only.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "query": {
                        "type": "string",
                        "description": "Text to look for in note titles and bodies."
                    },
                    "folder": {
                        "type": "string",
                        "description": "Restrict the search to this folder path. It must be inside \
                            the granted read scope."
                    },
                    "limit": {
                        "type": "integer",
                        "minimum": 1,
                        "description": "Maximum number of matches to return."
                    }
                },
                "required": ["query"],
                "additionalProperties": false
            }
        }),
        json!({
            "name": "note_read",
            "description": "Read one note in full by its id: its frontmatter and its markdown \
                body. A note outside the folders this connection may read is refused rather \
                than returned. Read-only.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "note_id": {
                        "type": "string",
                        "description": "The id of the note to read."
                    }
                },
                "required": ["note_id"],
                "additionalProperties": false
            }
        }),
        json!({
            "name": "vault_list",
            "description": "List the folders this connection may read, with the number of notes \
                in each. Gives the shape of the vault in one answer, without reading note text. \
                Read-only.",
            "inputSchema": {
                "type": "object",
                "properties": {},
                "additionalProperties": false
            }
        }),
        json!({
            "name": "vault_state",
            "description": "Report whether the vault is unlocked, whether external access is \
                enabled, how many notes and folders this connection may read, and how many \
                folders the user left out. Read-only, and safe to call before any other tool.",
            "inputSchema": {
                "type": "object",
                "properties": {},
                "additionalProperties": false
            }
        }),
        json!({
            "name": "note_create",
            "description": "Create a note with the given title and markdown body inside one of \
                the folders this connection may write to. Returns the new note's id. Refused \
                when the folder is not in the write grant.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "folder": {
                        "type": "string",
                        "description": "Folder path for the new note. It must be inside the \
                            write grant."
                    },
                    "title": {
                        "type": "string",
                        "description": "Title of the new note."
                    },
                    "body": {
                        "type": "string",
                        "description": "Markdown body of the new note."
                    }
                },
                "required": ["folder", "title", "body"],
                "additionalProperties": false
            }
        }),
        json!({
            "name": "note_append",
            "description": "Append markdown to the end of an existing note, leaving everything \
                already in it unchanged. Refused when the note is outside the folders this \
                connection may write to.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "note_id": {
                        "type": "string",
                        "description": "The id of the note to append to."
                    },
                    "markdown": {
                        "type": "string",
                        "description": "Markdown to add at the end of the note."
                    }
                },
                "required": ["note_id", "markdown"],
                "additionalProperties": false
            }
        }),
        json!({
            "name": "note_set_field",
            "description": "Set one frontmatter field on an existing note, leaving every other \
                field and the note body untouched. An absent field is added and an existing \
                field is replaced. Refused when the note is outside the write grant.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "note_id": {
                        "type": "string",
                        "description": "The id of the note to change."
                    },
                    "field": {
                        "type": "string",
                        "description": "Name of the frontmatter field to set."
                    },
                    "value": {
                        "type": "string",
                        "description": "Value to give the field."
                    }
                },
                "required": ["note_id", "field", "value"],
                "additionalProperties": false
            }
        }),
        json!({
            "name": "note_move",
            "description": "Move a note to another folder, keeping its id and its contents. The \
                note's current folder and the destination must both be in the write grant.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "note_id": {
                        "type": "string",
                        "description": "The id of the note to move."
                    },
                    "folder": {
                        "type": "string",
                        "description": "Destination folder path. It must be inside the write \
                            grant."
                    }
                },
                "required": ["note_id", "folder"],
                "additionalProperties": false
            }
        }),
        json!({
            "name": "note_edit",
            "description": "Replace one passage of a note's body, located by the exact text it \
                currently contains. The source text must occur exactly once in the note: if it \
                occurs zero times, or more than once, the call is refused and the note is left \
                unchanged. This is the only way to change prose that is already there; the rest \
                of the note is never rewritten.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "note_id": {
                        "type": "string",
                        "description": "The id of the note to change."
                    },
                    "source": {
                        "type": "string",
                        "description": "The exact text to find. It must occur exactly once in \
                            the note; zero occurrences or multiple occurrences are refused \
                            rather than placed approximately."
                    },
                    "replacement": {
                        "type": "string",
                        "description": "Text that replaces the source passage, and nothing else."
                    }
                },
                "required": ["note_id", "source", "replacement"],
                "additionalProperties": false
            }
        }),
    ]
}
