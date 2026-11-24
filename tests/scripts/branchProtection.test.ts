// The branch-ruleset definitions' own spec.
//
// Root `AGENTS.md`: "Verifying a guard means breaking it, not running it." The
// definitions in `workspace/rulesets/` are not a guard yet, because the org's
// GitHub plan refuses to install them on a private repo. That makes this spec
// more important rather than less: the first time they actually take effect is
// the day a repo goes public, and nobody will be watching a JSON file at that
// moment. Everything that would have been caught by "try it and see" has to be
// caught here instead.
//
// The two assertions worth arguing about, both stated in
// `scripts/lib/branch-rulesets.mjs` at length:
//
//   1. NO `required_status_checks`. CI is self-hosted Woodpecker on the Forgejo
//      mirror, so GitHub receives no commit statuses at all (measured on
//      `develop`: `statuses=0`, and `check-runs` holds only the triage bot). A
//      required check would make every PR permanently unmergeable, silently.
//      This spec fails if one is added, so removing the rule has to be a
//      deliberate edit plus a deliberate deletion of this test.
//
//   2. `required_approving_review_count: 0` and
//      `require_extra_approval_for_unattributed_changes: false`. GitHub does not
//      let an author approve their own PR. In an org where the author is the
//      only human, one required approval is an infinite block, and the
//      unattributed-changes variant reaches the same place through a bot commit.
//
// What this spec CANNOT prove is that GitHub accepts the definitions, and that
// is worth stating rather than implying: `enforcement`, `bypass_actors` and the
// `pull_request` parameter names were verified against the live API on the one
// public repo (`.github`) with a real direct-push refusal as the injection,
// which is a one-off and not repeatable in a unit test. The spec holds the file
// contents; the API and the guard agree today.

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  DIRECT_PUSH_REPOS,
  NON_COMPANION_REPOS,
  ORG,
  REPO_ROOT,
  RULESET_DIR,
  RULESET_NAMES,
  SETUP_SH_PATH,
  directPushReposInSetupSh,
  readRuleset,
  repoRoster,
  rulesetFilesFor,
} from "../../scripts/lib/branch-rulesets.mjs";
import { manifestRepos } from "../../scripts/lib/repo-manifest.mjs";

// The definitions are JSON, so `readRuleset` returns `any`. Typing them once here
// is what keeps every callback below from being an implicit `any`, which
// `scripts/check-test-typecheck.mjs` counts per file and may only see fall.
interface RulesetRule {
  type: string;
  parameters?: Record<string, unknown>;
}
interface RulesetDef {
  name: string;
  target: string;
  enforcement: string;
  conditions: { ref_name: { include: string[]; exclude: string[] } };
  bypass_actors: unknown;
  rules: RulesetRule[];
}

const loadRuleset = (stem: string): RulesetDef => readRuleset(stem) as RulesetDef;

const MANIFEST = join(REPO_ROOT, "workspace", "manifest.txt");
const manifestEntries = manifestRepos(readFileSync(MANIFEST, "utf8"));

describe("branch-ruleset roster", () => {
  it("covers every manifest repo exactly once, plus the repos that are not companions", () => {
    const roster = repoRoster();
    expect(new Set(roster).size).toBe(roster.length);

    for (const { name } of manifestEntries) {
      expect(roster, `${name} is on manifest.txt but would not be swept`).toContain(name);
    }
    for (const name of NON_COMPANION_REPOS) {
      expect(roster, `${name} carries protection but is not on manifest.txt`).toContain(name);
    }
    // The main repo leads the report, so a human reading the output sees the
    // repo that matters most first.
    expect(roster[0]).toBe("myne");
  });

  it.skipIf(!existsSync(SETUP_SH_PATH))("keeps the direct-push exemption identical in both copies", () => {
    // `workspace/setup.sh` cannot import this file, so the list exists twice by
    // necessity. Both directions are asserted: a repo dropped from one copy and
    // kept in the other is the drift that would either break a documented
    // workflow or leave a repo unprotected while looking covered.
    expect(new Set(directPushReposInSetupSh())).toEqual(new Set(DIRECT_PUSH_REPOS));
  });

  it("gives every swept repo at least one definition, and the direct-push repos the exempt one", () => {
    for (const repo of repoRoster()) {
      const stems = rulesetFilesFor(repo);
      expect(stems.length, `${repo} would be swept with nothing to install`).toBeGreaterThan(0);
      expect(stems).toContain(DIRECT_PUSH_REPOS.includes(repo) ? "direct-push-default-branch" : "default-branch");
    }
  });
});

describe("branch-ruleset definitions", () => {
  const definitions = RULESET_NAMES.map((stem: string) => ({ stem, def: loadRuleset(stem) }));

  it("has no definition on disk the roster does not know about", () => {
    const onDisk = readdirSync(RULESET_DIR)
      .filter((f: string) => f.endsWith(".json"))
      .map((f: string) => f.slice(0, -".json".length));
    expect(onDisk.sort()).toEqual([...RULESET_NAMES].sort());
  });

  it("names each definition after its own file, targets branches, and is active", () => {
    for (const { stem, def } of definitions) {
      expect(def.name, `${stem}.json`).toBe(stem);
      expect(def.target, `${stem}.json`).toBe("branch");
      // "disabled" is not a safe staging state even where it is allowed: a
      // disabled ruleset reads as protection in the settings UI and blocks
      // nothing, which is worse than an absent one nobody counted on.
      expect(def.enforcement, `${stem}.json`).toBe("active");
      expect(def.conditions?.ref_name?.include?.length).toBeGreaterThan(0);
    }
  });

  it("never requires a status check", () => {
    // The deadlock assertion. See this file's header: GitHub holds no statuses
    // for this org's CI, so a required check is an unmergeable pull request with
    // no error message pointing at the cause.
    for (const { stem, def } of definitions) {
      const types = def.rules.map((r: RulesetRule) => r.type);
      expect(types, `${stem}.json must not require status checks`).not.toContain("required_status_checks");
      expect(types, `${stem}.json must not require a deployment`).not.toContain("required_deployments");
      expect(types, `${stem}.json must not require a workflow`).not.toContain("workflows");
    }
  });

  it("always refuses deletion and force-push on the refs it covers", () => {
    for (const { stem, def } of definitions) {
      const types = def.rules.map((r: RulesetRule) => r.type);
      expect(types, `${stem}.json`).toContain("deletion");
      expect(types, `${stem}.json`).toContain("non_fast_forward");
    }
  });

  it("requires a pull request where direct push is not the documented workflow", () => {
    const byName = Object.fromEntries(definitions.map(({ def }) => [def.name, def]));

    // The exemption exists so this rule is NOT applied: `myne-range`,
    // `homebrew-tap` and `myne-branding` push straight to their default branch
    // by design, so a pull_request rule would refuse the workflow they document.
    expect(byName["direct-push-default-branch"].rules.map((r: RulesetRule) => r.type)).not.toContain("pull_request");

    for (const stem of ["default-branch", "release"]) {
      const rule = byName[stem].rules.find((r: RulesetRule) => r.type === "pull_request");
      if (!rule) throw new Error(`${stem}.json lost its pull_request rule`);
      const p = (rule.parameters ?? {}) as Record<string, unknown>;
      // One human, one org: an approval requirement above zero is an infinite
      // block, and so is the unattributed-changes variant, which a bot commit
      // triggers.
      expect(p.required_approving_review_count, `${stem}.json`).toBe(0);
      expect(p.require_extra_approval_for_unattributed_changes, `${stem}.json`).toBe(false);
      expect(p.require_code_owner_review, `${stem}.json`).toBe(false);
      expect(p.require_last_push_approval, `${stem}.json`).toBe(false);
      expect([...(p.allowed_merge_methods as string[])].sort(), `${stem}.json`).toEqual(["merge", "rebase", "squash"]);
    }
  });

  it("scopes the release definition to the release branch and nothing else", () => {
    const byName = Object.fromEntries(definitions.map(({ def }) => [def.name, def]));
    expect(byName.release.conditions.ref_name).toEqual({ include: ["refs/heads/release"], exclude: [] });
    for (const stem of ["default-branch", "direct-push-default-branch"]) {
      expect(byName[stem].conditions.ref_name.include, `${stem}.json`).toEqual(["~DEFAULT_BRANCH"]);
    }
  });

  it("lets the repository admin bypass, so an emergency has a way through", () => {
    // Not decoration: `bypass_mode: always` on the admin role is what keeps the
    // deletion and force-push rules from being a hard wall. `actor_id: 5` is
    // GitHub's admin role for `actor_type: RepositoryRole`; it was confirmed
    // against the live API rather than taken from memory, because an id that is
    // accepted but resolves to the wrong role fails exactly like one that works.
    for (const { stem, def } of definitions) {
      expect(def.bypass_actors, `${stem}.json`).toEqual([
        { actor_id: 5, actor_type: "RepositoryRole", bypass_mode: "always" },
      ]);
    }
  });

  it("names an org the applier can resolve", () => {
    expect(ORG).toBe("myne-md");
  });
});
