// SPDX-License-Identifier: AGPL-3.0-only
//! The compiled-in tool surface: twelve verbs, declared as data.
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
//! **Thirteen is a ceiling, not a starting point.** Every tool is an injection
//! surface and a scope-enforcement site, so a fourteenth verb is a deliberate
//! cost rather than a convenience. Four reads joined the eight in
//! myne-md/myne#1077, and the shape they follow is the one rule that decided
//! them: **a verb may read a file by id, and no verb may name a path or a URL.**
//! A by-id read stays inside the vault the grant covers; a path argument would
//! let a caller name a file outside it, and a URL argument would make this
//! process the fetch leg of the trifecta. `note_set_field` was advertised here
//! for a while with no arm to serve it, which is why the surface has a three-way
//! check (`mcp/src/surface_test.rs`) rather than a comment; it is served now, and
//! what makes it safe is the `view_id` it carries — the host's field write is
//! view-scoped, and a verb with no view would have had to invent that authority.
//! Three write classes are absent by decision, not by
//! omission: delete (a read is recoverable harm, a delete is not), rename (it
//! rewrites the notes that link to the target, and those notes are outside any
//! grant), and whole-body replace (two devices' splices both survive a merge and
//! the note comes back containing itself twice).
//!
//! **No tool reaches outside the vault.** No fetch, no mail, no shell, no
//! clipboard, no URL dereference, no path argument. The moment one does,
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
                the match, never the whole note. A folder argument outside the granted scope is \
                refused; a folder that does not exist is not, and answers an empty list, so an \
                empty result and a mistyped folder look the same. Read-only.",
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
            },
            // The hit list is nested under `items`: `structuredContent` is an object.
            "outputSchema": {
                "type": "object",
                "properties": {
                    "items": {
                        "type": "array",
                        "description": "One entry per match, in ranked order.",
                        "items": {
                            "type": "object",
                            "properties": {
                                "noteId": {
                                    "type": "string",
                                    "description": "The id to hand to note_read."
                                },
                                "title": {
                                    "type": ["string", "null"],
                                    "description": "The note's title, or null when it has none."
                                },
                                "folder": {
                                    "type": ["string", "null"],
                                    "description": "The note's folder as the note carries it, or null at the vault root."
                                },
                                "excerpt": {
                                    "type": "string",
                                    "description": "A bounded window of the note around the match."
                                }
                            },
                            "required": ["noteId", "excerpt"]
                        }
                    }
                },
                "required": ["items"]
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
            "description": "List the folders this connection may read that HOLD notes, with the \
                number of notes in each. A folder with no notes is not listed, so this is fewer \
                rows than the folder count `vault_state` reports, which counts folders that exist. \
                The vault root is the row whose folder is null. Read-only.",
            "inputSchema": {
                "type": "object",
                "properties": {},
                "additionalProperties": false
            },
            // As `note_search`: the folder list is nested under `items`.
            "outputSchema": {
                "type": "object",
                "properties": {
                    "items": {
                        "type": "array",
                        "description": "One entry per folder in the read scope.",
                        "items": {
                            "type": "object",
                            "properties": {
                                "folder": {
                                    "type": ["string", "null"],
                                    "description": "The folder path, or null for the vault root."
                                },
                                "count": {
                                    "type": "integer",
                                    "minimum": 0,
                                    "description": "Live notes whose folder is exactly this one."
                                }
                            },
                            "required": ["folder", "count"]
                        }
                    }
                },
                "required": ["items"]
            }
        }),
        json!({
            "name": "vault_state",
            "description": "Report whether the vault is unlocked, whether external access is \
                enabled, how many notes and folders this connection may read, and how many \
                folders the user left out. The folder count includes folders that exist and hold \
                no notes, so it is larger than the number of rows `vault_list` returns. Read-only, \
                and safe to call before any other tool.",
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
            "description": "Set one frontmatter field on a note, leaving every other field and \
                the note body untouched. The write is authorised by a saved view: the view must \
                be approved on this device and must declare the field writable, so call \
                view_list first and pass the id it reports. The five fields that move a note \
                out of Myne's note list (trashed, deleted, archived, template, conflict) are \
                refused, and `folder` is refused because that is a move: this surface has no \
                delete and no second way to move a note.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "note_id": {
                        "type": "string",
                        "description": "The id of the note to change."
                    },
                    "view_id": {
                        "type": "string",
                        "description": "The saved view whose approved declaration authorises this \
                            write, as view_list reports it."
                    },
                    "field": {
                        "type": "string",
                        "description": "Name of the frontmatter field to set, as a plain key. \
                            `folder` is refused: call note_move, which checks both the folder the \
                            note leaves and the one it lands in."
                    },
                    "value": {
                        "type": "string",
                        "description": "Value to give the field."
                    },
                    "expected_value": {
                        "type": "string",
                        "description": "The value you believe is on disk. Omit it to mean the \
                            field is not there at all, which is a question about the key: a \
                            field holding a multi-line value counts as there, so omitting the \
                            parameter will not clear it. A mismatch is refused rather than \
                            overwritten, so a concurrent change to the same field cannot be \
                            lost."
                    }
                },
                "required": ["note_id", "view_id", "field", "value"],
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
        json!({
            "name": "attachment_list",
            "description": "List the files this connection may read: each file's id, its \
                filename and the folder it is filed in. A file's scope is the folder it is \
                filed in, so a file in a folder the user left out is not listed at all. \
                Read-only.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "folder": {
                        "type": "string",
                        "description": "Restrict the listing to exactly this folder path. It \
                            must be inside the granted read scope; its subfolders are not \
                            included."
                    }
                },
                "additionalProperties": false
            },
            // A list answer is nested under `items`; the element shape is left open
            // so a validating client can never reject a field this file forgot.
            "outputSchema": {
                "type": "object",
                "properties": {
                    "items": {
                        "type": "array",
                        "description": "One entry per file in the read scope: its id, its filename and the folder it is filed in."
                    }
                },
                "required": ["items"]
            }
        }),
        json!({
            "name": "attachment_read",
            "description": "Read the text extracted from one file, by its id. Never the \
                file's bytes: an image yields its OCR text, a PDF its text layer, and a format \
                nothing was extracted from returns null rather than an empty string. A file in \
                a folder the user left out is refused. Read-only.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "attachment_id": {
                        "type": "string",
                        "description": "The id of the file, as attachment_list returned it."
                    }
                },
                "required": ["attachment_id"],
                "additionalProperties": false
            },
            "outputSchema": {
                "type": "object",
                "properties": {
                    "text": {
                        "type": ["string", "null"],
                        "description": "The extracted text, or null when nothing was extracted."
                    }
                }
            }
        }),
        json!({
            "name": "calendar_read",
            "description": "Read the calendar between two days, inclusive, bounded to at most \
                366 days. Each row names the note the event lives in, its start, its end and \
                whether it repeats, and rows for notes outside the granted read scope are \
                dropped. Read-only.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "from": {
                        "type": "string",
                        "description": "First day of the window, as YYYY-MM-DD."
                    },
                    "to": {
                        "type": "string",
                        "description": "Last day of the window, as YYYY-MM-DD. At most 366 \
                            days after from."
                    }
                },
                "required": ["from", "to"],
                "additionalProperties": false
            },
            // `structuredContent` is a JSON OBJECT, so a list answer is nested under
            // `items` and declared here. The element shape is left open on purpose:
            // a client that validates must never be handed a schema this file got
            // wrong, which would fail the call it exists to protect.
            "outputSchema": {
                "type": "object",
                "properties": {
                    "items": {
                        "type": "array",
                        "description": "One entry per calendar occurrence inside the window, each naming the note it lives in."
                    }
                },
                "required": ["items"]
            }
        }),
        json!({
            "name": "view_list",
            "description": "List the vault's saved views: each view's id, its name, the kind of \
                view it is, whether this device has approved it, and which frontmatter \
                fields it declares writable. That last pair is what note_set_field needs: \
                an unapproved view cannot authorise a write, and a view authorises only the \
                fields it declares. Listing does not run the view, so this returns no note \
                ids and reads no note. Read-only.",
            "inputSchema": {
                "type": "object",
                "properties": {},
                "additionalProperties": false
            },
            "outputSchema": {
                "type": "object",
                "properties": {
                    "items": {
                        "type": "array",
                        "description": "One entry per saved view: its id, its name, its kind, \
                            whether this device approved it, and the fields it declares writable."
                    }
                },
                "required": ["items"]
            }
        }),
    ]
}
