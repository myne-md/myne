// The plain-surface import guard, tested the only way a guard can be: by
// injecting the defect it claims to catch and watching it name that defect.
//
// The first case below is that injection. A fixture file under a temp
// `src/plain/` imports `../notes/vaultIndices`, and the spec asserts the
// analysis names the file, the specifier and the reason. If the denylist match
// or the import scan stops working, that assertion goes red, which is what
// makes the green runs below mean something. The repo's standing rule is stated
// in the root AGENTS.md: verifying a guard means breaking it, not running it.
//
// The real-tree case at the bottom is the other half and is deliberately not
// the whole test: a green run of the real tree proves only that today's three
// files are clean, and a scan that silently stopped walking would satisfy it
// too.

import { afterAll, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { analyse } from "../../scripts/check-plain-surface-imports.mjs";

interface Finding {
  file: string;
  line: number;
  spec: string;
  resolved: string;
  reason: string;
}

interface Analysis {
  findings: Finding[];
  checked: number;
}

const tmp = mkdtempSync(join(tmpdir(), "plain-surface-imports-"));

afterAll(() => {
  rmSync(tmp, { recursive: true, force: true });
});

/** Build `<tmp>/<case>/src/plain/<name>` with `source`, return that plain root. */
function fixture(caseName: string, name: string, source: string): string {
  const root = join(tmp, caseName, "src", "plain");
  const full = join(root, name);
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, source);
  return root;
}

describe("plain-surface import guard", () => {
  it("names a file that imports a vault module (the injected defect)", () => {
    const root = fixture(
      "vault-import",
      "bad.ts",
      [
        "// one ambient import is enough to break the no-vault guarantee",
        'import { tagTree } from "../notes/vaultIndices";',
        "",
        "export const list = tagTree;",
      ].join("\n"),
    );

    const { findings, checked } = analyse(root) as Analysis;

    expect(checked).toBe(1);
    expect(findings).toHaveLength(1);
    expect(findings[0]?.file).toContain("bad.ts");
    expect(findings[0]?.spec).toBe("../notes/vaultIndices");
    expect(findings[0]?.line).toBe(2);
    expect(findings[0]?.reason).toContain("src/notes/");
  });

  it("catches every import spelling and every denylisted family", () => {
    const root = fixture(
      "variants",
      "mixed.ts",
      [
        'export { listVaults } from "../lib/vault-list";',
        'const prefs = await import("../lib/prefs");',
        'const words = require("../lib/spell");',
        'import { Icon } from "../components/primitives/Icon";',
        'import { CMEditor } from "@myne/editor";',
        'import { open } from "../platform/plainFile";',
        'import type { Stage } from "../lib/stage";',
        "export const x = [prefs, words, Icon, CMEditor, open];",
        "export type S = Stage;",
      ].join("\n"),
    );

    const { findings } = analyse(root) as Analysis;

    expect(findings.map((f) => f.spec).sort()).toEqual([
      "../lib/prefs",
      "../lib/spell",
      "../lib/vault-list",
    ]);
  });

  it("walks nested directories, not just the root", () => {
    // A guard that read one level would pass the real tree today and stop
    // covering it the first time a subdirectory appears.
    const root = fixture(
      "nested",
      "sub/deep/bad.ts",
      ['import { prefsRead } from "../../../lib/prefs";'].join("\n"),
    );

    const { findings, checked } = analyse(root) as Analysis;

    expect(checked).toBe(1);
    expect(findings).toHaveLength(1);
    expect(findings[0]?.file).toContain("bad.ts");
  });

  it("passes a fixture whose imports are all allowed", () => {
    const root = fixture(
      "allowed",
      "ok.ts",
      [
        'import { useEffect } from "react";',
        'import { useTranslation } from "react-i18next";',
        'import { CMEditor } from "@myne/editor";',
        'import { Icon } from "../components/primitives/Icon";',
        'import { plainFileRead } from "../platform/plainFile";',
        'import type { Stage } from "../lib/stage";',
        'import { store } from "./store";',
        "export const ok = [useEffect, useTranslation, CMEditor, Icon, plainFileRead, store];",
        "export type S = Stage;",
      ].join("\n"),
    );

    const { findings, checked } = analyse(root) as Analysis;

    expect(checked).toBe(1);
    expect(findings).toEqual([]);
  });

  it("passes the real src/plain tree and reads something", () => {
    const { findings, checked } = analyse() as Analysis;

    // The non-vacuity half: `findings` being empty is also what a scan that
    // found no files returns, and an empty denominator is the failure mode the
    // CLI refuses by name.
    expect(checked).toBeGreaterThan(0);
    expect(findings).toEqual([]);
  });
});
