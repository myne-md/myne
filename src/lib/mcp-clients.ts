// The clients Myne knows how to set up for an external MCP connection
// (mcp external access rework, myne-md/myne#1052).
//
// # Why this is data
//
// Each client has its own shape for registering a locally-spawned stdio server,
// and the shapes genuinely differ: three spellings of the top-level key
// (`mcpServers`, `servers`, `mcp_servers`), and a split on whether
// `"type": "stdio"` is required. A single snippet reused across clients is the
// failure this module exists to remove, because the wrong one is accepted
// silently and the connection never appears.
//
// Each entry therefore carries the documentation URL its shape was verified
// against and the date, so a later reader can tell a verified shape from a
// remembered one. `tests/mcp-clients.test.ts` fails when either is missing.
//
// # The generic entry is not a fallback in name only
//
// A client nobody listed gets the bare stdio command plus the environment
// variable, which is the one shape every MCP client understands, and the step
// shows it only when the person opens the "other clients" disclosure.

/** One selectable client in step 1 of the approval flow. */
export interface McpClientPreset {
  /** Stable id, also the default connection name when the name is not edited. */
  id: string;
  /** Display name. Product names are not translated. */
  name: string;
  /** Where the person registers the server, as a path they can open. */
  configPath: string;
  /**
   * How the snippet is shaped. The builder is chosen by this rather than by the
   * id, so two clients that share a shape share one tested builder.
   */
  shape:
    | "json-mcpServers"
    | "json-mcpServers-typed"
    | "json-servers-typed"
    | "yaml-mcp_servers"
    | "json-mcp-servers-local"
    | "command";
  /** The official page the shape was read from. */
  source: string;
  /** ISO date the shape was last verified against that page. */
  verified: string;
  /**
   * Whether the client gates tools through its own config. Only Hermes does, and
   * the step says so once: a client-side allow list is a convenience, never the
   * control, which is what Myne's own switches are.
   */
  clientSideToolList: boolean;
}

/** The connection name the snippets are rendered with, until the person edits it. */
export const DEFAULT_CONNECTION_NAME = "myne";

/** The binary a client launches. Shipped inside the desktop bundle. */
const MCP_BINARY = "myne-mcp";

/** The environment variable that carries the declared connection name. */
export const MCP_CONNECTION_ENV = "MYNE_MCP_CONNECTION";

export const MCP_CLIENT_PRESETS: readonly McpClientPreset[] = [
  {
    id: "claude-desktop",
    name: "Claude Desktop",
    configPath: "~/Library/Application Support/Claude/claude_desktop_config.json",
    shape: "json-mcpServers",
    source: "https://modelcontextprotocol.io/docs/develop/connect-local-servers",
    verified: "2026-11-10",
    clientSideToolList: false,
  },
  {
    id: "claude-code",
    name: "Claude Code",
    configPath: "~/.claude.json",
    shape: "json-mcpServers",
    source: "https://docs.anthropic.com/en/docs/claude-code/mcp",
    verified: "2026-11-10",
    clientSideToolList: false,
  },
  {
    id: "cursor",
    name: "Cursor",
    configPath: "~/.cursor/mcp.json",
    // Cursor's docs make `type` required for a stdio entry; omitting it is the
    // copy-paste failure this shape exists to prevent.
    shape: "json-mcpServers-typed",
    source: "https://cursor.com/docs/mcp",
    verified: "2026-11-10",
    clientSideToolList: false,
  },
  {
    id: "opencode",
    name: "OpenCode",
    // The global config file its docs name; a project may carry its own.
    configPath: "opencode.jsonc",
    // V2 nests servers under `mcp.servers` and does NOT put names directly under
    // `mcp` any more; it also spells a stdio server `type: "local"` with `command`
    // as an array, and it takes `environment` rather than `env`. All four are the
    // copy-paste failures this shape exists to prevent.
    shape: "json-mcp-servers-local",
    source: "https://opencode.ai/docs/mcp-servers/",
    verified: "2026-11-10",
    clientSideToolList: false,
  },
  {
    id: "vscode",
    name: "VS Code",
    configPath: ".vscode/mcp.json",
    // VS Code's NATIVE shape: top-level `servers`, and `type` required. Its
    // portable Copilot format uses `mcpServers` instead, which is a different
    // file and a different answer; this preset names the native one.
    shape: "json-servers-typed",
    source: "https://code.visualstudio.com/docs/copilot/reference/mcp-configuration",
    verified: "2026-11-10",
    clientSideToolList: false,
  },
  {
    id: "hermes",
    name: "Hermes",
    configPath: "~/.hermes/config.yaml",
    // YAML, and `mcp_servers` in snake case: a JSON block beside this client's
    // config is rejected, which is how this preset came to exist.
    shape: "yaml-mcp_servers",
    source: "https://hermes-agent.nousresearch.com/docs/user-guide/features/mcp",
    verified: "2026-11-10",
    clientSideToolList: true,
  },
];

/**
 * The entry the "other clients" disclosure offers: the bare command, which every
 * MCP client accepts in some form, plus the variable that names the connection.
 */
export const GENERIC_CLIENT: McpClientPreset = {
  id: "other",
  name: "Other clients",
  configPath: "",
  shape: "command",
  // No single page documents every client, so the source is the protocol
  // specification's own local-server page, which is where a client's author reads
  // what a stdio server is.
  source: "https://modelcontextprotocol.io/docs/develop/connect-local-servers",
  verified: "2026-11-10",
  clientSideToolList: false,
};

/** Every preset by id, for a step that has to re-render a chosen one. */
export function presetById(id: string): McpClientPreset | null {
  if (id === GENERIC_CLIENT.id) return GENERIC_CLIENT;
  return MCP_CLIENT_PRESETS.find((preset) => preset.id === id) ?? null;
}

/**
 * The snippet for one client, with the connection name spliced in.
 *
 * Written as one literal per shape rather than assembled from fragments, because
 * the shape of a client's configuration is not ours to paraphrase: the person
 * pastes it verbatim, and a reformatted version is a second opinion about
 * somebody else's file format.
 */
export function mcpSnippet(preset: McpClientPreset, connection: string): string {
  const jsonToken = JSON.stringify(connection).slice(1, -1);
  const yamlToken = jsonToken;
  const shellToken = /^[A-Za-z0-9._-]+$/.test(connection)
    ? connection
    : `'${connection.split("'").join(`'\\''`)}'`;
  switch (preset.shape) {
    case "json-mcpServers":
      return `{"mcpServers":{"myne":{"command":"${MCP_BINARY}","env":{"${MCP_CONNECTION_ENV}":"${jsonToken}"}}}}`;
    case "json-mcpServers-typed":
      return `{"mcpServers":{"myne":{"type":"stdio","command":"${MCP_BINARY}","env":{"${MCP_CONNECTION_ENV}":"${jsonToken}"}}}}`;
    case "json-servers-typed":
      return `{"servers":{"myne":{"type":"stdio","command":"${MCP_BINARY}","env":{"${MCP_CONNECTION_ENV}":"${jsonToken}"}}}}`;
    case "json-mcp-servers-local":
      return `{"$schema":"https://opencode.ai/config.json","mcp":{"servers":{"myne":{"type":"local","command":["${MCP_BINARY}"],"environment":{"${MCP_CONNECTION_ENV}":"${jsonToken}"}}}}}`;
    case "yaml-mcp_servers":
      return `mcp_servers:\n  myne:\n    command: "${MCP_BINARY}"\n    env:\n      ${MCP_CONNECTION_ENV}: "${yamlToken}"`;
    case "command":
      // The one shape that is a shell line rather than a file body: a client
      // whose configuration nobody has listed gets the command and the variable,
      // which is what an MCP client needs and nothing more.
      return `${MCP_CONNECTION_ENV}=${shellToken} ${MCP_BINARY}`;
  }
}
