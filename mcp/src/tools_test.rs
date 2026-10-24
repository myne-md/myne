// SPDX-License-Identifier: AGPL-3.0
//! The compiled tool surface, held to the three rules that make it safe to
//! hand to a model: the set is exactly the nine verbs, every schema is
//! internally consistent, and nothing in it names a capability outside the
//! vault.

use crate::tools::catalog;

/// Written out here on purpose rather than derived from [`catalog`]. A roster
/// compared against a second copy of itself cannot fail on the drift it exists
/// for, so the expected set is a literal that a tenth verb has to edit.
const EXPECTED_TOOLS: [&str; 9] = [
    "note_search",
    "note_read",
    "vault_list",
    "vault_state",
    "note_create",
    "note_append",
    "note_set_field",
    "note_move",
    "note_edit",
];

/// Vocabulary that would mean a tool reaches outside the vault. The PRD's rule
/// is "no outbound tool, ever", and the list is compiled in, so it is testable
/// exactly here.
const NON_VAULT_CAPABILITIES: [&str; 19] = [
    "fetch",
    "http",
    "url",
    "mail",
    "shell",
    "process",
    "clipboard",
    "attachment",
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
fn the_catalog_is_exactly_the_nine_verbs() {
    let mut found = names();
    found.sort();
    let mut expected = EXPECTED_TOOLS.map(str::to_string).to_vec();
    expected.sort();
    assert_eq!(found, expected);
    assert_eq!(catalog().len(), 9, "nine is a ceiling, not a start");
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
