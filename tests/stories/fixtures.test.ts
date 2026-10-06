// Fixture safety (myne-md/myne#832 task 5).
//
// Fixtures are synthetic by contract. A fixture that carried a recovery phrase or
// a real account number would put it in a served page, and no type would notice.
// This spec runs every named fixture's handlers and rejects both shapes.
//
// It is the source-side twin of `check-stories-bundle.mjs`, which makes the same
// assertion about the built artefact.

import { describe, expect, it } from "vitest";
import { FIXTURES, resolveFixture } from "../../stories/fixtures";

/** 24 lowercase BIP-39-ish words separated by spaces. */
const PHRASE_SHAPE = /\b(?:[a-z]{3,8}\s+){23}[a-z]{3,8}\b/;
/** A Myne account-number display string. */
const ACCOUNT_SHAPE = /MY-[A-Z0-9]{4}(?:-[A-Z0-9]{4}){4}/;

/** The schema's own illustrative values, allowed in fixtures. */
const ALLOWED_ACCOUNTS = new Set(["MY-ABCD-EFGH-JKMN-PQRS-TVWX", "MY-XXXX-XXXX-XXXX-XXXX-XXXX"]);

function serialiseFixture(name: string): string {
  const fixture = FIXTURES[name];
  const parts: string[] = [fixture.description];
  for (const handler of Object.values(fixture.handlers ?? {})) {
    parts.push(JSON.stringify(handler({})));
  }
  return parts.join("\n");
}

describe("fixtures", () => {
  it("has at least one fixture (an empty set reads as a pass)", () => {
    expect(Object.keys(FIXTURES).length).toBeGreaterThan(0);
  });

  for (const name of Object.keys(FIXTURES)) {
    it(`${name} carries no recovery phrase`, () => {
      expect(serialiseFixture(name)).not.toMatch(PHRASE_SHAPE);
    });

    it(`${name} carries no real account number`, () => {
      const text = serialiseFixture(name);
      for (const m of text.matchAll(new RegExp(ACCOUNT_SHAPE, "g"))) {
        expect(ALLOWED_ACCOUNTS.has(m[0]), `unexpected account-shaped string ${m[0]} in ${name}`).toBe(
          true,
        );
      }
    });
  }

  it("resolveFixture rejects an unknown name by name", () => {
    expect(() => resolveFixture("does-not-exist")).toThrow(/does-not-exist/);
  });

  it("resolveFixture passes an inline fixture through", () => {
    const inline = { description: "inline" };
    expect(resolveFixture(inline)).toBe(inline);
  });
});
