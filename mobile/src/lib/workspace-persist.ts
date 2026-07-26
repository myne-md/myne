// Disk persistence for mobile's slice of the workspace descriptor (MYND-561).
// Reads/writes the encrypted `vault.workspace` blob (`MYW1`, protocol.md §9.7)
// via the `workspace` Tauri plugin, so the sidebar folder-expand set survives an
// app restart. Mobile parity port of desktop's MYND-455.
//
// ## What mobile puts in the container, and what it must not disturb
//
// The descriptor is one JSON object shared by every client. Desktop fills it with
// a pane tree (`slots` / `activeId`); mobile has no pane tree and contributes
// only the container-level `expandedFolders` field. So every write here is a
// READ-MODIFY-WRITE: parse whatever is on disk, splice `expandedFolders`, and
// re-serialize with all other keys preserved verbatim. Writing a fresh
// `{expandedFolders}` object instead would silently delete a desktop pane tree
// from a vault directory that both clients can reach.
//
// Field encoding is desktop's exactly (`src/lib/workspace-persist.ts` there):
// an array of folded folder keys, OMITTED when empty, and tolerated-as-absent
// when malformed. A pre-455 reader ignores the unknown field; a post-455 reader
// tolerates its absence. No `workspace_format_version` bump — the field is
// strictly additive.
//
// ## Write cadence, and why it is not per-toggle
//
// Desktop writes this blob on graceful exit ONLY, never per interaction, so the
// blob's mtime cannot become an editor-activity log (design grill 2026-06-01 Q1)
// — mtime is visible to an adversary with filesystem access even though the
// contents are sealed. Mobile has no Cmd+Q, so the exit analog is:
//
//   • the app being backgrounded (`visibilitychange` → hidden, plus `pagehide`
//     for the terminal case) — the normal path, since an OS kill of a
//     backgrounded app is how mobile apps usually die; and
//   • `lockVault()`, mobile's single lock choke point (Lock button, idle
//     auto-lock, vault switch), flushed BEFORE the slot drops.
//
// A toggle only sets the store's dirty flag. So the mtime tracks "the app was
// backgrounded / locked", which the vault's other blobs already reveal, rather
// than "a folder was toggled at 14:32" — the desktop property, preserved.

import { invoke } from "@tauri-apps/api/core";
import { HAS_TAURI } from "./app-window";
import {
  isExpandDirty,
  hydrateExpandedFolders,
  markExpandFlushed,
  peekExpandedFolders,
  resetExpandedFoldersOnLock,
} from "./folder-expand-store";

/** Read the persisted descriptor, or `null` when there is none / the slot is
 *  locked / the blob is unreadable (the Rust command returns `Option<String>`
 *  and collapses every recoverable failure to `None` per §9.7.4). */
export async function workspaceRead(): Promise<string | null> {
  return await invoke<string | null>("plugin:workspace|workspace_read");
}

/** Persist the descriptor (opaque JSON) to the encrypted blob. */
export async function workspaceWrite(descriptor: string): Promise<void> {
  await invoke("plugin:workspace|workspace_write", { descriptor });
}

/**
 * Extract the folder-expand set from a descriptor. Returns `[]` for every
 * "nothing to restore" case — absent descriptor, non-object JSON, unparseable
 * JSON, missing field, or a field that is not an array of strings.
 *
 * A malformed field is tolerated as absent rather than treated as corruption:
 * the worst outcome is a sidebar that opens collapsed, which is also the cold
 * start, so there is nothing to escalate to the user (desktop takes the same
 * position).
 */
export function parseExpandedFolders(descriptor: string | null): string[] {
  if (descriptor === null || descriptor === "") return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(descriptor);
  } catch {
    return [];
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return [];
  const field = (parsed as { expandedFolders?: unknown }).expandedFolders;
  if (!Array.isArray(field) || !field.every((k) => typeof k === "string")) return [];
  return field as string[];
}

/**
 * Splice `expanded` into `descriptor`, preserving every other key. Omits the
 * field entirely when the set is empty (desktop's omit-when-default discipline),
 * so an all-collapsed sidebar leaves byte-identical output to a pre-455 blob.
 *
 * A descriptor that is absent or unparseable is replaced rather than merged —
 * there is nothing recoverable to preserve, and refusing to write would strand
 * the user's set forever on a vault whose blob got corrupted once.
 */
export function withExpandedFolders(
  descriptor: string | null,
  expanded: readonly string[],
): string {
  let base: Record<string, unknown> = {};
  if (descriptor !== null && descriptor !== "") {
    try {
      const parsed: unknown = JSON.parse(descriptor);
      if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
        base = { ...(parsed as Record<string, unknown>) };
      }
    } catch {
      // fall through to the empty base
    }
  }
  if (expanded.length > 0) base.expandedFolders = [...expanded];
  else delete base.expandedFolders;
  return JSON.stringify(base);
}

/** Once-per-unlock-session hydration latch (cleared by
 *  {@link resetWorkspaceOnLock}). */
let hydratedThisSession = false;
/** The descriptor as last seen on disk — the merge base for the next write, so a
 *  flush never has to re-read (and never races a read) to preserve foreign keys. */
let lastDescriptor: string | null = null;

/**
 * Hydrate the folder-expand store from `vault.workspace` ONCE per unlock
 * session; later calls (every list remount) are no-ops. Best-effort: a locked
 * slot / absent blob / decode-fail leaves the store empty, which renders the
 * cold-start collapsed sidebar (§9.7.4).
 */
export async function ensureWorkspaceHydrated(): Promise<void> {
  if (hydratedThisSession) return;
  hydratedThisSession = true;
  if (!HAS_TAURI) return;
  try {
    lastDescriptor = await workspaceRead();
  } catch {
    lastDescriptor = null;
  }
  hydrateExpandedFolders(parseExpandedFolders(lastDescriptor));
}

/**
 * Flush the folder-expand set to `vault.workspace` if it changed. Called at the
 * exit analogs (background / lock — see the module header on cadence), and
 * awaited from `lockVault()` so the write lands while the slot is still
 * unlocked. Best-effort: a write failure keeps the set dirty so the next exit
 * seam retries, and never surfaces to the user (a lost expand set is cosmetic).
 */
export async function flushWorkspaceNow(): Promise<void> {
  if (!HAS_TAURI || !isExpandDirty()) return;
  const descriptor = withExpandedFolders(lastDescriptor, [...peekExpandedFolders()]);
  try {
    await workspaceWrite(descriptor);
    lastDescriptor = descriptor;
    markExpandFlushed();
  } catch {
    // Leave `dirty` set — the next background / lock retries.
  }
}

/**
 * Reset on vault lock: drop the in-memory set and re-arm the session latch, so
 * vault A's open folders never seed vault B and no stale merge base survives the
 * switch. Wired into `lockVault()` AFTER its flush.
 */
export function resetWorkspaceOnLock(): void {
  resetExpandedFoldersOnLock();
  lastDescriptor = null;
  hydratedThisSession = false;
}

/** Test-only reset of the module latch + merge base. */
export function __resetWorkspacePersistForTest(): void {
  hydratedThisSession = false;
  lastDescriptor = null;
}
