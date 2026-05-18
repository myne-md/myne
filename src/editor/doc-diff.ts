// Minimal-change diff for the controlled-component mirror in `CMEditor.tsx`.
//
// Computes the smallest single replacement that transforms `current` into
// `next`, using longest-common-prefix + longest-common-suffix. CM6's
// transaction change-mapping shifts cursor positions relative to the
// minimal change — frontmatter-only patches (e.g. autosave-driven
// `updated:` timestamp refresh) leave body cursor positions untouched.
//
// A full doc replacement (`{from: 0, to: doc.length, insert: next}`)
// would land the cursor at position 0 after every autosave, since CM6
// doesn't infer cross-replace cursor mapping.

export type DocDiff = {
  from: number;
  to: number;
  insert: string;
} | null;

export function diffDoc(current: string, next: string): DocDiff {
  if (current === next) return null;

  let prefixLen = 0;
  const minLen = Math.min(current.length, next.length);
  while (prefixLen < minLen && current[prefixLen] === next[prefixLen]) {
    prefixLen++;
  }

  let oldSuffixStart = current.length;
  let newSuffixStart = next.length;
  while (
    oldSuffixStart > prefixLen &&
    newSuffixStart > prefixLen &&
    current[oldSuffixStart - 1] === next[newSuffixStart - 1]
  ) {
    oldSuffixStart--;
    newSuffixStart--;
  }

  return {
    from: prefixLen,
    to: oldSuffixStart,
    insert: next.substring(prefixLen, newSuffixStart),
  };
}
