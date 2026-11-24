// The manifest grammar, pinned.
//
// `workspace/manifest.txt` is read by three things and two of them are
// JavaScript sharing `scripts/lib/repo-manifest.mjs`. The grammar grew a
// `(private)` annotation when `setup.sh` needed to tell "you are not a member of
// this private repo" apart from "this repo is meant to be public and is missing",
// and every consumer that read raw lines as names broke on the same day. None of
// them would have said so: one would have reported a renamed companion, the other
// a missing directory, and both messages point at the wrong file.

import { existsSync, readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { manifestRepos } from "../../scripts/lib/repo-manifest.mjs";

describe("manifestRepos", () => {
  it("reads a bare name", () => {
    expect(manifestRepos("myne-server\n")).toEqual([{ name: "myne-server", private: false }]);
  });

  it("separates the (private) annotation from the name", () => {
    // The exact drift that broke both consumers: a raw-line reader compares
    // `myne-ops (private)` against `myne-ops` and finds nothing.
    expect(manifestRepos("myne-ops (private)\n")).toEqual([
      { name: "myne-ops", private: true },
    ]);
  });

  it("ignores comments and blank lines, and a comment after an entry", () => {
    const text = [
      "# Myne workspace manifest",
      "",
      "myne-server",
      "   ",
      "myne-ops (private) # holds prod hosts",
      "myne-website",
      "",
    ].join("\n");
    expect(manifestRepos(text)).toEqual([
      { name: "myne-server", private: false },
      { name: "myne-ops", private: true },
      { name: "myne-website", private: false },
    ]);
  });

  it("takes the name up to the first whitespace, not the whole line", () => {
    expect(manifestRepos("myne-agents\t(private)\n").map((e) => e.name)).toEqual([
      "myne-agents",
    ]);
  });

  it("does not invent an entry from a file that is only comments", () => {
    // The other direction. A parser that answered with one empty name would make
    // `setup.sh` try to clone `""`, and would make a guard's roster check pass on
    // a manifest nobody had filled in.
    expect(manifestRepos("# nothing but a comment\n\n")).toEqual([]);
  });

  it.skipIf(!existsSync("workspace/manifest.txt"))("reads the published manifest and lists only public companions", () => {
    const listed = manifestRepos(readFileSync("workspace/manifest.txt", "utf8"));
    expect(listed.filter((e) => e.private)).toEqual([]);
    expect(listed.map((e) => e.name)).toEqual([
      "myne-test-vectors",
      "myne-server",
      "myne-website",
      "myne-clipper",
      "myne-themes",
      "myne-branding",
      "myne-pi-plugin",
    ]);
    for (const entry of listed) expect(entry.name).not.toContain(" ");
  });
});
