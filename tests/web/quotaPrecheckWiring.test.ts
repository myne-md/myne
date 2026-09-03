// The quota precheck's header may not describe behaviour the client does not
// have. myne-md/myne#556, the `web.storage.quota-exhaustion` bullet:
//
//   > chromedriver's CDP passthrough exposes `Storage.overrideQuotaForOrigin`,
//   > so a tiny quota can be set for the test origin without touching the disk;
//   > refusal-before-writing, the named shortfall and the fresh-sync-on-reload
//   > are then deterministic.
//
// # Why that scenario cannot be written, and what this is instead
//
// `web/src/quota-precheck.ts` has NO production importer. Only its unit test
// imports it. `scripts/check-unwired.mjs` already records that, honestly:
//
//   "UNWIRED — the storage-quota precheck. Its unit test imports it; the boot
//    path does not, so the precheck the web client is documented to run does
//    not run."
//
// So a browser scenario driving `Storage.overrideQuotaForOrigin` would be
// setting a tiny quota and asserting a refusal that nothing can produce. It
// would fail, and it would fail saying the app ignored the quota — which is
// true and useless, because the code that would honour it is not on any path.
//
// What is NOT recorded anywhere is that the MODULE'S OWN HEADER states the
// behaviour as fact:
//
//   "So the check happens **before any write**, and a refusal leaves nothing
//    behind."
//
// A reader of that file — including the next person deciding whether this area
// needs work — learns something false. That is the same defect class as the
// `web/container/Caddyfile` comment that named a service-worker cache the
// container does not deploy (`tests/web/serviceWorkerClaim.test.ts`, same
// issue): the header was right about the design and wrong about the present
// tense, and a file operators and maintainers read to learn what the system
// does is the worst place to be wrong about that.
//
// # How this test stays honest in BOTH directions
//
// It is not "assert the module is unwired forever". It pairs the two facts:
//
//   * while there is no production importer, the header must carry the
//     not-yet-wired notice;
//   * the day a production importer lands, that notice must go — and this test
//     fails until it does, so the pair is re-examined together instead of one
//     of them quietly going stale.
//
// The importer set is derived from the tree, not rostered here, for the reason
// `check-unwired.mjs` gives: a roster is a second thing to keep in step.

import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const REPO_ROOT = process.cwd();
const MODULE = "web/src/quota-precheck.ts";

/** The sentence the header must carry exactly while the module is unwired. */
const NOT_WIRED_NOTICE = "NOT WIRED YET";

/** Trees a production importer could live in. `tests/` is excluded on purpose:
 *  a test-only importer is what makes this module unwired in the first place. */
const PRODUCTION_ROOTS = ["web/src", "src", "editor/src", "dialect/src"];

function walk(dir: string, out: string[]): string[] {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  for (const name of entries) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) {
      walk(full, out);
    } else if (/\.(ts|tsx)$/.test(name)) {
      out.push(full);
    }
  }
  return out;
}

/** Production files that import the module, by repo-relative path. */
function productionImporters(): string[] {
  const found: string[] = [];
  for (const root of PRODUCTION_ROOTS) {
    for (const file of walk(join(REPO_ROOT, root), [])) {
      const rel = relative(REPO_ROOT, file);
      if (rel === MODULE) continue;
      const source = readFileSync(file, "utf8");
      if (/from\s+["'][^"']*quota-precheck["']/.test(source)) found.push(rel);
    }
  }
  return found;
}

describe("the quota precheck's header matches the client (myne-md/myne#556)", () => {
  it("carries the not-yet-wired notice for exactly as long as it is unwired", () => {
    const header = readFileSync(join(REPO_ROOT, MODULE), "utf8");
    const importers = productionImporters();
    const declared = header.includes(NOT_WIRED_NOTICE);

    if (importers.length === 0) {
      expect(
        declared,
        `${MODULE} has no production importer, and its header does not say so. ` +
          `It states "the check happens before any write, and a refusal leaves ` +
          `nothing behind" as fact — of a module nothing calls. Anyone reading it ` +
          `to decide whether this area needs work concludes it is done. Add the ` +
          `"${NOT_WIRED_NOTICE}" notice, or wire the precheck.`,
      ).toBe(true);
      return;
    }

    expect(
      declared,
      `${MODULE} now HAS production importer(s) — ${importers.join(", ")} — and its ` +
        `header still carries the "${NOT_WIRED_NOTICE}" notice. That is the same ` +
        `staleness in the other direction: the file now understates what the ` +
        `client does. Remove the notice, drop the module's entry from ` +
        `scripts/check-unwired.mjs, and the browser scenario the ` +
        `web.storage.quota-exhaustion bullet asks for becomes writable — CDP's ` +
        `Storage.overrideQuotaForOrigin can then drive a real refusal.`,
    ).toBe(false);
  });
});
