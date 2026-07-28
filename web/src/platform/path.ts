// Web seam — `path`. Wiring stub (phase3-web-client task 7).
//
// There is no filesystem to address: OPFS is reached by name through the
// Worker, never by absolute path. `join` is pure string arithmetic and is
// implemented here because it is correct on any platform; `appDataDir` waits
// for the OPFS container naming (task 17).

import { unsupported } from "../../../src/platform/unsupported";

export async function appDataDir(): Promise<string> {
  return unsupported("path.appDataDir");
}

export async function join(...parts: string[]): Promise<string> {
  return parts
    .filter((p) => p.length > 0)
    .join("/")
    .replace(/\/{2,}/g, "/");
}
