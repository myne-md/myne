// Mobile ships no Developer mode — myne-md/myne#557, the
// `settings.block.developer-mode` bullet.
//
// # The bullet's premise, and what measuring found
//
// The bullet reads: "what the gate reveals on a phone, and that nothing orphaned
// is left behind on toggle-off, are DOM assertions on `mobile/src`." Both halves
// assume a gate exists there. It does not. A scan of the whole mobile tree finds
// exactly one occurrence of `developer_mode`, and it is a COMMENT in
// `HideVaultNamesBlock.tsx` explaining why that particular row is deliberately
// NOT gated on it. There is no toggle, no gated block, and nothing to orphan.
//
// # Why that is worth a test rather than a shrug
//
// The desktop gate hides individual settings inside core panels as well as the
// whole Developer rail group (`src/AGENTS.md`), and the two clients share
// `vault.prefs` — `developer_mode` is a real field that mobile reads and writes
// nothing to. So the moment somebody ports a gated setting across, mobile gains
// a gate with no toggle to open it: a setting that is invisible on the phone and
// visible on the desktop for the same vault, with no way to tell from the phone
// that it is there.
//
// This fails the day that happens, which is the day the roster row acquires a
// subject and has to be re-derived rather than left retired. Same shape as
// `tests/hooks/attachmentTransfersHasNoWriter.test.tsx` on the desktop side: an
// assertion whose value is entirely in when it STOPS holding.

import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const MOBILE_SRC = join(process.cwd(), "src");

/** Every TS/TSX source under `mobile/src`. */
function sources(): string[] {
  const out: string[] = [];
  const walk = (d: string) => {
    for (const name of readdirSync(d)) {
      if (name === "node_modules" || name === "dist") continue;
      const p = join(d, name);
      if (statSync(p).isDirectory()) walk(p);
      else if (/\.tsx?$/.test(name)) out.push(p);
    }
  };
  walk(MOBILE_SRC);
  return out;
}

/** Strip comments — prose about the desktop gate is not a gate. */
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
}

describe("the mobile tree has no Developer-mode gate", () => {
  it("scans a non-empty tree", () => {
    // A walk that found nothing would report ok forever.
    expect(sources().length).toBeGreaterThan(100);
  });

  it("no module reads or writes developer_mode outside a comment", () => {
    const hits = sources()
      .filter((p) => /developer_?[mM]ode/.test(stripComments(readFileSync(p, "utf8"))))
      .map((p) => relative(process.cwd(), p));
    expect(
      hits,
      "mobile gained a Developer-mode reference. If that is a GATE, the phone " +
        "now hides a setting the desktop shows for the same vault, and the " +
        "`settings.block.developer-mode` roster row has a subject on this " +
        "client again — re-derive it rather than deleting this assertion. If " +
        "it is a toggle, the gate needs its own reveal/orphan coverage.",
    ).toEqual([]);
  });

  it("the one occurrence in the tree is the comment that explains the absence", () => {
    // Pinned so the scan above cannot be passing because the comment moved and
    // took the reasoning with it.
    const block = readFileSync(
      join(MOBILE_SRC, "components/HideVaultNamesBlock.tsx"),
      "utf8",
    );
    expect(block).toContain("developer_mode");
    expect(
      stripComments(block).includes("developer_mode"),
      "the reference in HideVaultNamesBlock is no longer just a comment",
    ).toBe(false);
  });
});
