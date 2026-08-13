// Bridges the app's live `#tag` index to the shared @myne/editor host `tagTree()`.
// The EditorHost is a module singleton installed at boot and can't read React
// state, so the editor flow PUBLISHES its computed tag tree here and the host
// READS the latest on demand — the mobile analog of the desktop vault-indices
// tag source. Flat for now (nested tags collapse to their full path).
import type { TagTreeNode } from "@myne/editor/host";

let current: TagTreeNode[] = [];

export function publishEditorTagTree(nodes: TagTreeNode[]): void {
  current = nodes;
}

export function currentEditorTagTree(): TagTreeNode[] {
  return current;
}
