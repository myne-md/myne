// The CLI-access copy may not claim a protection — myne-md/myne#557, the
// `cli.rate_limit` bullet.
//
// `src-tauri/src/cli_bridge/rate_limit.rs` states the rule and states that it is
// BINDING rather than advisory: "Nothing in this module, in the wire copy it
// produces, or in the Settings affordance that removes it may describe it as a
// protection, or describe its removal as disabling one; the second claim is
// worse than the first, because it implies a protection was there."
//
// Half of that is already machine-checked. `cli/src/output.rs`'s
// `no_copy_calls_the_rate_limit_a_protection` holds the WIRE copy to a
// vocabulary list. Nothing held the **catalog** to it, and the catalog is where
// the Settings affordance's strings live — the switch that removes the limit,
// the helper that explains what terminal access opens, and the folder-exclusion
// copy beside them. A single "keeps your notes secure" there is exactly the
// claim `docs/threat-model.md` §7 refuses: the door has no identity gatekeeper,
// so a program running as the same OS user can invoke the legitimate CLI and
// nothing decides who is allowed through.
//
// English only, deliberately. Reading the 31 TRANSLATED editions for the same
// claim stays a manual roster row (`cli.door`) — a wordlist in one language
// cannot judge another, and inventing one per language would be a check that
// looks like coverage and is not.

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const REPO_ROOT = process.cwd();

const CATALOG = JSON.parse(
  readFileSync(join(REPO_ROOT, "locales/en/common.json"), "utf8"),
) as Record<string, unknown>;

/**
 * The key prefixes whose strings describe the terminal door and its rate limit.
 *
 * `settings.search.keywords.cli*` is in scope for the same reason the helper is:
 * a search keyword is copy the user reads, and "cli security" as a keyword would
 * teach the same wrong thing the helper is forbidden from teaching.
 */
const CLI_ACCESS_PREFIXES: readonly string[] = [
  "settings.cliAccess.",
  "settings.search.keywords.cliAccess",
  "settings.search.keywords.cliExcludedFolders",
  "settings.search.keywords.cliRateLimit",
];

/** Flatten the catalog to dotted-key / string pairs. */
function flatten(obj: unknown, prefix = ""): Array<[string, string]> {
  const out: Array<[string, string]> = [];
  if (obj !== null && typeof obj === "object" && !Array.isArray(obj)) {
    for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
      out.push(...flatten(v, prefix ? `${prefix}.${k}` : k));
    }
  } else if (typeof obj === "string") {
    out.push([prefix, obj]);
  }
  return out;
}

const ALL_ENTRIES = flatten(CATALOG);

/** Every catalog string under a CLI-access prefix. */
const CLI_ENTRIES = ALL_ENTRIES.filter(([k]) =>
  CLI_ACCESS_PREFIXES.some((p) => k.startsWith(p)),
);

/**
 * The vocabulary a protection claim is made in.
 *
 * The same list `cli/src/output.rs` holds the wire copy to, so the two halves of
 * one rule cannot drift into two different rules.
 */
const FORBIDDEN: readonly string[] = [
  "protect",
  "security",
  "secure",
  "safety",
  "safe",
  "guard",
  "block",
  "attack",
  "unsafe",
];

/**
 * Strings that carry a forbidden word in a NEGATED construction, each with the
 * reason it is honest rather than a claim.
 *
 * Deliberately keyed by exact catalog key AND exact string: a copy edit that
 * keeps the key and changes the sentence loses the exemption and has to earn a
 * new one. Empty is the correct state and the current one — every entry here is
 * debt, not a licence.
 *
 * Compared in BOTH directions by the tests below: an unrecorded match fails, and
 * a recorded entry whose string is no longer in the catalog fails as stale.
 */
const NEGATION_EXEMPTIONS: ReadonlyArray<{ key: string; value: string; why: string }> = [];

describe("the CLI-access copy roster", () => {
  it("finds the strings it claims to check", () => {
    // A prefix that matched nothing would report ok forever. Each prefix has to
    // resolve to at least one string, and the whole set has to be non-trivial.
    for (const prefix of CLI_ACCESS_PREFIXES) {
      expect(
        ALL_ENTRIES.some(([k]) => k.startsWith(prefix)),
        `no catalog key starts with ${prefix} — the roster has gone stale`,
      ).toBe(true);
    }
    expect(CLI_ENTRIES.length).toBeGreaterThanOrEqual(10);
  });

  it("includes the three strings the rule is really about", () => {
    const keys = CLI_ENTRIES.map(([k]) => k);
    // The door's own description, the switch that removes the limit, and that
    // switch's explanation. If the catalog renames any of these the roster is
    // no longer covering the affordance the Rust module names.
    expect(keys).toContain("settings.cliAccess.helperOn");
    expect(keys).toContain("settings.cliAccess.rateLimitLabel");
    expect(keys).toContain("settings.cliAccess.rateLimitHelper");
  });
});

describe("no CLI-access string claims a protection", () => {
  it.each(CLI_ENTRIES)("%s", (key, value) => {
    const exempt = NEGATION_EXEMPTIONS.find((e) => e.key === key && e.value === value);
    if (exempt) {
      expect(exempt.why.length, `${key} needs a stated reason`).toBeGreaterThan(30);
      return;
    }
    const lowered = value.toLowerCase();
    for (const word of FORBIDDEN) {
      expect(
        lowered.includes(word),
        `${key} uses "${word}": ${JSON.stringify(value)}\n` +
          `The terminal door has no identity gatekeeper (threat-model.md §7), ` +
          `so the rate limit is a slowdown and not a protection — and calling ` +
          `its removal the disabling of one is worse, because it implies a ` +
          `protection was there. See src-tauri/src/cli_bridge/rate_limit.rs.`,
      ).toBe(false);
    }
  });

  it("has no stale exemption", () => {
    for (const e of NEGATION_EXEMPTIONS) {
      expect(
        CLI_ENTRIES.some(([k, v]) => k === e.key && v === e.value),
        `${e.key} is exempted but the catalog no longer holds that string`,
      ).toBe(true);
    }
  });
});

describe("the rate-limit copy says what it is, not only what it is not", () => {
  // A wordlist alone is a negative check, and a negative check passes on copy
  // that says nothing at all. The binding rule has a positive half too: the
  // helper has to tell the reader that nothing here decides WHO may ask, or the
  // reader supplies "a limit on requests" and reads a gatekeeper into it.
  const DISCLAIMERS = [
    "not a permission check",
    "not a protection",
    "nothing decides which program",
    "no permission check",
  ];

  it("the rate-limit helper still carries its disclaimer", () => {
    const helper = CLI_ENTRIES.find(
      ([k]) => k === "settings.cliAccess.rateLimitHelper",
    )?.[1];
    expect(helper, "settings.cliAccess.rateLimitHelper is missing").toBeDefined();
    const lowered = helper!.toLowerCase();
    expect(
      DISCLAIMERS.some((d) => lowered.includes(d)),
      `the helper no longer states that the limit decides nothing about WHO ` +
        `may ask. Without it, "Myne answers at most 120 terminal commands a " +
        "minute" reads as a gatekeeper. Copy: ${JSON.stringify(helper)}`,
    ).toBe(true);
  });

  it("the removal switch is labelled as a pace, not as turning something off", () => {
    const label = CLI_ENTRIES.find(([k]) => k === "settings.cliAccess.rateLimitLabel")?.[1];
    expect(label).toBeDefined();
    const lowered = label!.toLowerCase();
    // Not a vocabulary scan — those are covered above. This is the specific
    // second claim the module calls worse than the first.
    for (const phrase of ["turn off protection", "disable protection", "remove protection"]) {
      expect(lowered.includes(phrase), `${JSON.stringify(label)} names a protection`).toBe(
        false,
      );
    }
  });
});

describe("the catalog half and the wire half hold the same vocabulary", () => {
  it("the Rust list this file mirrors is still there and still says the same words", () => {
    // Two copies of a rule drift into two rules. `cli/src/output.rs` owns the
    // wire half; if its list changes, this one has to change with it, and the
    // way that gets noticed is here rather than in review.
    const rust = readFileSync(join(REPO_ROOT, "cli/src/output.rs"), "utf8");
    expect(
      rust.includes("no_copy_calls_the_rate_limit_a_protection"),
      "the wire-copy half of this rule has gone; either it moved (update this " +
        "reference) or the rule is now enforced in one place only",
    ).toBe(true);
    for (const word of FORBIDDEN) {
      expect(
        rust.includes(`"${word}"`),
        `cli/src/output.rs's forbidden list no longer names "${word}", so the ` +
          `wire copy and the catalog are now held to different vocabularies`,
      ).toBe(true);
    }
  });
});
