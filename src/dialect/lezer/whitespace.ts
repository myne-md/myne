// Shared whitespace predicate for the Myne dialect Lezer configs.
//
// The ASCII fast-path covers space / tab / LF / CR / VT / FF; anything ≥ 0x80
// defers to the Unicode `\s` class. Extracted so the inline-tag and footnote
// recognizers share one definition of "whitespace" rather than each carrying a
// byte-identical copy.

export function isWhitespace(charCode: number): boolean {
  if (
    charCode === 0x20 ||
    charCode === 0x09 ||
    charCode === 0x0a ||
    charCode === 0x0d ||
    charCode === 0x0b ||
    charCode === 0x0c
  ) {
    return true;
  }
  if (charCode < 0x80) return false;
  return /\s/u.test(String.fromCharCode(charCode));
}
