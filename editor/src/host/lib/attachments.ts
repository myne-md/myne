import { getHost } from "../../host";
export function attachmentExport(id: string, dest: string, overwrite: boolean): Promise<void> { return getHost().attachments.attachmentExport(id, dest, overwrite); }
export function attachmentRename(id: string, name: string): Promise<void> { return getHost().attachments.attachmentRename(id, name); }
