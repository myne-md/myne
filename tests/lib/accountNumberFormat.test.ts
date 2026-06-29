// Unit tests for the account-number input mask (`src/lib/account-number-format`).
// Pins the as-you-type grouping behaviour and the two paste shapes (with /
// without the `MY-` prefix), plus idempotency — re-formatting a formatted
// value must not shift the groups.

import { describe, expect, it } from "vitest";

import { formatAccountNumberInput } from "../../src/lib/account-number-format";

describe("formatAccountNumberInput", () => {
  it("stays empty for empty input so the placeholder shows", () => {
    expect(formatAccountNumberInput("")).toBe("");
    expect(formatAccountNumberInput("   ")).toBe("");
  });

  it("does not over-eagerly dash while the user is still on the prefix", () => {
    expect(formatAccountNumberInput("M")).toBe("M");
    expect(formatAccountNumberInput("MY")).toBe("MY");
  });

  it("drops the first dash right after the prefix (MY3 → MY-3)", () => {
    expect(formatAccountNumberInput("MY3")).toBe("MY-3");
    expect(formatAccountNumberInput("MY3788")).toBe("MY-3788");
  });

  it("groups the canonical body into four-character runs as it grows", () => {
    expect(formatAccountNumberInput("MY3788N")).toBe("MY-3788-N");
    expect(formatAccountNumberInput("MY3788N3RM9QXCVBHT2ABC")).toBe(
      "MY-3788-N3RM-9QXC-VBHT-2ABC",
    );
  });

  it("normalizes lowercase and stray separators/spaces", () => {
    expect(formatAccountNumberInput("my-3788 n3rm")).toBe("MY-3788-N3RM");
    expect(formatAccountNumberInput("MY 3788")).toBe("MY-3788");
  });

  it("re-formats an already-formatted value identically (idempotent)", () => {
    const once = formatAccountNumberInput("MY3788N3RM9QXCVBHT2ABC");
    expect(formatAccountNumberInput(once)).toBe(once);
  });

  it("injects the MY- prefix for a prefix-less canonical paste", () => {
    expect(formatAccountNumberInput("3788N3RM9QXCVBHT2ABC")).toBe(
      "MY-3788-N3RM-9QXC-VBHT-2ABC",
    );
  });

  it("re-groups a fully dashed paste (MY-4K7P-...) without shifting", () => {
    expect(formatAccountNumberInput("MY-4K7P-N3RM-9QXC-VBHT-2ABC")).toBe(
      "MY-4K7P-N3RM-9QXC-VBHT-2ABC",
    );
  });

  it("drops overflow past the 20-char canonical body", () => {
    // 2 prefix + 20 body = 22 alnum chars; extras beyond are discarded.
    expect(formatAccountNumberInput("MY3788N3RM9QXCVBHT2ABCDEFG")).toBe(
      "MY-3788-N3RM-9QXC-VBHT-2ABC",
    );
  });
});
