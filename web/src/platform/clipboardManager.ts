// Web seam — `clipboard`. Wiring stub (phase3-web-client task 7).
//
// The async Clipboard API can write and (with permission) read. `clear()` has
// no equivalent — overwriting with an empty string is the closest a page can
// get, and it is weaker than the OS-level clear the desktop performs. That
// difference belongs in the capability descriptor (task 27), not hidden here.

export async function writeText(text: string): Promise<void> {
  await navigator.clipboard.writeText(text);
}
export async function readText(): Promise<string> {
  return navigator.clipboard.readText();
}
export async function clear(): Promise<void> {
  await navigator.clipboard.writeText("");
}
