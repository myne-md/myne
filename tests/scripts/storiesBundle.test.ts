// Drives `scripts/check-stories-bundle.mjs` (myne-md/myne#832).
//
// Every defect the guard claims to catch is injected here and the guard must
// name it: an unrecorded origin, the BIP-39 word list, an unrecorded
// account-number-shaped string, and a global that is not the host's. The
// build-free guards get the same treatment in their own specs.

import { describe, expect, it } from "vitest";
import {
  classifyText,
  findBundleProblems,
  ALLOWED_GLOBALS,
} from "../../scripts/check-stories-bundle.mjs";

const files = (...texts: string[]) => texts.map((text, i) => ({ path: `f${i}`, text }));

describe("check-stories-bundle.classifyText", () => {
  it("separates origins, word-list markers, accounts and globals", () => {
    const found = classifyText(
      'x="https://evil.example"; y="abandon"; z="MY-ABCD-EFGH-JKMN-PQRS-TVWX"; w=__TAURI_INTERNALS__;',
    );
    expect(found.origins).toContain("https://evil.example");
    expect(found.wordlist).toContain("abandon");
    expect(found.accounts).toContain("MY-ABCD-EFGH-JKMN-PQRS-TVWX");
    expect(found.globals).toContain("__TAURI_INTERNALS__");
  });

  it("does not match a bare substring like zoom for zoo", () => {
    expect(classifyText("zoom(3)").wordlist).toEqual([]);
  });
});

describe("check-stories-bundle.findBundleProblems", () => {
  it("passes a bundle with only recorded values", () => {
    const problems = findBundleProblems({
      files: files('"https://myne.md"; x=__TAURI_INTERNALS__;'),
    });
    expect(problems).toEqual([]);
  });

  it("names an unrecorded origin", () => {
    const problems = findBundleProblems({ files: files('"https://evil.example"') });
    expect(problems.some((p) => p.includes("evil.example"))).toBe(true);
  });

  it("names the BIP-39 word list", () => {
    const problems = findBundleProblems({ files: files('["abandon","ability"]') });
    expect(problems.some((p) => p.includes("BIP-39"))).toBe(true);
  });

  it("names a SPACE-JOINED word list, which the quoted-marker check misses", () => {
    // One string, so `"abandon"` never appears with its closing quote. The
    // sequence check is what catches this shape.
    const problems = findBundleProblems({
      files: files('"abandon ability able about above absent"'),
    });
    expect(problems.some((p) => p.includes("BIP-39"))).toBe(true);
  });

  it("names an unrecorded account-shaped string", () => {
    const problems = findBundleProblems({ files: files('"MY-1234-5678-9JKM-NPQR-STVW"') });
    expect(problems.some((p) => p.includes("account-number-shaped"))).toBe(true);
  });

  it("allows a recorded account placeholder", () => {
    const problems = findBundleProblems({
      files: files('"MY-XXXX-XXXX-XXXX-XXXX-XXXX"'),
    });
    expect(problems).toEqual([]);
  });

  it("names a global that is not the host's", () => {
    const problems = findBundleProblems({ files: files("window.__myneTestHook = 1;") });
    expect(problems.some((p) => p.includes("__myneTestHook"))).toBe(true);
  });

  it("allows only Tauri's own runtime keys, never a __myne hook", () => {
    for (const g of ALLOWED_GLOBALS) expect(g.startsWith("__TAURI")).toBe(true);
    expect([...ALLOWED_GLOBALS].some((g) => g.startsWith("__myne"))).toBe(false);
  });
});
