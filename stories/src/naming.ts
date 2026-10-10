// Display names for rail entries (myne-md/myne#845, revised).
//
// The rule: a name must not differ from the component name, it only changes
// casing. `ModalShell` reads as "Modal Shell", `IconButton` as "Icon Button".
// Nothing is renamed to a synonym, because a second vocabulary for the same
// thing is how a design system and its code drift apart.
//
// Title Case rather than sentence case, matching the design-system convention
// (Storybook, Baklava): a rail is a list of names, and a list reads better when
// every entry is capitalised the same way.
//
// The transform is mechanical and total; `title` on a descriptor exists only for
// the rare name the transform reads badly. A unit test pins the edge cases.

/**
 * Words that are acronyms rather than PascalCase words, so they render upper
 * case instead of being title-cased into nonsense ("Ai" -> "AI", not "Ai").
 */
const ACRONYMS = new Set([
  "AI",
  "API",
  "CLI",
  "CSS",
  "HTML",
  "ID",
  "JSON",
  "LLM",
  "OCR",
  "PDF",
  "PIN",
  "QR",
  "RTL",
  "TTS",
  "UI",
  "URL",
  "UUID",
]);

/** Split PascalCase and acronym runs into words. */
function words(surface: string): string[] {
  return surface
    // A run of capitals followed by a capital+lowercase: the last capital opens
    // the next word (`OCRText` -> OCR, Text).
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
    // A lowercase or digit followed by a capital opens a new word.
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .split(/[\s_-]+/)
    .filter((word) => word.length > 0);
}

/** One word in its display form. */
function titleWord(word: string): string {
  if (ACRONYMS.has(word.toUpperCase())) return word.toUpperCase();
  return word[0].toUpperCase() + word.slice(1).toLowerCase();
}

/**
 * `ModalShell` -> "Modal Shell"; `IconButton` -> "Icon Button";
 * `AiChatTab` -> "AI Chat Tab"; `SyncUsageBlock` -> "Sync Usage Block";
 * `AttachmentOcrSettings` -> "Attachment OCR Settings".
 */
export function displayName(surface: string): string {
  return words(surface).map(titleWord).join(" ");
}

/** The name a rail entry shows: the override when set, else the derivation. */
export function entryName(surface: string, title?: string): string {
  return title ?? displayName(surface);
}
