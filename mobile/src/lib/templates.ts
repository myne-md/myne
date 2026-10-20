// Note-template management (mobile) — templates are ordinary notes carrying a
// value-strict `template: true` frontmatter flag (the inverse-visibility twin of
// `trashed:`; markdown-dialect §3.6.1). They are excluded from the live list
// (`isLiveNote`) and authored/instantiated here. Byte-exact with desktop via the
// shared surgery, so a template made on mobile reads identically on desktop.

import { patchTemplateField, patchTitleField, buildInitialPlaintext } from "../dialect/surgery";
import { normalizeFolderPath } from "../dialect/folderPath";
import { noteRead, noteUpdate, noteCreate } from "./notes";

const enc = new TextEncoder();
const dec = new TextDecoder();

/** Mark an existing note as a template (value-strict `template: true`). */
export async function markAsTemplate(id: string): Promise<void> {
  const current = await noteRead(id);
  const t = patchTemplateField(enc.encode(current), "true");
  await noteUpdate(id, dec.decode(t), undefined, current);
}

/** Convert a template back into an ordinary note (drops the flag). */
export async function unmarkTemplate(id: string): Promise<void> {
  const current = await noteRead(id);
  const t = patchTemplateField(enc.encode(current), null);
  await noteUpdate(id, dec.decode(t), undefined, current);
}

/** Create a new empty template note titled `name`; resolves to its id. */
export async function createTemplate(name: string, folder: string | null): Promise<string> {
  let bytes: Uint8Array = enc.encode(buildInitialPlaintext(normalizeFolderPath(folder)));
  bytes = patchTitleField(bytes, name);
  bytes = patchTemplateField(bytes, "true");
  return noteCreate(dec.decode(bytes), normalizeFolderPath(folder));
}
