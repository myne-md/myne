/**
 * `scripts/check-store-frame-identifiers.mjs`, every rule driven with an input
 * that violates it.
 *
 * The property is a published image never carrying a live identifier, so the test
 * that matters most is the one that puts a FOREIGN account number into a source
 * and requires the guard to name it. The rest hold the format rules, and one of
 * them is a real cross-check rather than a fixture: the guard's pinned value must
 * equal the literal the members screen actually renders, because two copies of a
 * pinned constant IS the drift this guard is about.
 */

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  check,
  isDisplayForm,
  accountNumbersIn,
  phraseWordsIn,
  PINNED_ACCOUNT_NUMBER,
  PINNED_PHRASE_WORDS,
  CAPTION_SOURCE,
  SPECIMEN_SOURCE,
  unresolvedStoryScreens,
} from "../../scripts/check-store-frame-identifiers.mjs";

describe("the guard against the real tree", () => {
  it("passes, and reads a non-empty set of screen sources", () => {
    const { errors, scanned } = check();
    expect(errors).toEqual([]);
    expect(scanned).toBeGreaterThan(0);
  });

  it("refuses to report ok when it read nothing", () => {
    const { errors } = check({ sources: {} });
    expect(errors.join("\n")).toMatch(/no screen source was read, so this check compared nothing/);
  });
});

describe("a frame may show only the pinned account number", () => {
  it("fails by name on a foreign account number", () => {
    const { errors } = check({
      sources: { "mobile/src/screens/agent/index.tsx": 'const x = "MY-9Z8Y-7X6W-5V4T-3S2R-Q1PN";' },
    });
    expect(errors.join("\n")).toMatch(
      /carries an account number that is not the pinned one: "MY-9Z8Y-7X6W-5V4T-3S2R-Q1PN"/,
    );
  });

  it("accepts the pinned one, anywhere it appears", () => {
    const { errors } = check({
      sources: { "mobile/src/screens/members/index.tsx": `const a = "${PINNED_ACCOUNT_NUMBER}";` },
    });
    expect(errors).toEqual([]);
  });

  it("fails on a foreign number in the CAPTION data, which is drawn onto the frame", () => {
    // The first version of the guard scanned screen sources only, so a number in a
    // card's text shipped with every gate green. Card text is rendered into the
    // image, which makes it the highest-risk file in the set.
    const { errors } = check({
      sources: {
        "scripts/lib/store-shots/captions.en.json": JSON.stringify({
          notes: { cards: [{ text: "MY-9Z8Y-7X6W-5V4T-3S2R-Q1PN" }] },
        }),
      },
    });
    expect(errors.join("\n")).toMatch(/captions\.en\.json carries an account number that is not the pinned one/);
  });

  it("scans the real caption file BY NAME, so dropping it cannot pass", () => {
    // A count floor could not see the swap: add a screen source and drop the
    // caption file and `scanned` is unmoved, while the one file whose text is
    // DRAWN ONTO the frames is gone. So the assertion names the path.
    const { paths } = check();
    expect(paths).toContain(CAPTION_SOURCE);
  });

  it("scans the module that DECLARES the specimen BY NAME, not only the screens that render it", () => {
    // The regression this holds: every screen stopped carrying a literal when the
    // specimen moved into `mobile/src/components/misc.tsx`, so a screen-only scan
    // lost the one value that reaches every published frame while still printing
    // that the only reachable account number was the pinned one. Naming the path
    // means moving or deleting the constant fails here rather than silently
    // shrinking the denominator.
    const { paths } = check();
    expect(paths).toContain(SPECIMEN_SOURCE);
  });

  it("passes over the canonical placeholder shape, and over nothing else", () => {
    const placeholder = check({ sources: { x: 'placeholder="MY-XXXX-XXXX-XXXX-XXXX-XXXX"' } });
    expect(placeholder.errors).toEqual([]);
    const nearMiss = check({ sources: { x: '"MY-XXXX-XXXX-XXXX-XXXX-P4N6"' } });
    expect(nearMiss.errors.join("\n")).toMatch(/not the pinned one/);
  });

  it("catches a foreign number alongside the pinned one, rather than stopping at the first", () => {
    const { errors } = check({
      sources: {
        "mobile/src/screens/members/index.tsx": `const a = "${PINNED_ACCOUNT_NUMBER}";\nconst b = "MY-1111-2222-3333-4444-5555";`,
      },
    });
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatch(/MY-1111-2222-3333-4444-5555/);
  });
});

describe("the scan denominator", () => {
  it("names a story screen whose section prefix maps to no module", () => {
    // A new section arriving with no entry in the prefix map would shrink the scan
    // while `scanned` stayed above zero, so the guard would print ok over a screen
    // it never read. The empty-denominator check cannot see that.
    const story = [{ id: "zz", screens: { phone: "ZZ-01", tablet: null } }];
    expect(unresolvedStoryScreens(story)).toEqual(["ZZ-01"]);
  });

  it("resolves every screen the real story names", () => {
    expect(unresolvedStoryScreens()).toEqual([]);
  });
});

describe("the display form", () => {
  it("accepts the pinned value", () => {
    expect(isDisplayForm(PINNED_ACCOUNT_NUMBER)).toBe(true);
  });

  it("rejects a missing prefix, a short group, and one group too many", () => {
    expect(isDisplayForm("XX-4H7Q-2M9T-8XKB-3R6W-P4ND")).toBe(false);
    expect(isDisplayForm("MY-4H7Q-2M9T-8XKB-3R6W-P4N")).toBe(false);
    expect(isDisplayForm("MY-4H7Q-2M9T-8XKB-3R6W-P4ND-9A8B")).toBe(false);
  });

  it("rejects the letters Crockford base32 excludes", () => {
    expect(isDisplayForm("MY-4H7Q-2M9T-8XKB-3R6W-P4NL")).toBe(false);
    expect(isDisplayForm("MY-4H7Q-2M9T-8XKB-3R6W-P4NI")).toBe(false);
    expect(isDisplayForm("MY-4H7Q-2M9T-8XKB-3R6W-P4NO")).toBe(false);
  });

  it("would fail on a pinned value it could not parse at all", () => {
    const { errors } = check({ sources: {}, pinned: "MY-nope" });
    expect(errors.join("\n")).toMatch(/is not a valid display form/);
  });
});

describe("the phrase specimen", () => {
  it("is two words", () => {
    expect(PINNED_PHRASE_WORDS).toHaveLength(2);
  });

  it("would fail if somebody pinned a whole phrase", () => {
    const { errors } = check({ sources: {}, pinnedPhrase: ["a", "b", "c"] });
    expect(errors.join("\n")).toMatch(/must be two words, got 3/);
  });

  it("fails by name when the screen renders a specimen the guard does not pin", () => {
    // The drift this closes: `PINNED_PHRASE_WORDS` compared only with its own
    // length, so a fragment lengthened toward a fillable phrase left the guard and
    // every test green. The screen's literal is what a frame actually draws.
    const { errors } = check({
      sources: {
        "mobile/src/screens/members/index.tsx":
          'const PINNED_PHRASE_FRAGMENT = ["01", "harbor", "03", "lantern", "05", "abandon"];',
      },
    });
    expect(errors.join("\n")).toMatch(
      /mobile\/src\/screens\/members\/index\.tsx renders the phrase specimen \["harbor","lantern","abandon"\] but the guard pins \["harbor","lantern"\]/,
    );
  });

  it("accepts the screen's own literal, which is the pinned specimen", () => {
    const screen = readFileSync("mobile/src/screens/members/index.tsx", "utf8");
    expect(phraseWordsIn(screen)).toEqual(PINNED_PHRASE_WORDS);
    expect(check({ sources: { "mobile/src/screens/members/index.tsx": screen } }).errors).toEqual([]);
  });
});

describe("phraseWordsIn", () => {
  it("keeps the words and drops the numbered slots", () => {
    expect(phraseWordsIn('const PINNED_PHRASE_FRAGMENT = ["01","harbor","03","lantern"];')).toEqual([
      "harbor",
      "lantern",
    ]);
  });

  it("returns null when the literal is absent", () => {
    expect(phraseWordsIn("no specimen here")).toBeNull();
  });
});

describe("accountNumbersIn", () => {
  it("finds every distinct number in a source", () => {
    const found = accountNumbersIn(
      `"${PINNED_ACCOUNT_NUMBER}" and "MY-1111-2222-3333-4444-5555" and again "${PINNED_ACCOUNT_NUMBER}"`,
    );
    expect(found).toHaveLength(2);
  });

  it("does not invent one out of prose", () => {
    expect(accountNumbersIn("no numbers here, MY- is not one")).toEqual([]);
  });
});

describe("the guard's copy against the screen's copy", () => {
  it("is the same literal, in both places", () => {
    // The one assertion that would catch the drift this guard is named for: a
    // screen edited to a different number while the guard's allowlist kept the old
    // one would make the guard pass over a set that ships the new one.
    const screen = readFileSync("mobile/src/components/misc.tsx", "utf8");
    expect(screen).toContain(`"${PINNED_ACCOUNT_NUMBER}"`);
    expect(accountNumbersIn(screen)).toEqual([PINNED_ACCOUNT_NUMBER]);
  });
});
