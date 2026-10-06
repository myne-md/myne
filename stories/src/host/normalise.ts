// The default DOM normaliser for the drift baseline (myne-md/myne#832).
//
// Strips the values that legitimately differ run to run, so a story's hash
// describes its rendering rather than a timestamp or a generated id:
//
// - React's generated ids: React 19 emits `_r_<base32>_`, React 18 `:r<n>:`.
// - ISO timestamps and bare epoch-second/millisecond numbers.
// - The contents of an `aria-live` region, whose text is announced, not drawn.
//
// Everything else, including every `style` attribute, is kept: those carry the
// design tokens, which is the whole point of hashing the DOM instead of pixels.

/** The normalised form of a rendered story's HTML. */
export function normalise(html: string): string {
  return html
    .replace(/_r_[0-9a-z]+_/g, "_r_")
    .replace(/:r[0-9a-z]+:/g, ":r:")
    .replace(/\d{4}-\d{2}-\d{2}T[\d:.]+Z?/g, "<ts>")
    .replace(/(?<=>|\s)\d{10,13}(?=<|\s)/g, "<epoch>")
    .replace(/(<[a-z]+[^>]*\baria-live="[^"]*"[^>]*>)[\s\S]*?(<\/[a-z]+>)/g, "$1$2")
    .replace(/\s+/g, " ")
    .trim();
}
