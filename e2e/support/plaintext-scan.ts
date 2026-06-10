// Plaintext-never-on-disk scan (SYNC-13) — operationalizes the
// vision.md definition-of-done line: after the recovery drill, no
// credential material may exist as plaintext anywhere under the
// session's data dir. Reusable by any suite (VR-1 mandatory; VC-1
// optional).
//
// The check looks for each needle as a contiguous byte sequence in
// every file under `root`. Needles are whole credential strings (the
// space-joined 24-word phrase, passwords, the account display form) —
// NOT individual BIP-39 words, which can collide with random
// ciphertext bytes or legitimate UI asset content.
//
// Files are scanned in fixed chunks with a needle-length overlap so a
// WebKit cache blob (tens–hundreds of MB under XDG_CACHE_HOME) costs
// O(chunk) memory, not O(file).

import { closeSync, openSync, readdirSync, readSync } from "node:fs";
import { join } from "node:path";

const CHUNK_SIZE = 1024 * 1024;

export interface PlaintextHit {
  file: string;
  /** Index of the needle in the caller's array — the file/log-safe
   *  reference (NEVER echo the needle itself; SYNC-13). */
  needleIndex: number;
}

function scanFile(path: string, needles: Buffer[], maxNeedleLen: number): Set<number> {
  const found = new Set<number>();
  let fd: number;
  try {
    fd = openSync(path, "r");
  } catch {
    return found; // chmod-faulted fixtures etc. — unreadable is fine here
  }
  try {
    const overlap = Math.max(0, maxNeedleLen - 1);
    const buf = Buffer.alloc(CHUNK_SIZE + overlap);
    let tailLen = 0;
    for (;;) {
      const read = readSync(fd, buf, tailLen, CHUNK_SIZE, null);
      if (read <= 0) break;
      const window = buf.subarray(0, tailLen + read);
      needles.forEach((needle, i) => {
        if (!found.has(i) && needle.length > 0 && window.includes(needle)) found.add(i);
      });
      if (found.size === needles.length) break;
      // Carry the last maxNeedleLen-1 bytes so needles spanning a chunk
      // boundary still match.
      tailLen = Math.min(overlap, window.length);
      window.copyWithin(0, window.length - tailLen);
    }
  } finally {
    closeSync(fd);
  }
  return found;
}

/** Scan every file under `root` for the given credential strings.
 *  Returns hits identified by needle INDEX so failure output never
 *  reproduces the credential. */
export function scanForPlaintext(root: string, needles: string[]): PlaintextHit[] {
  const buffers = needles.map((n) => Buffer.from(n, "utf8"));
  const maxNeedleLen = Math.max(0, ...buffers.map((b) => b.length));
  const hits: PlaintextHit[] = [];
  const entries = readdirSync(root, { recursive: true, withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const path = join(entry.parentPath, entry.name);
    for (const needleIndex of scanFile(path, buffers, maxNeedleLen)) {
      hits.push({ file: path, needleIndex });
    }
  }
  return hits;
}
