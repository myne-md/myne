// Tauri IPC wrappers for the external-access section (external-mcp-connection,
// myne-md/myne#923).
//
// This module holds the READS. The two WRITES live in `src/lib/prefs.ts`
// (`setMcpConnectionGrant`, `revokeMcpConnection`) because they write the
// `mcp_connections` field of `vault.prefs`, and the prefs nonce may only be
// bumped from that module's one chokepoint (`check-prefs-nonce.mjs`). Reaching
// around it here would leave every `usePrefs` consumer holding a stale cache.
//
// # Why the counts come over IPC instead of being derived here
//
// The section states "may read 412 notes in 38 folders" and "leaves out
// private/". Each is a statement about SCOPE, and the scope is the host's:
// `core/src/plugins/mcp/scope.rs` resolves a stored exclusion list against the
// folder set the sidebar shows, and the same resolver clamps every tool call.
// A renderer that summed a folder list itself would be a second opinion about the
// same permission, and the first time either changed the screen would describe a
// grant the tools do not enforce.
//
// So this file formats, and nothing more.
//
// Desktop-only. The `externalMcp` capability is absent on web and mobile and the
// section that reads this is omitted there, so no other path reaches these
// commands; the wasm dispatcher also answers the whole `mcp` plugin with a typed
// refusal.

import { invoke } from "../platform/core";

/** One approved connection, as the host resolved it. Mirrors `McpConnectionView`. */
export interface McpConnectionView {
  /** The declared name the client announces. A LABEL, not a credential. */
  name: string;
  /**
   * Approved under the retired allow-list model, so this build reads nothing for
   * it until the user approves it again. The row states that instead of showing
   * counts from a rule the tools do not enforce.
   */
  legacy: boolean;
  /** What the retired grant named, so a re-approval starts from something visible. */
  legacyFolders: string[];
  /** The folders this connection may NOT read, canonical (`Private/`), sorted. */
  excludedFolders: string[];
  /**
   * Exclusions that name a folder which no longer exists. They take nothing out,
   * and the row reports them so the count it shows is a count of what the
   * exclusions actually do.
   */
  staleExcludedFolders: string[];
  /**
   * The folders this connection may write to, canonical and sorted, resolved the
   * way a write is served: a legacy grant writes nowhere, and a folder named for
   * writing but left out of the read scope is dropped rather than shown.
   *
   * Empty is the ordinary case and means **write nowhere**, never "everywhere"
   * (the inversion that makes this the opposite of an empty `excludedFolders`).
   */
  writeFolders: string[];
  /** Unix epoch seconds the host stamped at approval. */
  approvedAt: number;
  /** Unix epoch seconds of the last call that reached the door, or `null`. */
  lastUsedAt: number | null;
  /** Live notes the scope covers right now. */
  noteCount: number;
  /** Folders of the vault the scope covers right now. */
  folderCount: number;
  /**
   * One entry per catalog verb, in catalog order. `enabled` is the person's choice
   * and `availableInBuild` is what this build can serve at all, and the two are
   * separate on purpose: a verb this build has no implementation for must render
   * with a reason rather than as a switch that would do nothing.
   */
  tools: McpToolSwitchView[];
}

/** One verb's switch state. Mirrors `McpToolSwitchView`. */
export interface McpToolSwitchView {
  /** The wire name the grant stores. */
  verb: string;
  /** Not switched off by the stored grant. */
  enabled: boolean;
  /** This build dispatches the verb. */
  availableInBuild: boolean;
  /** The verb changes the vault, so the step can group reads from writes. */
  isWrite: boolean;
}

/** The section's whole payload. Mirrors `McpExternalAccessView`. */
export interface McpExternalAccessView {
  connections: McpConnectionView[];
  /** Every folder that exists now, canonical, root as `""`. Feeds the approval screen. */
  folders: string[];
  /** Live notes in the vault, for the "N of M" framing. */
  noteCount: number;
  /**
   * Writes waiting for a decision, newest first, already filtered by the host to
   * the ones it can accept right now.
   */
  writeRequests: McpWriteRequestView[];
  /**
   * The read budget the host enforces, so the surface states the number that is
   * actually applied rather than a copy that can drift from a constant.
   */
  readBudget: { notesPerWindow: number; windowSeconds: number };
  /**
   * The verb catalog on its own, every switch enabled. The approval flow needs it
   * for a connection that does not exist yet.
   */
  toolCatalog: McpToolSwitchView[];
}

/** What a candidate exclusion list would leave readable. Mirrors `McpGrantPreview`. */
export interface McpGrantPreview {
  noteCount: number;
  folderCount: number;
  /**
   * Exclusions that named a folder the vault actually has. An exclusion naming
   * nothing changes nothing, so counting it would claim a decision the user did
   * not make.
   */
  excludedCount: number;
  /**
   * The exclusion set itself, canonical and sorted: what the counts describe and
   * what the approval writes.
   *
   * It travels with the counts so the rule has ONE implementation (the host's):
   * re-deriving the set here would be a second opinion about scope, and the
   * number the user approves would eventually stop being the number counted.
   */
  excludedFolders: string[];
  /**
   * The folders this exclusion set still leaves readable, canonical and sorted:
   * the candidates the write picker offers.
   *
   * They come from the host for the same reason the set above does. A write grant
   * must name a folder the connection may also READ, so a picker built from the
   * vault's whole folder list would offer folders the writer refuses, and the
   * refusal would reach the user as an unexplained failed approval.
   */
  folders: string[];
}

/**
 * One queued out-of-scope write, as the card renders it
 * (external-mcp-connection task 13).
 *
 * It is a PROPOSAL, never a pending write: nothing has been applied, and
 * accepting it extends that connection's write grant by exactly `folder`.
 */
export interface McpWriteRequestView {
  /** The connection that attempted it. Its grant is what accepting widens. */
  connection: string;
  /** The folder it named, canonical. */
  folder: string;
  /** When it asked, Unix epoch seconds. */
  requestedAt: number;
  /**
   * What it said it wanted to write. CLIENT-AUTHORED USER TEXT: rendered, never
   * logged, and the reason this surface has no diagnostics panel.
   */
  summary: string;
  /** The verb it called. */
  verb: string;
  /**
   * Which direction accepting moves the grant: a write request adds the folder to
   * the write list, a read request takes it off the exclusion list.
   */
  kind: "write" | "read";
}

/** The connection list, with per-connection scope and last use. */
export async function readMcpExternalAccess(): Promise<McpExternalAccessView> {
  const wire = await invoke<McpExternalAccessView>("plugin:mcp|mcp_external_access");
  // Defensive defaults: the host is the only writer of this shape, and a field
  // missing from it is a build skew rather than a state the UI should crash on.
  return {
    toolCatalog: (wire?.toolCatalog ?? []).map((tool) => ({
      verb: tool.verb ?? "",
      enabled: tool.enabled ?? false,
      availableInBuild: tool.availableInBuild ?? false,
      isWrite: tool.isWrite ?? false,
    })),
    connections: (wire?.connections ?? []).map((row) => ({
      name: row.name,
      legacy: row.legacy ?? false,
      legacyFolders: row.legacyFolders ?? [],
      excludedFolders: row.excludedFolders ?? [],
      staleExcludedFolders: row.staleExcludedFolders ?? [],
      writeFolders: row.writeFolders ?? [],
      approvedAt: row.approvedAt ?? 0,
      lastUsedAt: row.lastUsedAt ?? null,
      noteCount: row.noteCount ?? 0,
      folderCount: row.folderCount ?? 0,
      tools: (row.tools ?? []).map((tool) => ({
        verb: tool.verb ?? "",
        enabled: tool.enabled ?? false,
        availableInBuild: tool.availableInBuild ?? false,
        isWrite: tool.isWrite ?? false,
      })),
    })),
    folders: wire?.folders ?? [],
    noteCount: wire?.noteCount ?? 0,
    readBudget: {
      notesPerWindow: wire?.readBudget?.notesPerWindow ?? 0,
      windowSeconds: wire?.readBudget?.windowSeconds ?? 0,
    },
    // Only the requests the host can still accept: a row whose grant is gone, or
    // whose folder has been excluded since, is not a decision this surface can
    // offer, and the host filters it out before it gets here.
    writeRequests: (wire?.writeRequests ?? []).map((row) => ({
      connection: row.connection ?? "",
      folder: row.folder ?? "",
      requestedAt: row.requestedAt ?? 0,
      summary: row.summary ?? "",
      verb: row.verb ?? "",
      // A build skew where the host sends no kind: read it as a write request,
      // which is what every row written before the read kind existed means.
      kind: row.kind === "read" ? "read" : "write",
    })),
  };
}

/**
 * What the vault would share if the user approved now, with `excluded` taken out.
 *
 * Called on the approval screen as the exclusions change, so the number the user
 * approves is the number the host resolved rather than one the dialog assembled.
 * Excluding a folder also takes what is inside it, and the host applies that rule
 * while building the candidate set, so this is the one place the exclusion's
 * meaning is defined.
 */
export async function readMcpGrantPreview(
  excluded: readonly string[],
): Promise<McpGrantPreview> {
  const wire = await invoke<McpGrantPreview>("plugin:mcp|mcp_grant_preview", {
    excluded: [...excluded],
  });
  return {
    noteCount: wire?.noteCount ?? 0,
    folderCount: wire?.folderCount ?? 0,
    excludedCount: wire?.excludedCount ?? 0,
    excludedFolders: wire?.excludedFolders ?? [],
    folders: wire?.folders ?? [],
  };
}
