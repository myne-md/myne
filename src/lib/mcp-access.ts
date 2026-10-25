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
// The section states "412 notes in 38 folders" and "3 folders created since you
// approved this are not shared". Each is a statement about SCOPE, and the scope
// is the host's: `core/src/plugins/mcp/scope.rs` resolves a stored grant against
// the folder set the sidebar shows, and the same resolver clamps every tool call.
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
  /** The granted folder paths that still exist, canonical (`Projects/`). */
  readFolders: string[];
  /** Granted paths that no longer exist, because the folder was renamed or deleted. */
  missingFolders: string[];
  /**
   * The folders this connection may write to.
   *
   * Always empty in this build: the write grant is a later slice of the same
   * feature, and the row says "nothing" rather than implying a scope the host
   * does not enforce.
   */
  writeFolders: string[];
  /** Unix epoch seconds the host stamped at approval. */
  approvedAt: number;
  /** Unix epoch seconds of the last call that reached the door, or `null`. */
  lastUsedAt: number | null;
  /** Live notes inside the readable folders right now. */
  noteCount: number;
  /** Folders that exist now and are outside the frozen set, sorted. The delta row. */
  deltaFolders: string[];
}

/** The section's whole payload. Mirrors `McpExternalAccessView`. */
export interface McpExternalAccessView {
  connections: McpConnectionView[];
  /** Every folder that exists now, canonical, root as `""`. Feeds the approval screen. */
  folders: string[];
  /** Live notes in the vault, for the "N of M" framing. */
  noteCount: number;
}

/** What a candidate grant would cover. Mirrors `McpGrantPreview`. */
export interface McpGrantPreview {
  noteCount: number;
  folderCount: number;
  /**
   * The candidate set itself, canonical and sorted: what the two counts describe
   * and what the approval writes.
   *
   * It travels with the counts so the exclusion rule has ONE implementation (the
   * host's): re-deriving the set here would be a second opinion about scope, and
   * the number the user approves would eventually stop being the number counted.
   */
  folders: string[];
  /**
   * Exclusions that named a folder the vault actually has. An exclusion naming
   * nothing changes nothing, so counting it would claim a decision the user did
   * not make.
   */
  excludedCount: number;
}

/**
 * What a fresh render shows before the host answers: no connections, no folders.
 *
 * Deliberately NOT used as a fallback for a FAILED read. "Nothing is approved" and
 * "the read failed" are different facts, and a screen that showed the first while
 * the second were true would tell the user their vault is closed to external
 * clients when it may not be.
 */
export const EMPTY_MCP_ACCESS: McpExternalAccessView = {
  connections: [],
  folders: [],
  noteCount: 0,
};

/** The connection list, with per-connection scope and last use. */
export async function readMcpExternalAccess(): Promise<McpExternalAccessView> {
  const wire = await invoke<McpExternalAccessView>("plugin:mcp|mcp_external_access");
  // Defensive defaults: the host is the only writer of this shape, and a field
  // missing from it is a build skew rather than a state the UI should crash on.
  return {
    connections: (wire?.connections ?? []).map((row) => ({
      name: row.name,
      readFolders: row.readFolders ?? [],
      missingFolders: row.missingFolders ?? [],
      writeFolders: row.writeFolders ?? [],
      approvedAt: row.approvedAt ?? 0,
      lastUsedAt: row.lastUsedAt ?? null,
      noteCount: row.noteCount ?? 0,
      deltaFolders: row.deltaFolders ?? [],
    })),
    folders: wire?.folders ?? [],
    noteCount: wire?.noteCount ?? 0,
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
    folders: wire?.folders ?? [],
  };
}
