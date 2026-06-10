// Synthetic large-doc generator for render-performance work (MYND-210).
// Shared by the bench (`render-perf.bench.ts`) and the asserting tests
// (`render-perf.test.ts`). Kept in its own module so importing the generator
// does NOT pull in `bench()` calls (which only run in benchmark mode).

/** A representative large doc: a mix of every cheap + block construct, so the
 *  decoration pipeline exercises headings, lists, quotes, tables, emphasis,
 *  escapes, footnotes, highlight/sub/sup on each rebuild. */
export function syntheticDoc(lines: number): string {
  const parts: string[] = [];
  for (let i = 0; i < lines; i++) {
    switch (i % 6) {
      case 0:
        parts.push(`## Heading ${i}`);
        break;
      case 1:
        parts.push(`- item ${i} with **bold**, *italic*, \`code\` and ==hi==`);
        break;
      case 2:
        parts.push(`> quote ${i} with [a link](https://x) and a footnote[^${i}]`);
        break;
      case 3:
        parts.push(`paragraph ${i} — H~2~O, X^2^, and \\*escaped\\* text`);
        break;
      case 4:
        parts.push(`| a${i} | b${i} | c${i} |\n|---|---|---|\n| 1 | 2 | 3 |`);
        break;
      default:
        parts.push("");
    }
  }
  return parts.join("\n") + "\n";
}
