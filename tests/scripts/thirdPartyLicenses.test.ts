// Injection tests for `gen-third-party-licenses.mjs`.
//
// Root `AGENTS.md`: verifying a guard means BREAKING it. This file's subject is
// the generator that owns the shipped third-party notice, and the failure it
// exists to prevent is a notice that is complete on the day it is written and
// silently incomplete afterwards. So each case below injects a drift class and
// asserts the generated text names it rather than absorbing it.

import { describe, expect, it } from "vitest";

import { flatten, licenceText, normalise, render } from "../../scripts/gen-third-party-licenses.mjs";

/** An injected filesystem: `dirs` maps a directory to its entries, `files` a path to its text. */
function fakeFs(dirs: Record<string, string[]>, files: Record<string, string>) {
  return {
    readDir: (d: string): string[] => {
      const entries = dirs[d];
      if (entries === undefined) throw new Error(`ENOTDIR: ${d}`);
      return entries;
    },
    readFile: (f: string): string => {
      const text = files[f];
      if (text === undefined) throw new Error(`EISDIR or ENOENT: ${f}`);
      return text;
    },
  };
}

function payload(groups: Record<string, Array<{ name: string; version: string; dir?: string }>>) {
  const out: Record<string, unknown[]> = {};
  for (const [licence, entries] of Object.entries(groups)) {
    out[licence] = entries.map((e) => ({
      name: e.name,
      versions: [e.version],
      paths: [e.dir ?? `/nm/${e.name}`],
      license: licence === "Unknown" ? undefined : licence,
    }));
  }
  return out;
}

describe("flatten", () => {
  it("pairs each version with its own directory, pnpm's `+` key and all", () => {
    const rows = flatten({
      MIT: [
        {
          name: "@braintree/sanitize-url",
          versions: ["6.0.2", "7.1.2"],
          paths: [
            "/nm/.pnpm/@braintree+sanitize-url@6.0.2/node_modules/@braintree/sanitize-url",
            "/nm/.pnpm/@braintree+sanitize-url@7.1.2/node_modules/@braintree/sanitize-url",
          ],
          license: "MIT",
        },
      ],
    });
    expect(rows.map((r) => `${r.name}@${r.version}`)).toEqual([
      "@braintree/sanitize-url@6.0.2",
      "@braintree/sanitize-url@7.1.2",
    ]);
    expect(rows[1].dir).toContain("@7.1.2/");
  });

  it("sorts by lowercase name so case differences cannot reorder the file", () => {
    const rows = flatten(
      payload({
        MIT: [
          { name: "zebra", version: "1.0.0" },
          { name: "Alpha", version: "1.0.0" },
          { name: "apple", version: "1.0.0" },
        ],
      }),
    );
    expect(rows.map((r) => r.name)).toEqual(["Alpha", "apple", "zebra"]);
  });
});

describe("licenceText", () => {
  it("collects every licence-bearing file, case-insensitively, and trims", () => {
    const { readDir, readFile } = fakeFs(
      { "/p/a": ["package.json", "LICENSE", "notice.txt", "COPYING"] },
      {
        "/p/a/LICENSE": "  MIT text  \n",
        "/p/a/notice.txt": "extra notice\n",
        "/p/a/COPYING": "copying text\n",
      },
    );
    // Raw order is by file name (ASCII, so uppercase first); the normalisation
    // that strips trailing spaces happens in `render`, not here.
    expect(licenceText("/p/a", readDir, readFile)).toBe(
      "copying text\n  MIT text  \nextra notice",
    );
  });

  it("normalises CRLF and per-line trailing whitespace for the artefact", () => {
    // Upstream licence files are authored on Windows and by editors that pad.
    // The repository's own `whitespace` pre-commit check refuses both, so the
    // artefact is normalised rather than the check being widened for it.
    expect(normalise("a  \r\nb\t\r\n\r\nc")).toBe("a\nb\n\nc");
  });

  it("returns empty when a package ships none", () => {
    const { readDir, readFile } = fakeFs({ "/p/a": ["package.json", "index.js"] }, {});
    expect(licenceText("/p/a", readDir, readFile)).toBe("");
  });

  it("is not fatal when a licence-named entry is a directory", () => {
    // A package whose `LICENSE` is a folder of texts. The read fails; the rest
    // of the file must still come through rather than the whole block vanish.
    const { readDir, readFile } = fakeFs(
      { "/p/a": ["LICENSE", "LICENSE.txt"] },
      { "/p/a/LICENSE.txt": "the real one\n" },
    );
    expect(licenceText("/p/a", readDir, readFile)).toBe("the real one");
  });

  it("tolerates a directory it cannot read at all", () => {
    const { readDir, readFile } = fakeFs({}, {});
    expect(licenceText("/p/a", readDir, readFile)).toBe("");
  });
});

describe("render", () => {
  const fs2 = fakeFs(
    { "/nm/a": ["LICENSE"], "/nm/b": ["LICENSE"] },
    { "/nm/a/LICENSE": "A MIT text\n", "/nm/b/LICENSE": "B Apache text\n" },
  );

  it("lists every package and reproduces every text", () => {
    const out = render(
      flatten(payload({ MIT: [{ name: "a", version: "1.0.0" }], "Apache-2.0": [{ name: "b", version: "2.0.0" }] })),
      fs2.readDir,
      fs2.readFile,
    );
    expect(out).toContain("Packages (2)");
    expect(out).toContain("a 1.0.0 — MIT");
    expect(out).toContain("b 2.0.0 — Apache-2.0");
    expect(out).toContain("A MIT text");
    expect(out).toContain("B Apache text");
  });

  it("a package ADDED to the tree changes the file", () => {
    const before = render(flatten(payload({ MIT: [{ name: "a", version: "1.0.0" }] })), fs2.readDir, fs2.readFile);
    const after = render(
      flatten(payload({ MIT: [{ name: "a", version: "1.0.0" }, { name: "b", version: "2.0.0" }] })),
      fs2.readDir,
      fs2.readFile,
    );
    expect(before).not.toBe(after);
    expect(after).toContain("Packages (2)");
  });

  it("a package REMOVED from the tree changes the file", () => {
    const after = render(flatten(payload({ MIT: [{ name: "a", version: "1.0.0" }] })), fs2.readDir, fs2.readFile);
    expect(after).not.toContain("b 2.0.0");
    expect(after).toContain("Packages (1)");
  });

  it("a LICENSE CHANGE changes the file", () => {
    const before = render(flatten(payload({ MIT: [{ name: "a", version: "1.0.0" }] })), fs2.readDir, fs2.readFile);
    const swapped = fakeFs({ "/nm/a": ["LICENSE"] }, { "/nm/a/LICENSE": "a DIFFERENT text\n" });
    const after = render(flatten(payload({ MIT: [{ name: "a", version: "1.0.0" }] })), swapped.readDir, swapped.readFile);
    expect(before).not.toBe(after);
  });

  it("a package with no declared licence is called out by name", () => {
    // khroma@2.1.0 is the live case: it declares nothing in its manifest. A
    // notice that lists it beside MIT packages without saying so reads as
    // compliance, which is the one thing it must not do.
    const out = render(flatten(payload({ Unknown: [{ name: "khroma", version: "2.1.0" }] })), fs2.readDir, fs2.readFile);
    expect(out).toContain("ATTENTION: 1 package(s) declare no licence at all: khroma@2.1.0");
  });

  it("a package that ships no licence text says so in its own block", () => {
    const bare = fakeFs({ "/nm/a": ["package.json"] }, {});
    const out = render(flatten(payload({ MIT: [{ name: "a", version: "1.0.0" }] })), bare.readDir, bare.readFile);
    expect(out).toContain("a 1.0.0 — MIT");
    expect(out).toContain("ships no readable licence file");
  });

  it("is byte-stable for the same input", () => {
    const rows = flatten(payload({ MIT: [{ name: "a", version: "1.0.0" }] }));
    expect(render(rows, fs2.readDir, fs2.readFile)).toBe(render(rows, fs2.readDir, fs2.readFile));
  });
});
