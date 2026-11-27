// The client roster and the snippets step 2 hands over
// (mcp external access rework, myne-md/myne#1052).
//
// What is worth asserting here is the part no compiler can: each client's snippet
// has to be THAT client's shape. A single snippet reused across clients is the
// failure this module exists to remove, because the wrong one is accepted silently
// and the connection never appears. So the expected strings below are written out
// in full rather than derived from the builder: a derived expectation would agree
// with any bug the builder grew.

import { load as parseYaml } from "js-yaml";
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

describe("the connection name is escaped for the grammar it lands in", () => {
  it("keeps a quote out of the JSON and YAML shapes", () => {
    // An unescaped quote produces a config the client silently ignores, which is the
    // copy-paste failure this module exists to remove, now with the person's own text
    // as the trigger.
    const json = mcpSnippet(presetById("claude-desktop")!, 'a"b');
    expect(() => JSON.parse(json)).not.toThrow();
    expect(JSON.parse(json).mcpServers.myne.env.MYNE_MCP_CONNECTION).toBe('a"b');
    const yaml = mcpSnippet(presetById("hermes")!, 'a"b');
    expect(yaml).toContain('MYNE_MCP_CONNECTION: "a\\"b"');
  });

  it("single-quotes a shell line only when the name needs it", () => {
    // A plain name stays readable; a name with a space or a `;` cannot run extra
    // words in the line the person is told to paste.
    expect(mcpSnippet(GENERIC_CLIENT, "myne")).toBe("MYNE_MCP_CONNECTION=myne myne-mcp");
    expect(mcpSnippet(GENERIC_CLIENT, "a b; rm -rf ~")).toBe(
      "MYNE_MCP_CONNECTION='a b; rm -rf ~' myne-mcp",
    );
    expect(mcpSnippet(GENERIC_CLIENT, "it's")).toBe("MYNE_MCP_CONNECTION='it'\\''s' myne-mcp");
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

// ── the snippets, as the CLIENT parses them ────────────────────────────────
//
// The string comparisons above are the guard against a shape drifting back to a
// shared one. They cannot answer the question a person actually has: is this text
// something the client will PARSE? A snippet with a trailing comma, a quote the
// builder did not escape or the wrong nesting depth passes a `toBe` and is rejected
// by the client, silently, with the connection simply never appearing — which is the
// failure this roster exists to prevent. So every preset's snippet is parsed here by
// the grammar its client reads, and the server entry is checked in the parsed tree.

describe("every snippet parses in the grammar its client reads", () => {
  const parses = (presetId: string, connection: string) => {
    const preset = presetById(presetId);
    expect(preset, `${presetId} is a preset`).not.toBeNull();
    const text = mcpSnippet(preset!, connection);
    if (preset!.shape === "yaml-mcp_servers") return parseYaml(text) as Record<string, unknown>;
    if (preset!.shape === "command") return null;
    return JSON.parse(text) as Record<string, unknown>;
  };

  it("parses the connection name a person actually typed", () => {
    // A name with both quote characters in it is the input that breaks an unescaped
    // builder, so every client is parsed with it rather than with "myne".
    const connection = 'odd "name" \'with quotes\'';
    for (const preset of [...MCP_CLIENT_PRESETS, GENERIC_CLIENT]) {
      expect(
        () => parses(preset.id, connection),
        `${preset.name}'s snippet does not parse with a quoted connection name`,
      ).not.toThrow();
    }
  });

  it("puts the server entry where that client looks for it, with the binary and the name", () => {
    // The one key each client reads its stdio servers from. Written out rather than
    // read from the preset, because the preset's `shape` is the thing under test.
    const path: Record<string, string[]> = {
      "claude-desktop": ["mcpServers"],
      "claude-code": ["mcpServers"],
      cursor: ["mcpServers"],
      opencode: ["mcp", "servers"],
      vscode: ["servers"],
      // YAML with a snake-case key: a JSON block beside this client's config is
      // rejected, which is how this preset came to exist.
      hermes: ["mcp_servers"],
    };
    for (const [id, keys] of Object.entries(path)) {
      const parsed = parses(id, DEFAULT_CONNECTION_NAME) as Record<string, unknown>;
      let node: unknown = parsed;
      for (const key of keys) {
        node = (node as Record<string, unknown>)[key];
        expect(node, `${id}: no ${keys.join(".")} in the parsed snippet`).toBeTruthy();
      }
      const entry = (node as Record<string, <T>() => T>)["myne"] as unknown as Record<
        string,
        unknown
      >;
      expect(entry, `${id}: no server named "myne" under ${keys.join(".")}`).toBeTruthy();
      // The command is the sidecar's name, not a path: it is on PATH by the same
      // launcher that puts `myne` there, and a path would be wrong on every other
      // machine.
      const command = entry["command"];
      const spelled = Array.isArray(command) ? command.join(" ") : command;
      expect(spelled, `${id}: the command must be the sidecar, not a path`).toBe("myne-mcp");
      // And the connection name travels in the environment, under the one variable
      // the shim reads.
      const env = (entry["environment"] ?? entry["env"]) as Record<string, string> | undefined;
      expect(env?.[MCP_CONNECTION_ENV], `${id}: the connection name is not in env`).toBe(
        DEFAULT_CONNECTION_NAME,
      );
    }
  });

  it("keeps the stdio type on the two clients that require it", () => {
    // Cursor's docs make `type` required for a stdio entry and VS Code's native
    // shape does too; omitting it is the copy-paste failure those presets exist for.
    for (const id of ["cursor", "vscode"]) {
      const parsed = parses(id, DEFAULT_CONNECTION_NAME) as Record<string, never>;
      const servers = (parsed["mcpServers"] ?? parsed["servers"]) as Record<
        string,
        Record<string, unknown>
      >;
      expect(servers["myne"]["type"], `${id} requires type: stdio`).toBe("stdio");
    }
  });

  it("keeps OpenCode's nested local-server shape", () => {
    // V2 nests servers under `mcp.servers` and spells a stdio server `type: local`
    // with `command` as an ARRAY. All three are what an older snippet got wrong.
    const parsed = parses("opencode", DEFAULT_CONNECTION_NAME) as Record<string, never>;
    const entry = (parsed["mcp"] as Record<string, never>)["servers"] as Record<
      string,
      Record<string, unknown>
    >;
    expect(entry["myne"]["type"]).toBe("local");
    expect(Array.isArray(entry["myne"]["command"])).toBe(true);
  });
});
