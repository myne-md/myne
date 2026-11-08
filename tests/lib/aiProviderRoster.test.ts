// The closed set of remote AI provider wire values, held together across the
// four places that write it out by hand (myne-md/myne#970 review, D8).
//
// `ai_provider` is a CLOSED enum in `agent-tooling/docs/spec/protocol.md` §9.5.2, and growing
// it means editing the same four names in four files:
//
//   1. `core/src/plugins/prefs/commands.rs`: `KNOWN_AI_PROVIDERS`, the only
//      copy that VALIDATES a write, and the reference the host table is already
//      tested against (`provider_transport.rs`, `the_host_table_and_the_accepted
//      _provider_names_agree`).
//   2. `src/components/settings/AiPanel.tsx`: `REMOTE_PROVIDERS`, the desktop
//      consent picker.
//   3. `mobile/src/app/flows/SettingsSheet.tsx`: `KNOWN_PROVIDERS`, the mobile
//      picker and the root row's label lookup.
//   4. `myne-test-vectors`: the schema enum and a vector pair (a separate repo,
//      held by that repo's own `check` and by the byte-level vector runner).
//
// Only the Rust pair was checked. A client list that omits a name the host
// accepts renders that provider as "None" while the host would honour it, and
// nothing fails: the setting looks unset on the client that dropped it. So this
// reads the two TypeScript lists and the Rust constant and compares all three,
// the mechanism `tests/lib/chatHistoryBudget.test.ts` already uses for a
// constant that exists on both sides of the IPC boundary.
//
// It reads SOURCE rather than importing the modules, deliberately for the Rust
// side, and imports the two TS lists only as text as well: `REMOTE_PROVIDERS` is
// module-private in `AiPanel.tsx`, and exporting it to be tested would make the
// test assert on an export rather than on the list the picker renders.

import { describe, expect, it } from "vitest";

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const REPO = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const read = (...parts: string[]) => readFileSync(join(REPO, ...parts), "utf8");

/**
 * The names inside a `const NAME … = [ "a", "b" ]` in TypeScript, or the values
 * of one key when the list holds objects (`{ wire, label }`, as the desktop
 * picker's does: reading bare strings there would compare the labels too).
 */
function tsList(source: string, name: string, where: string, key?: string): string[] {
  const start = source.indexOf(name);
  if (start < 0) {
    throw new Error(
      `${name} not found in ${where}. A missing input compares equal to ` +
        `nothing and the test would pass having read no source at all.`,
    );
  }
  // The array's own `[`, not the one in the type annotation: `REMOTE_PROVIDERS`
  // is declared `{ wire: string; label: string }[] = [`, so the first bracket
  // after the name closes the type and the list starts at the `= [` after it.
  const eq = source.indexOf("= [", start);
  const open = eq < 0 ? source.indexOf("[", start) : eq + 2;
  const close = source.indexOf("]", open);
  const body = source.slice(open + 1, close);
  const pattern = key === undefined ? /"([^"]+)"/g : new RegExp(`${key}:\\s*"([^"]+)"`, "g");
  return [...body.matchAll(pattern)].map((m) => m[1]!);
}

/** The names inside `pub const NAME: &[&str] = &["a", "b"];` in the Rust source. */
function rustList(source: string, name: string): string[] {
  const m = new RegExp(
    `pub const ${name}: &\\[&str\\]\\s*=\\s*&\\[([^\\]]+)\\]`,
  ).exec(source);
  if (m === null) {
    throw new Error(
      `${name} not found in core/src/plugins/prefs/commands.rs. If it moved or ` +
        `was renamed, update this test rather than deleting it.`,
    );
  }
  return [...m[1]!.matchAll(/"([^"]+)"/g)].map((s) => s[1]!);
}

describe("the remote AI provider roster is one set in three files", () => {
  const rust = rustList(read("core", "src", "plugins", "prefs", "commands.rs"), "KNOWN_AI_PROVIDERS");
  const desktop = tsList(
    read("src", "components", "settings", "AiPanel.tsx"),
    "REMOTE_PROVIDERS",
    "src/components/settings/AiPanel.tsx",
    "wire",
  );
  const mobile = tsList(
    read("mobile", "src", "app", "flows", "SettingsSheet.tsx"),
    "KNOWN_PROVIDERS",
    "mobile/src/app/flows/SettingsSheet.tsx",
  );

  it("names the same providers on the host, the desktop and the phone", () => {
    expect(desktop).toEqual(rust);
    expect(mobile).toEqual(rust);
  });

  it("is the four names the spec pins, in the order the picker shows them", () => {
    // Pinned as a literal on purpose: the three-way comparison above is
    // satisfied by four wrong names in three files, and this is the assertion
    // that would notice. The order is the picker's, so a provider added to the
    // spec in a different position is a visible decision rather than a merge.
    expect(rust).toEqual(["ollama-cloud", "openrouter", "opencode-zen", "opencode-go"]);
  });
});
