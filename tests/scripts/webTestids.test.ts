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
import { dynamicDataAttrs, preUnlockScope } from "../../scripts/check-web-testids.mjs";

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
    // shape (`src/CLAUDE.md`, "Test observability"), and the interpolated-testid
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
