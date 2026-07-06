// Document stats for the editor footer — the mobile counterpart to the desktop
// documentStats / wordCount surface. Whitespace-run word split; character count
// is the raw length (matches what a user sees typing).

export interface DocStats {
  words: number;
  chars: number;
  /** Estimated reading time in minutes (~200 wpm), rounded up. 0 when empty. */
  readingMinutes: number;
}

/** Words per minute for the reading-time estimate (industry-standard prose rate). */
const WPM = 200;

/** Count words (whitespace-separated runs), characters, and reading time. */
export function countWords(text: string): DocStats {
  const trimmed = text.trim();
  const words = trimmed === "" ? 0 : trimmed.split(/\s+/).length;
  return {
    words,
    chars: text.length,
    readingMinutes: Math.ceil(words / WPM),
  };
}
