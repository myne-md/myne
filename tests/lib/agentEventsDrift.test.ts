// The agent's "notes changed" event is written twice, once per language
// (myne-md/myne#913). That is the shape that drifts silently: the Rust side emits
// a name nobody listens to and the panel simply never refreshes, with no error
// anywhere. This test is the thing that fails instead.

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const root = new URL("../../", import.meta.url);

function read(path: string): string {
  return readFileSync(new URL(path, root), "utf8");
}

describe("the agent notes-changed event", () => {
  it("carries the same wire name in Rust and TypeScript", () => {
    const rust = read("core/src/plugins/agent/host_commands.rs");
    const ts = read("src/lib/agent-events.ts");

    const rustName = /pub const AGENT_NOTES_CHANGED_EVENT: &str = "([^"]+)"/.exec(rust)?.[1];
    const tsName = /export const AGENT_NOTES_CHANGED_EVENT = "([^"]+)"/.exec(ts)?.[1];

    expect(rustName).toBeDefined();
    expect(tsName).toBeDefined();
    expect(tsName).toBe(rustName);
  });

  it("is emitted by the apply host, not merely declared", () => {
    const rust = read("core/src/plugins/agent/host_commands.rs");
    expect(rust).toContain("notify.emit(AGENT_NOTES_CHANGED_EVENT");
  });

  it("is listened for in the editor that owns the note list", () => {
    const editor = read("src/screens/Editor.tsx");
    expect(editor).toContain("listen(AGENT_NOTES_CHANGED_EVENT");
    // And it must reach the SAME refresh the CLI path uses, not a second one that
    // could refresh something else.
    expect(editor).toContain("refreshAfterExternalWrite()");
  });
});
