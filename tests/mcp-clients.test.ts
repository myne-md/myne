// The client roster and the snippets step 2 hands over
// (mcp external access rework, myne-md/myne#1052).
//
// What is worth asserting here is the part no compiler can: each client's snippet
// has to be THAT client's shape. A single snippet reused across clients is the
// failure this module exists to remove, because the wrong one is accepted silently
// and the connection never appears. So the expected strings below are written out
// in full rather than derived from the builder: a derived expectation would agree
// with any bug the builder grew.

import { describe, expect, it } from "vitest";
import {
  DEFAULT_CONNECTION_NAME,
  GENERIC_CLIENT,
  MCP_CLIENT_PRESETS,
  MCP_CONNECTION_ENV,
  mcpSnippet,
  presetById,
} from "../src/lib/mcp-clients";

describe("the client roster", () => {
  it("offers six first-class clients and no duplicate ids", () => {
    // Six is what the step-1 grid draws, three across and two down, with no
    // "show more" to hide the rest behind.
    expect(MCP_CLIENT_PRESETS).toHaveLength(6);
    const ids = MCP_CLIENT_PRESETS.map((preset) => preset.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("spells OpenCode's nested local-server shape, not the old flat one", () => {
    // Verified against opencode.ai/docs/mcp-servers on 2026-11-10: V2 nests the
    // roster under `mcp.servers`, spells a stdio server `type: "local"` with the
    // command as an array, and takes `environment` where the others take `env`.
    // Each of those four is a copy-paste failure on its own.
    const preset = presetById("opencode");
    expect(preset).toBeDefined();
    expect(mcpSnippet(preset!, "myne")).toBe(
      '{"$schema":"https://opencode.ai/config.json","mcp":{"servers":{"myne":{"type":"local","command":["myne-mcp"],"environment":{"MYNE_MCP_CONNECTION":"myne"}}}}}',
    );
    expect(preset!.source).toContain("opencode.ai");
  });

  it("carries a source and a verification date on every entry", () => {
    // The shape of another program's configuration cannot be checked by a guard in
    // this repository, so the honest thing an entry can carry is where it was read
    // and when. An entry missing either is a remembered shape.
    for (const preset of [...MCP_CLIENT_PRESETS, GENERIC_CLIENT]) {
      expect(preset.source).toMatch(/^https:\/\//);
      expect(preset.verified).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(preset.name.length).toBeGreaterThan(0);
    }
  });

  it("resolves an id back to its preset and refuses an unknown one", () => {
    expect(presetById("cursor")?.name).toBe("Cursor");
    expect(presetById(GENERIC_CLIENT.id)?.id).toBe("other");
    expect(presetById("nope")).toBeNull();
  });
});

describe("the snippets", () => {
  it("emits the JSON mcpServers shape for Claude Desktop and Claude Code", () => {
    const expected =
      '{"mcpServers":{"myne":{"command":"myne-mcp","env":{"MYNE_MCP_CONNECTION":"claude-desktop"}}}}';
    for (const id of ["claude-desktop", "claude-code"]) {
      const preset = presetById(id);
      expect(preset).not.toBeNull();
      expect(mcpSnippet(preset!, "claude-desktop")).toBe(expected);
    }
  });

  it("adds the required stdio type for Cursor", () => {
    expect(mcpSnippet(presetById("cursor")!, "claude-desktop")).toBe(
      '{"mcpServers":{"myne":{"type":"stdio","command":"myne-mcp","env":{"MYNE_MCP_CONNECTION":"claude-desktop"}}}}',
    );
  });

  it("uses the native `servers` key and the stdio type for VS Code", () => {
    // VS Code's native file is a different shape from its portable Copilot file,
    // and pasting the portable one into `.vscode/mcp.json` is silently ignored.
    expect(mcpSnippet(presetById("vscode")!, "claude-desktop")).toBe(
      '{"servers":{"myne":{"type":"stdio","command":"myne-mcp","env":{"MYNE_MCP_CONNECTION":"claude-desktop"}}}}',
    );
  });

  it("emits YAML with mcp_servers for Hermes", () => {
    expect(mcpSnippet(presetById("hermes")!, "claude-desktop")).toBe(
      'mcp_servers:\n  myne:\n    command: "myne-mcp"\n    env:\n      MYNE_MCP_CONNECTION: "claude-desktop"',
    );
  });

  it("emits a runnable command for a client nobody listed", () => {
    expect(mcpSnippet(GENERIC_CLIENT, DEFAULT_CONNECTION_NAME)).toBe(
      `${MCP_CONNECTION_ENV}=${DEFAULT_CONNECTION_NAME} myne-mcp`,
    );
  });

  it("splices the connection name into every shape", () => {
    // The name is what the grant is keyed on, so a snippet that hard-coded it
    // would approve one connection and configure another.
    for (const preset of [...MCP_CLIENT_PRESETS, GENERIC_CLIENT]) {
      expect(mcpSnippet(preset, "a-different-name")).toContain("a-different-name");
    }
  });
});
