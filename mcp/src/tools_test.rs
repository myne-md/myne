// SPDX-License-Identifier: AGPL-3.0-only
//! The compiled tool surface, held to the three rules that make it safe to
//! hand to a model: the set is exactly the thirteen verbs, every schema is
//! internally consistent, and nothing in it names a capability outside the
//! vault.

use crate::tools::catalog;

/// Written out here on purpose rather than derived from [`catalog`]. A roster
/// compared against a second copy of itself cannot fail on the drift it exists
/// for, so the expected set is a literal that a thirteenth verb has to edit.
const EXPECTED_TOOLS: [&str; 13] = [
    "note_search",
    "note_read",
    "vault_list",
    "vault_state",
    "note_create",
    "note_append",
    "note_set_field",
    "note_move",
    "note_edit",
    "attachment_list",
    "attachment_read",
    "calendar_read",
    "view_list",
];

/// Vocabulary that would mean a tool reaches outside the vault. The PRD's rule
/// is "no outbound tool, ever", and the list is compiled in, so it is testable
/// exactly here.
const NON_VAULT_CAPABILITIES: [&str; 18] = [
    "fetch",
    "http",
    "url",
    "mail",
    "shell",
    "process",
    "clipboard",
    "network",
    "socket",
    "download",
    "browser",
    "exec",
    "curl",
    "wget",
    "web",
    "terminal",
    "script",
    "command",
];

fn names() -> Vec<String> {
    catalog()
        .iter()
        .map(|tool| {
            tool["name"]
                .as_str()
                .expect("every tool carries a string name")
                .to_string()
        })
        .collect()
}

#[test]
fn the_catalog_is_exactly_the_thirteen_verbs() {
    let mut found = names();
    found.sort();
    let mut expected = EXPECTED_TOOLS.map(str::to_string).to_vec();
    expected.sort();
    assert_eq!(found, expected);
    assert_eq!(
        catalog().len(),
        13,
        "thirteen is a ceiling, not a start: a verb is an injection surface and a \
         scope-enforcement site, so widening the list edits this number and the guard's \
         roster in the same change"
    );
}

#[test]
fn every_tool_has_a_hand_written_description() {
    for tool in catalog() {
        let name = tool["name"].as_str().unwrap();
        let description = tool["description"]
            .as_str()
            .unwrap_or_else(|| panic!("{name} has no description"));
        assert!(
            description.len() > 40,
            "{name}'s description is too short to tell a caller what it does"
        );
        assert!(
            description.starts_with(char::is_uppercase),
            "{name}'s description must read as prose"
        );
    }
}

#[test]
fn every_schema_is_an_object_whose_required_fields_exist() {
    for tool in catalog() {
        let name = tool["name"].as_str().unwrap();
        let schema = &tool["inputSchema"];
        assert_eq!(schema["type"], "object", "{name} must take an object");
        let properties = schema["properties"]
            .as_object()
            .unwrap_or_else(|| panic!("{name} has no properties map"));
        for required in schema["required"].as_array().into_iter().flatten() {
            let required = required.as_str().unwrap();
            assert!(
                properties.contains_key(required),
                "{name} requires `{required}` but does not declare it"
            );
        }
    }
}

#[test]
fn no_tool_names_a_non_vault_capability() {
    for tool in catalog() {
        // The whole serialised tool, not just name and description: a property
        // description is also text the model reads, and it is the place a
        // capability would be smuggled in later.
        let text = serde_json::to_string(&tool).unwrap().to_lowercase();
        // Whole words, not substrings: "description" contains "script" and
        // "frontmatter" would trip a naive scan, so a substring rule would
        // either be red on the tree today or too narrow to be worth keeping.
        // The limit that leaves is stated rather than implied: a compound such
        // as "websearch" is not caught, which is why the list is reviewed and
        // not only tested.
        let words: Vec<&str> = text
            .split(|c: char| !c.is_alphanumeric())
            .filter(|word| !word.is_empty())
            .collect();
        for capability in NON_VAULT_CAPABILITIES {
            assert!(
                !words.contains(&capability),
                "`{}` names `{capability}`, which is outside the vault",
                tool["name"]
            );
        }
    }
}

#[test]
fn the_anchored_edit_states_the_exactly_once_rule() {
    let edit = catalog()
        .into_iter()
        .find(|tool| tool["name"] == "note_edit")
        .expect("note_edit is part of the surface");
    let description = edit["description"].as_str().unwrap().to_lowercase();
    assert!(
        description.contains("exactly once"),
        "the exactly-once anchor is the difference between this and a body replace, \
         and it must be visible in the description"
    );
    assert!(
        description.contains("refused"),
        "the caller must be told that a non-unique anchor is refused rather than placed"
    );
    let source = edit["inputSchema"]["properties"]["source"]["description"]
        .as_str()
        .unwrap()
        .to_lowercase();
    assert!(
        source.contains("exactly once"),
        "the anchor rule belongs on the argument it governs, where a schema reader lands"
    );
}

#[test]
fn no_tool_is_declared_twice() {
    let mut seen: Vec<String> = Vec::new();
    for name in names() {
        assert!(!seen.contains(&name), "duplicate tool name: {name}");
        seen.push(name);
    }
}

/// The verbs whose answer is a list rather than an object. Written out, like
/// [`EXPECTED_TOOLS`]: a roster derived from the thing it checks cannot fail.
const LIST_SHAPED_TOOLS: [&str; 5] = [
    "note_search",
    "vault_list",
    "attachment_list",
    "calendar_read",
    "view_list",
];

/// A list answer is nested under `items`, because `structuredContent` must be an
/// object (myne-md/myne#1106), so the schema has to say where the list is.
#[test]
fn a_list_shaped_answer_declares_an_object_schema_with_items() {
    for name in LIST_SHAPED_TOOLS {
        let tool = catalog()
            .into_iter()
            .find(|tool| tool["name"] == name)
            .unwrap_or_else(|| panic!("{name} is not in the catalog"));
        let schema = &tool["outputSchema"];
        assert_eq!(
            schema["type"], "object",
            "{name} must declare an object schema: structuredContent is not a list"
        );
        assert_eq!(
            schema["properties"]["items"]["type"], "array",
            "{name} answers with a list, so its schema has to say where the list is"
        );
    }
}

/// And nothing may declare a non-object `outputSchema`: a client validates against
/// it, so a list-typed one would licence the payload that breaks the call.
#[test]
fn no_output_schema_is_anything_but_an_object() {
    for tool in catalog() {
        let name = tool["name"].as_str().unwrap();
        let Some(schema) = tool.get("outputSchema") else {
            continue;
        };
        assert_eq!(
            schema["type"], "object",
            "{name} declares a non-object outputSchema"
        );
        // Not style: a closed schema this file got wrong fails EVERY call in a
        // validating client.
        assert!(
            schema.get("additionalProperties").is_none(),
            "{name} must not close its outputSchema: a forgotten field would then \
             reject a valid answer"
        );
    }
}
