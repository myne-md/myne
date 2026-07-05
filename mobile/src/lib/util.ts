// Small shared helpers used across the note/graph/attachment surfaces.

/** Append `value` to the array at `key`, creating the array on first use. */
export function pushMap<V>(m: Map<string, V[]>, key: string, value: V): void {
  const arr = m.get(key);
  if (arr) arr.push(value);
  else m.set(key, [value]);
}

/** Human byte size — B / KB / MB. */
export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}
