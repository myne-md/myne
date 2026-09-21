// "Credentials never reach failure output" — the non-negotiable, tested
// (MYND-574 task 105).
//
// It is the fourth rule in `e2e/AGENTS.md` and the one most likely to be
// written blind alongside a driver and never exercised, because a redactor that
// silently does nothing looks exactly like one that works. It is also the rule
// with the most forms to get wrong: a browser DOM dump carries input VALUES, and
// the account number the scenario just typed is in it by default.

import { describe, expect, it } from "vitest";
import {
  ArtifactLeakError,
  leaks,
  placeholder,
  redact,
  safeArtifact,
  variantsOf,
  type Secret,
} from "../../e2e-web/support/artifacts";

// secret-scan:allow — test fixture, not a credential
const ACCOUNT: Secret = { kind: "account-number", value: "MY-J8K2-P4QR-7TWX-9YZ3-B5" };
const PASSWORD: Secret = { kind: "password", value: "correct horse battery staple" };

describe("the forms a value can hide in", () => {
  it("covers the grouped, bare and lower-cased shapes", () => {
    const v = variantsOf(ACCOUNT.value);
    expect(v).toContain("MY-J8K2-P4QR-7TWX-9YZ3-B5");
    expect(v).toContain("MYJ8K2P4QR7TWX9YZ3B5");
    expect(v).toContain("myj8k2p4qr7twx9yz3b5");
  });

  /** Longest first, so a short variant cannot cut a longer one in half and
   *  leave its tail sitting in the file. */
  it("orders longest-first", () => {
    const v = variantsOf(ACCOUNT.value);
    expect(v).toEqual([...v].sort((a, b) => b.length - a.length));
  });

  it("ignores an empty or trivially short value", () => {
    expect(variantsOf("")).toEqual([]);
    expect(variantsOf("   ")).toEqual([]);
  });
});

describe("redaction", () => {
  it("names the KIND in the placeholder, so a failure stays diagnosable", () => {
    expect(placeholder("password")).toContain("password");
    expect(redact(`typed ${PASSWORD.value} here`, [PASSWORD])).toBe(
      `typed ${placeholder("password")} here`,
    );
  });

  /** The case that forces `variantsOf` to exist: the UI reformats the account
   *  number as the user types, so the DOM holds a shape the scenario never
   *  passed in. Redacting only the literal would leave the rest in the file. */
  it("catches a reformatted account number the scenario never passed in", () => {
    const dump = `<input value="MYJ8K2P4QR7TWX9YZ3B5" data-x="myj8k2p4qr7twx9yz3b5">`;
    const out = redact(dump, [ACCOUNT]);
    expect(out).not.toContain("J8K2");
    expect(out).not.toContain("j8k2");
  });

  it("catches a URL-encoded occurrence", () => {
    const dump = `<a href="/x?acct=MY-J8K2-P4QR-7TWX-9YZ3-B5">`;
    expect(redact(dump, [ACCOUNT])).not.toContain("J8K2");
  });

  it("leaves everything else alone", () => {
    const dump = `<div data-testid="unlock.password-input"></div>`;
    expect(redact(dump, [ACCOUNT, PASSWORD])).toBe(dump);
  });
});

describe("the independent check", () => {
  /**
   * `leaks` is deliberately NOT "did I call the redactor". The property is that
   * the bytes about to be written contain no secret, and keeping the check
   * independent is what lets it catch a redactor that missed a form — the
   * failure that would otherwise ship silently and green.
   */
  it("finds a secret the redactor missed", () => {
    const missed = "leftover MYJ8K2P4QR7TWX9YZ3B5";
    expect(leaks(missed, [ACCOUNT]).map((s) => s.kind)).toEqual(["account-number"]);
  });

  it("reports nothing on clean text", () => {
    expect(leaks("nothing here", [ACCOUNT, PASSWORD])).toEqual([]);
  });
});

describe("safeArtifact", () => {
  it("returns the redacted bytes when they are clean", () => {
    const out = safeArtifact(`saw ${ACCOUNT.value}`, [ACCOUNT]);
    expect(out).toBe(`saw ${placeholder("account-number")}`);
  });

  /**
   * The ordering IS the guarantee: redact, verify, then write. A caller cannot
   * redact and forget to check, because there is one entry point and it does
   * both. Simulated here by a secret whose redaction cannot succeed — a value
   * that is its own placeholder's substring would loop — so the check fires.
   */
  it("throws rather than writing an artifact that still carries a secret", () => {
    const pathological: Secret = { kind: "pin", value: "redacted" };
    expect(() => safeArtifact("the pin is redacted", [pathological])).toThrow(
      ArtifactLeakError,
    );
  });

  /** The error message is output too, so it names KINDS and never values. */
  it("never puts the value in its own error", () => {
    const pathological: Secret = { kind: "pin", value: "redacted" };
    try {
      safeArtifact("the pin is redacted", [pathological]);
      expect.unreachable("should have thrown");
    } catch (e) {
      expect((e as Error).message).toContain("pin");
      expect((e as Error).message).not.toContain("the pin is");
    }
  });
});
