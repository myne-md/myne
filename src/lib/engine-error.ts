// The one reader of the local-inference `EngineError` wire shape.
//
// Every on-device AI seam rejects with the same closed Rust enum, serialized by
// Tauri as either a bare variant string (`"NotReady"`) or a `{ kind }` object
// depending on the variant's payload. Each seam then narrows that to the kinds
// IT cares about — `transcribe.ts` only needs "not ready vs failed", `ai-tags.ts`
// also needs "deferred" — but the extraction is identical, and a copy of it in
// every seam is a copy that silently reports `failed` when a new variant lands.
//
// Content-free by construction: the variant tag is a fixed identifier, never the
// prompt, the note body, or the model's output. Keep it that way.

/**
 * The `EngineError` variant tag of a raw IPC rejection, or `""` when the value
 * is not one (an unrecognized shape must not be mistaken for a known kind). Pure.
 */
export function engineErrorTag(raw: unknown): string {
  if (typeof raw === "string") return raw;
  if (raw !== null && typeof raw === "object" && "kind" in raw) {
    return String((raw as { kind: unknown }).kind);
  }
  return "";
}
