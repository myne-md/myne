// Web seam — `clipboard`. Wiring stub (phase3-web-client task 7).
//
// WRITE ONLY, mirroring the desktop seam after myne#379 moved the recovery-kit
// auto-clear's read+compare host-side. The two members that went away were
// `readText` and `clear`, and the web arm is the one that makes their removal
// obviously right rather than merely tidy: page content cannot be granted
// clipboard read in Firefox at all and is gesture-gated elsewhere, and `clear()`
// had no browser equivalent — it overwrote with an empty string, which is
// weaker than the OS-level clear the desktop performs. Neither was ever
// reachable from a web path.

export async function writeText(text: string): Promise<void> {
  await navigator.clipboard.writeText(text);
}
