// Plaintext-never-on-disk scan (SYNC-13) — operationalizes the
// vision.md definition-of-done line: no credential material and no
// note-content marker may exist as plaintext anywhere under the
// session's data dir. Consumers: VR-1 (mandatory), VC-1, and PS-1 —
// the at-rest residue drill (MYND-228).
//
// Needle design rule: a needle must be either a whole credential
// string (the space-joined 24-word phrase, a password, the account
// display form) or a single all-lowercase ASCII-alphanumeric token of
// ≥24 chars. NEVER individual BIP-39 words (they collide with random
// ciphertext bytes or legitimate UI asset content) and NEVER
// dash-joined or uppercase markers: the search tokenizer
// (core/src/search/mod.rs) lowercases and splits on every
// non-alphanumeric character, so a hypothetical plaintext-index leak
// would only ever contain markers that survive tokenization verbatim.
//
// Each needle is matched in BOTH UTF-8 and UTF-16LE — WebKit stores
// localStorage/IndexedDB strings as UTF-16, so a UTF-8-only scan
// would miss a real leak on those surfaces — and against every path
// component, which pure content scanning never sees.
//
// Files are scanned in fixed chunks with a needle-length overlap so a
// WebKit cache blob (tens–hundreds of MB under XDG_CACHE_HOME) costs
// O(chunk) memory, not O(file).

import { closeSync, openSync, readdirSync, readSync, statSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

const CHUNK_SIZE = 1024 * 1024;

export interface PlaintextHit {
  file: string;
  /** Index of the needle in the caller's array — the file/log-safe
   *  reference (NEVER echo the needle itself; SYNC-13). */
  needleIndex: number;
  /** Where the needle matched: file contents or a path component. */
  via: "content" | "path";
}

/** One on-disk encoding of one caller needle (UTF-8 or UTF-16LE);
 *  both report under the same caller-facing `needleIndex`. */
interface EncodedNeedle {
  buf: Buffer;
  needleIndex: number;
}

function scanFile(
  path: string,
  needles: EncodedNeedle[],
  needleCount: number,
  maxNeedleLen: number,
): Set<number> {
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
      for (const { buf: needle, needleIndex } of needles) {
        if (!found.has(needleIndex) && needle.length > 0 && window.includes(needle)) {
          found.add(needleIndex);
        }
      }
      if (found.size === needleCount) break;
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

/** Scan every file under `root` for the given credential strings —
 *  contents (UTF-8 + UTF-16LE) and path components alike. Returns
 *  hits identified by needle INDEX so failure output never reproduces
 *  the credential. */
export function scanForPlaintext(root: string, needles: string[]): PlaintextHit[] {
  const encoded: EncodedNeedle[] = needles.flatMap((n, needleIndex) => [
    { buf: Buffer.from(n, "utf8"), needleIndex },
    { buf: Buffer.from(n, "utf16le"), needleIndex },
  ]);
  const maxNeedleLen = Math.max(0, ...encoded.map((e) => e.buf.length));
  const hits: PlaintextHit[] = [];
  const entries = readdirSync(root, { recursive: true, withFileTypes: true });
  for (const entry of entries) {
    const path = join(entry.parentPath, entry.name);
    needles.forEach((n, needleIndex) => {
      if (n.length > 0 && entry.name.includes(n)) hits.push({ file: path, needleIndex, via: "path" });
    });
    if (!entry.isFile()) continue;
    for (const needleIndex of scanFile(path, encoded, needles.length, maxNeedleLen)) {
      hits.push({ file: path, needleIndex, via: "content" });
    }
  }
  return hits;
}

/** Newest file mtime under `root` (ms). A file vanishing between
 *  listing and stat means a writer is STILL active — report "now" so
 *  the quiescence poll keeps waiting. */
function newestMtime(root: string): number {
  let newest = 0;
  const entries = readdirSync(root, { recursive: true, withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    try {
      const m = statSync(join(entry.parentPath, entry.name)).mtimeMs;
      if (m > newest) newest = m;
    } catch {
      newest = Date.now();
    }
  }
  return newest;
}

/**
 * Wait until no file under `root` has been modified for `settleMs`
 * and the tree's newest mtime is stable across two consecutive polls.
 *
 * Guards the post-exit scan point (PS-1): WebDriver's `deleteSession`
 * does not contractually wait for the app and WebKit's auxiliary
 * processes (NetworkProcess — localStorage WAL checkpoint, disk-cache
 * flush) to exit and flush, so scanning immediately after teardown
 * could miss late writes — a silent false-green. A tree that never
 * settles is itself a finding (leaked writer process), hence the loud
 * throw on timeout.
 */
export async function waitForFsQuiescence(
  root: string,
  opts: { settleMs?: number; timeoutMs?: number; pollMs?: number } = {},
): Promise<void> {
  const { settleMs = 1_000, timeoutMs = 20_000, pollMs = 250 } = opts;
  const deadline = Date.now() + timeoutMs;
  let prev = -1;
  for (;;) {
    const newest = newestMtime(root);
    if (newest === prev && Date.now() - newest >= settleMs) return;
    prev = newest;
    if (Date.now() > deadline) {
      throw new Error(
        `fs not quiescent under ${root} after ${timeoutMs} ms — something is still writing (leaked process?)`,
      );
    }
    await sleep(pollMs);
  }
}
