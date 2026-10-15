// @vitest-environment jsdom
//
// The strength label is a DYNAMIC i18n key (`settings.strength.${suffix}`), so
// `check-i18n.mjs` cannot see it by construction. It shipped pointed at a
// namespace with no catalog block at all (`password.strength.*`), and every
// desktop password field rendered a raw key instead of a word
// (myne-md/myne#871). This file is the guard for that hole.
//
// Its `t` resolves against the REAL English catalog and answers the key
// unchanged on a miss: a stub that echoes `t(key) => key` can never fail a
// "did the product show the right string" assertion, so the miss has to be
// represented for the assertions below to mean anything.

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render } from "@testing-library/react";

vi.mock("react-i18next", async () => {
  const en = ((await import("../../locales/en/common.json")).default ?? {}) as Record<
    string,
    unknown
  >;
  const lookup = (key: string): string => {
    let node: unknown = en;
    for (const part of key.split(".")) {
      if (typeof node !== "object" || node === null || !(part in node)) return key;
      node = (node as Record<string, unknown>)[part];
    }
    return typeof node === "string" ? node : key;
  };
  return { useTranslation: () => ({ t: lookup }) };
});

const { PasswordStrength } = await import("../../src/components/PasswordStrength");

afterEach(cleanup);

const labelFor = (score: 0 | 1 | 2 | 3 | 4): string => {
  const { container } = render(<PasswordStrength score={score} />);
  return container.querySelector("span")?.textContent ?? "";
};

const CASES: ReadonlyArray<readonly [0 | 1 | 2 | 3 | 4, string]> = [
  [0, "Too weak"],
  [1, "Too weak"],
  [2, "Weak"],
  [3, "Fair"],
  [4, "Strong"],
];

describe("PasswordStrength labels", () => {
  it.each(CASES)("score %i renders the catalog string %s", (score, expected) => {
    expect(labelFor(score)).toBe(expected);
  });
});
