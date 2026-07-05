import { getHost, type TagTreeNode } from "../../host";
export type { TagTreeNode };
export function isMediaTarget(target: string): boolean { return getHost().notes.isMediaTarget(target); }
export function tagTree(): Promise<TagTreeNode[]> { return getHost().notes.tagTree(); }
