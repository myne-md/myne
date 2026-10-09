// @vitest-environment node
//
// The token-consumer guard (myne-md/myne#847 tasks 12 and 13).
//
// A guard is proven by injecting the defect it claims to catch. The first case
// is the one the guard found on its real first run: two duration tokens the sheet
// declares and no shipped rule reads.

import { describe, expect, it } from "vitest";
import {
  THEME_ONLY,
  consumedTokens,
  familyTokens,
  staleExemptions,
  unusedTokens,
} from "../../scripts/check-token-consumers.mjs";

const SHEET = `
:root {
  --duration-fast: 120ms;
  --duration-slow: 260ms;
  --ease-standard: cubic-bezier(0.2, 0, 0, 1);
  --text-sm: 13px;
  --space-3: 12px;
  --accent: #2c4a7a;
}
`;

describe("the token-consumer guard", () => {
  it("selects only the duration, ease and text families", () => {
    const families = familyTokens(SHEET);
    expect([...families].sort()).toEqual([
      "--duration-fast",
      "--duration-slow",
      "--ease-standard",
      "--text-sm",
    ]);
    // A colour and a spacing step are NOT in scope: both have a visible specimen
    // (a swatch, a bar), so an unused one is visible without a guard.
    expect(families.has("--accent")).toBe(false);
    expect(families.has("--space-3")).toBe(false);
  });

  it("counts a `var()` read, and not a bare mention", () => {
    const files = {
      "a.css": ".x { transition: color var(--duration-fast) ease; }",
      "b.ts": 'const s = { transition: "var(--ease-standard)" };',
      // A mention in prose is not a read: the sheet's own comment names tokens
      // and a comment-aware scan would report the wrong thing either way.
      "c.ts": "// we use --duration-slow for the long end",
    };
    const used = consumedTokens(Object.keys(files), (p) => files[p as keyof typeof files]);
    expect(used.has("--duration-fast")).toBe(true);
    expect(used.has("--ease-standard")).toBe(true);
    expect(used.has("--duration-slow")).toBe(false);
  });

  it("names a duration token that nothing reads", () => {
    // The injection: the defect the guard claims to catch.
    const used = consumedTokens(["a.css"], () => ".x { transition: color var(--duration-fast) ease; }");
    const unused = [...familyTokens(SHEET)].filter((name) => !used.has(name));
    expect(unused).toContain("--duration-slow");
  });

  it("keeps a recorded exemption out of the unused set", () => {
    // The guard's central decision, driven directly: `--duration-slow` is
    // declared and unread, and the exemption is what keeps the tree green.
    const used = consumedTokens(["a.css"], () => ".x { color: var(--duration-fast); }");
    expect(unusedTokens(familyTokens(SHEET), used, { "--duration-slow": "reason" })).not.toContain(
      "--duration-slow",
    );
  });

  it("reports an exemption whose token has gained a consumer", () => {
    // The other arm: an exemption that has stopped describing anything fails, so
    // the list cannot quietly outlive the fact it records.
    const used = consumedTokens(["a.css"], () => ".x { color: var(--duration-slow); }");
    expect(staleExemptions(used, { "--duration-slow": "reason" })).toEqual(["--duration-slow"]);
  });

  it("ships the exemptions the guard records, each with a reason", () => {
    // Non-vacuity: the exported map is the one the executable half reads, and a
    // reasonless entry would be a token the guard silently stopped checking.
    for (const [name, reason] of Object.entries(THEME_ONLY)) {
      expect(name.startsWith("--")).toBe(true);
      expect((reason as string).length).toBeGreaterThan(20);
    }
  });
});
