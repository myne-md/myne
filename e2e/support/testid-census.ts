// The dead-testid hint: when a wait for a `data-testid` expires, say whether the
// tree still renders that id at all.
//
// # The failure this exists for
//
// On 2026-11-01 commit 5624c67a withdrew the account-number join door on every
// client (`decisions/sync/0767`): `welcome.join-cta` and the whole `join.*` modal
// left `src/`. The web lane's sixteen specs were updated with it; three desktop
// call sites were not, so eight spec files through `setupTwoSyncedDevices` spent
// forty-five seconds each waiting for an element no build can produce, and read
// as a slow app rather than as a deleted affordance. It stayed that way for two
// days because nothing in the failure text could say "this id is gone".
//
// # Why a hint on the failure path rather than a guard on the commit
//
// A static guard cannot be exact: most of this suite's ids are built from
// template literals (`settings.tab-${topic}`, `first-run.identity.phrase-cell-N`),
// so an id absent from the source is normal and a guard that fails on it would be
// wrong more often than right. This asks the question only when a wait has ALREADY
// failed — where the answer is free, exact in the direction that matters (a
// substring census, not a parser) and cannot fail a green run.
//
// The census deliberately reads the SHARED tree only. A `web/`-only or
// `mobile/`-only id would be a false hint on the desktop lane, and the address of
// the hint ("nowhere under src/") is what makes it a hint rather than a verdict.

import type { Dirent } from "node:fs";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

/** Roots the shared UI tree lives in, relative to the repo root. */
const SHARED_ROOTS = ["src", "editor", "client-core", "copy", "ornaments"];

/** The id `testIdSelector` was asked for, or null when the selector carries none. */
export function testIdInSelector(selector: string): string | null {
  const match = /data-testid="([^"]+)"/.exec(selector);
  return match === null ? null : match[1];
}

let census: string | null = null;

/** Every `.ts`/`.tsx` byte under the shared roots, concatenated once. */
function sharedTreeText(): string {
  if (census !== null) return census;
  const chunks: string[] = [];
  const walk = (dir: string): void => {
    let entries: Dirent<string>[];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const path = join(dir, String(entry.name));
      if (entry.isDirectory()) {
        if (entry.name === "node_modules" || entry.name.startsWith(".")) continue;
        walk(path);
      } else if (entry.name.endsWith(".ts") || entry.name.endsWith(".tsx")) {
        try {
          chunks.push(readFileSync(path, "utf8"));
        } catch {
          /* an unreadable file cannot name an id; the rest still can */
        }
      }
    }
  };
  for (const root of SHARED_ROOTS) walk(join(process.cwd(), root));
  census = chunks.join("\n");
  return census;
}

/**
 * A sentence to append to a failed testid wait, or `""` when the id is present.
 *
 * Only ids that look like a whole id (`a.b`, no template marker) are checked,
 * because a partially-built id would report a false absence.
 */
export function missingTestIdHint(selector: string): string {
  const id = testIdInSelector(selector);
  if (id === null) return "";
  if (/[${}]|\*/.test(id)) return "";
  try {
    if (sharedTreeText().includes(id)) return "";
  } catch {
    return "";
  }
  return (
    `\n  NOTE: no file under ${SHARED_ROOTS.join("/, ")}/ mentions "${id}".` +
    " Nothing can render it, so this wait could not have succeeded: an affordance" +
    " was probably withdrawn (check `design-notes/` for the id's subject) rather" +
    " than an element that renders slowly."
  );
}
