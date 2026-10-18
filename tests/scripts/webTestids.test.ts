// Injection tests for the two halves of `check-web-testids.mjs` that
// myne-md/myne#560 changed: the `data-*` detector and the pre-unlock scope.
//
// The guard is security-load-bearing. Its leak budget exists because the account
// number is pre-unlock INPUT, and a `data-*` carrying it puts it in the DOM, in
// screenshots and in every CI failure artefact. Before this change it read only
// the JSX form (`data-x={expr}`) and only files under `src/screens` and
// `web/src/screens`, and both limits were reachable at once: a props object
// built in `src/hooks/useScrollEdges.ts` and spread by
// `src/components/primitives/CenteredCard.tsx` put two runtime-valued
// attributes onto both pre-unlock screens with the guard reporting ok.
//
// Both directions are covered, because that is what the rule asks for: the new
// defect class must fire, and the OLD one must still fire. A guard that stops
// checking is green by definition, and the second direction is the one nobody
// thinks to try.

import { describe, expect, it } from "vitest";
import {
  curatedTestIdProps,
  dynamicDataAttrs,
  interpolatedTestIdObjectForm,
  isCallerSuppliedTestIdExpr,
  preUnlockScope,
  selectorsIn,
  sharedWebOnlyScreens,
  staleRenderNothingEntries,
} from "../../scripts/check-web-testids.mjs";
import { VERDICTS } from "../../scripts/check-web-screens.mjs";

describe("dynamicDataAttrs: the JSX form (what it always caught)", () => {
  it("names an attribute fed an expression", () => {
    expect(dynamicDataAttrs('<div data-value={account} />')).toEqual(["data-value"]);
  });

  it("passes a string literal", () => {
    expect(dynamicDataAttrs('<div data-wall="no-account" />')).toEqual([]);
  });
});

describe("dynamicDataAttrs: the object form (what shipped past it)", () => {
  it("names an attribute built in a props object", () => {
    const src = 'const p = { "data-account": String(n) };';
    expect(dynamicDataAttrs(src)).toEqual(["data-account"]);
  });

  it("names it through a ternary, the exact shape that reached the card", () => {
    const src = 'return { "data-fade-top": edges.top ? "true" : undefined };';
    expect(dynamicDataAttrs(src)).toEqual(["data-fade-top"]);
  });

  it("passes a constant string value", () => {
    expect(dynamicDataAttrs('const p = { "data-mode": "compact" };')).toEqual([]);
  });

  it("accepts single quotes, and a template only when it interpolates nothing", () => {
    expect(dynamicDataAttrs("const p = { 'data-x': value };")).toEqual(["data-x"]);
    expect(dynamicDataAttrs('const p = { "data-x": `literal` };')).toEqual([]);
  });

  it("names an INTERPOLATING template, the one shape that can carry the account number", () => {
    // The hole this arm shipped with. The value's first character was compared
    // against a set that included the backtick, so every template read as a
    // constant, and a template is the obvious way an account number reaches a
    // props-object `data-*`. Asserted next to its own negative case above,
    // because a matcher that reports everything is as useless as one that
    // reports nothing.
    expect(dynamicDataAttrs("const p = { 'data-leak': `${account}` };")).toEqual([
      "data-leak",
    ]);
    expect(dynamicDataAttrs('const p = { "data-leak": `MY-${n}` };')).toEqual([
      "data-leak",
    ]);
  });
});

describe("dynamicDataAttrs: the two things it must NOT report", () => {
  it("ignores prose about the rule", () => {
    // This guard flagged its own comment once already.
    expect(dynamicDataAttrs('// never write data-value={account} here\n')).toEqual([]);
    expect(dynamicDataAttrs('/* { "data-secret": x } */\n')).toEqual([]);
  });

  it("leaves `data-testid` to its own check", () => {
    // A curated-prop component taking an explicit `testId` is the sanctioned
    // shape (`src/AGENTS.md`, "Test observability"), and the interpolated-testid
    // rule two checks down owns it. Reporting it here would say the wrong thing
    // about it, in a message about the account number.
    expect(dynamicDataAttrs("<div data-testid={testId} />")).toEqual([]);
  });
});

describe("preUnlockScope: the screens plus what they compose", () => {
  const scope = preUnlockScope([
    "src/screens/AccountNumberEntry.tsx",
    "src/screens/WebNoAccount.tsx",
  ]);

  it("includes the screens themselves", () => {
    expect(scope).toContain("src/screens/AccountNumberEntry.tsx");
    expect(scope).toContain("src/screens/WebNoAccount.tsx");
  });

  it("follows a relative import into a shared primitive", () => {
    // The blind spot: `CenteredCard` renders on both pre-unlock screens and sits
    // outside `webModules()` entirely, so anything it put in the DOM was
    // unreviewed by this guard.
    expect(scope).toContain("src/components/primitives/CenteredCard.tsx");
  });

  it("follows further, into what that primitive imports", () => {
    expect(scope).toContain("src/hooks/useScrollEdges.ts");
  });

  it("does not wander into the whole tree through package imports", () => {
    // Only relative specifiers are followed. A package is not this tree's to
    // audit, and a scope that grew without bound would report on files no
    // pre-unlock screen can reach.
    expect(scope.length).toBeLessThan(40);
    expect(scope.every((f) => !f.includes("node_modules"))).toBe(true);
  });

  it("terminates on a file it cannot read", () => {
    expect(() => preUnlockScope(["src/screens/does-not-exist.tsx"])).not.toThrow();
    expect(preUnlockScope(["src/screens/does-not-exist.tsx"])).toEqual([]);
  });
});

// `data-testid` is scanned by its own pair of rules (banned outright everywhere,
// and named per file inside the pre-unlock budget), and both of them ask the
// same question `dynamicDataAttrs` asks: is this value a constant? It was
// spelled three times and the three disagreed. The backtick clause is where:
// the testid copies read a leading backtick as disqualifying, so a constant
// template was reported as a runtime value while `dynamicDataAttrs`, one
// function away, had already learned that a template is constant exactly when
// it interpolates nothing.
describe("interpolatedTestIdObjectForm: the props-object testid spelling", () => {
  it("names a value assembled at runtime", () => {
    const src = 'const p = { "data-testid": `${prefix}-${account}` };';
    expect(interpolatedTestIdObjectForm(src)).toHaveLength(1);
  });

  it("names a bare identifier", () => {
    expect(interpolatedTestIdObjectForm('const p = { "data-testid": name };')).toEqual(["name"]);
  });

  it("passes a constant string, in either quote", () => {
    expect(interpolatedTestIdObjectForm('const p = { "data-testid": "unlock.form" };')).toEqual([]);
    expect(interpolatedTestIdObjectForm("const p = { 'data-testid': 'unlock.form' };")).toEqual([]);
  });

  it("passes a template that interpolates nothing, which the old copy reported", () => {
    // The false positive the unified predicate removes. It is a false positive
    // rather than a leak, so it cost an argument rather than a secret, but a
    // guard that fires on a correct file is a guard people learn to route
    // around.
    expect(interpolatedTestIdObjectForm("const p = { 'data-testid': `unlock.form` };")).toEqual([]);
  });

  it("still names an INTERPOLATING template, which is the leak shape", () => {
    // The direction that must not regress while the one above is fixed.
    const src = "const p = { 'data-testid': `row-${accountNumber}` };";
    expect(interpolatedTestIdObjectForm(src)).toHaveLength(1);
  });

  it("names it for the RIGHT reason, which the truncation hid", () => {
    // The value is captured whole. It used to be cut at the `}` that closes the
    // interpolation, so it never ended with a backtick and the quote-shape test
    // rejected it first: the right answer for the wrong reason, which left
    // `templateInterpolates` unreachable in this scanner while the docblock said
    // it decided the case. Asserting the captured EXPRESSION is what makes the
    // difference observable.
    const src = "const p = { 'data-testid': `row-${accountNumber}` };";
    expect(interpolatedTestIdObjectForm(src)[0]).toBe("`row-${accountNumber}`");
  });

  it("passes a constant template containing a comma", () => {
    // The false positive the same truncation produced in the other direction: a
    // legitimate `` `a, b` `` was cut at the comma, stopped looking like a
    // template, and was reported as a runtime value. A guard that fires on a
    // correct file is a guard people learn to route around.
    expect(interpolatedTestIdObjectForm("const p = { 'data-testid': `a, b` };")).toEqual([]);
  });
});

// Audit R0.2 (2026-10-19). The roster this guard walks for "every web-only
// module carries a selector" was a hand-kept pair, so three of the five shared
// web-only screens were unscanned while the header claimed "every". It is now
// derived from the neighbour's verdict table, and these cases hold that
// derivation and its floor in place.
describe("sharedWebOnlyScreens: the roster is derived, not listed", () => {
  it("takes every `web-only` verdict from check-web-screens.mjs", () => {
    const derived = sharedWebOnlyScreens();
    const expected = Object.entries(VERDICTS)
      .filter(([, v]) => v.verdict === "web-only")
      .map(([file]) => `src/screens/${file}`)
      .sort();
    expect(derived).toEqual(expected);
  });

  it("includes the screens the hand-kept pair left out", () => {
    // The finding itself, asserted by name: these three were outside the guard.
    for (const file of [
      "src/screens/AccountBootstrap.tsx",
      "src/screens/DeviceRevoked.tsx",
      "src/screens/vault-creation/ProvisioningStep.tsx",
    ]) {
      expect(sharedWebOnlyScreens()).toContain(file);
    }
  });

  it("drops a screen whose verdict changes, which is what the floor guards", () => {
    // Injected verdict table: one `web-only` renamed to `adapted`. The real
    // guard records a floor for this, because a derivation that shrinks passes
    // every rule inside it.
    const injected = { ...VERDICTS, "DeviceRevoked.tsx": { verdict: "adapted", note: "x" } };
    expect(sharedWebOnlyScreens(injected)).not.toContain("src/screens/DeviceRevoked.tsx");
    expect(sharedWebOnlyScreens(injected).length).toBe(sharedWebOnlyScreens().length - 1);
  });
});

describe("curated testid props: a selector the caller names", () => {
  it("reads a `testId` literal, which is how ProvisioningStep is observable", () => {
    expect(curatedTestIdProps('<BlockingProgressStep testId="create.provisioning" />')).toEqual([
      "create.provisioning",
    ]);
  });

  it("reads a `testIdPrefix` literal", () => {
    expect(curatedTestIdProps('<Form testIdPrefix="recover.reset" />')).toEqual(["recover.reset"]);
  });

  it("ignores an interpolated prop, which is not a stable selector", () => {
    expect(curatedTestIdProps("<Foo testId={`a-${b}`} />")).toEqual([]);
  });

  it("counts both spellings for the presence check", () => {
    expect(selectorsIn('<div data-testid="x.y" /><Foo testId="x.z" />')).toEqual(["x.y", "x.z"]);
  });
});

describe("staleRenderNothingEntries: an exemption cannot outlive its file", () => {
  it("names an entry whose substitution is gone", () => {
    expect(staleRenderNothingEntries(new Set(["web/src/screens/Gone.tsx"]))).toEqual([
      "web/src/screens/Gone.tsx",
    ]);
  });

  it("is empty on the real tree, which is what R0.2 fixed", () => {
    // Five entries were stale when R0.2 landed: the phrase-ban removal
    // (2026-10-18, entry 0704) deleted those `web/src` substitutes, and nothing
    // compared the list with the tree.
    expect(staleRenderNothingEntries()).toEqual([]);
  });
});

describe("isCallerSuppliedTestIdExpr: the exemption, structurally", () => {
  it("accepts the bare identifier it always did", () => {
    expect(isCallerSuppliedTestIdExpr("testId")).toBe(true);
    expect(isCallerSuppliedTestIdExpr("testIdPrefix")).toBe(true);
  });

  it("accepts the two real spellings R0.2 surfaced", () => {
    // `BetaTermsConsent` passes a props member; `ModalShell` derives a close-button
    // id from the surface id with a fallback. Both are caller-supplied, and both
    // were reported as leaks by the bare-identifier test.
    expect(isCallerSuppliedTestIdExpr("props.testId")).toBe(true);
    expect(isCallerSuppliedTestIdExpr('testId === undefined ? "modal-close" : `${testId}-close`')).toBe(true);
  });

  it("rejects an expression that names anything else, which is the leak shape", () => {
    // The direction the exemption must keep checking: the account number is one
    // identifier away from the sanctioned prop.
    expect(isCallerSuppliedTestIdExpr("`${testIdPrefix}-${accountNumber}`")).toBe(false);
    expect(isCallerSuppliedTestIdExpr("accountNumber")).toBe(false);
    expect(isCallerSuppliedTestIdExpr("props.accountNumber")).toBe(false);
  });

  it("does not let a string literal smuggle an identifier past it", () => {
    // `"modal-close"` contributes `modal` and `close` if literals are not
    // stripped, and `testId + account` must not be rescued by a near-miss.
    expect(isCallerSuppliedTestIdExpr('"modal-close"')).toBe(false);
    expect(isCallerSuppliedTestIdExpr("testId + account")).toBe(false);
  });
});
