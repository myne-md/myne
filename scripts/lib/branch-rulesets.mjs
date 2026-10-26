// The roster behind `workspace/apply-branch-protection.mjs`.
//
// # The failure this prevents
//
// The org's GitHub plan is `free`, so a PRIVATE repo cannot carry a ruleset at
// all: `POST /repos/{owner}/{repo}/rulesets` answers
//
//   403 Upgrade to GitHub Pro or make this repository public to enable this
//   feature.
//
// and it answers that even for `"enforcement": "disabled"` (measured 2026-10-21,
// not assumed). So there is no server-side protection to install today, and the
// `protected-branch` lefthook guard is the only thing between a mistyped
// `git push` and `develop` — a local hook, bypassable by `--no-verify`,
// `LEFTHOOK=0` or a machine where `lefthook install` never ran.
//
// The day a repo goes public that 403 stops. What happens at that moment is the
// risk this file exists for: without the definitions already written down, the
// window opens and closes on somebody remembering, and the rulesets get
// hand-typed once, differently, in each repo. So the definitions live in
// `workspace/rulesets/*.json` — versioned, reviewable, and applied
// byte-identical to every repo by one command.
//
// # Two decisions a reader will want to argue with, both deliberate
//
// 1. NO `required_status_checks`. It is the rule most people add first and it
//    would deadlock every merge in this org. CI runs on the Forgejo mirror as
//    self-hosted Woodpecker, so GitHub sees no commit statuses at all: measured
//    on `develop`'s last five commits, `statuses=0` and `check-runs` holds only
//    the issue-triage bot. A required check naming a Woodpecker job would never
//    report, the PR would never be mergeable, and nothing would say why.
//    `tests/scripts/branchProtection.test.ts` fails if one is ever added, so the
//    decision has to be reversed on purpose rather than by accident.
//
// 2. `required_approving_review_count: 0`. A non-zero count on a ruleset with no
//    bypass actor is the other way to make a repo unmergeable: GitHub does not
//    let an author approve their own PR, so in an org where the author is the
//    only human, `1` is an infinite block. The rule still requires a PR to
//    exist, which is the whole point (the server-side twin of `protected-branch`)
//    without needing a second person.
//
// # Why the direct-push set is a NAMED list
//
// `internal-service`, `homebrew-tap` and `myne-branding` document a direct push to
// their default branch as their normal workflow, so the `pull_request` rule
// would refuse the very thing they exist to do. Membership is an exemption, and
// an exemption should cost an explicit line rather than be inferable from
// anything a repo asserts about itself. This mirrors `workspace/setup.sh`'s
// `DIRECT_PUSH_REPOS`, and the test holds the two copies together — the shell
// cannot import this file, so the pairing is asserted rather than shared.
//
// Zero dependencies, importable. Both the applier and its spec read from here so
// the roster exists in one place.

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { manifestRepos } from "../../scripts/lib/repo-manifest.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = join(HERE, "..", "..");
export const RULESET_DIR = join(REPO_ROOT, "workspace", "rulesets");
export const MANIFEST_PATH = join(REPO_ROOT, "workspace", "manifest.txt");
export const SETUP_SH_PATH = join(REPO_ROOT, "workspace", "setup.sh");

export const ORG = "myne-md";

/** Repos whose documented workflow IS a direct push to the default branch.
 *  Must equal `DIRECT_PUSH_REPOS` in `workspace/setup.sh`. */
export const DIRECT_PUSH_REPOS = ["internal-service", "homebrew-tap", "myne-branding"];

/** Repos that carry branch protection but are not co-located companions: the
 *  main repo itself, the two cloned by hand, and the org profile repo. A sweep
 *  driven by `manifest.txt` alone would silently narrow to the manifest and read
 *  as full coverage, which is the exact mistake `setup.sh`'s hook sweep avoids
 *  by walking disk instead. */
export const NON_COMPANION_REPOS = ["myne", "internal-service", "homebrew-tap", ".github"];

/** Every repo the sweep covers, de-duplicated, for a stable report order. */
export function repoRoster({ manifestText } = {}) {
  const text = manifestText ?? readFileSync(MANIFEST_PATH, "utf8");
  const ordered = [...NON_COMPANION_REPOS, ...manifestRepos(text).map((e) => e.name)];
  const seen = new Set();
  return ordered.filter((name) => (seen.has(name) ? false : (seen.add(name), true)));
}

/** Which ruleset definitions a repo gets, by filename stem.
 *
 *  `release` is conditional on the branch existing, and the applier asks the API
 *  rather than trusting a static list: the branch is created and dropped per
 *  release, so a hardcoded set would be wrong the week after it was written. */
export function rulesetFilesFor(repo) {
  const base = DIRECT_PUSH_REPOS.includes(repo) ? "direct-push-default-branch" : "default-branch";
  return [base, "release"];
}

/** `DIRECT_PUSH_REPOS` as `setup.sh` spells it, for the drift assertion. */
export function directPushReposInSetupSh() {
  const text = readFileSync(SETUP_SH_PATH, "utf8");
  const m = text.match(/^DIRECT_PUSH_REPOS="([^"]*)"/m);
  if (!m) {
    throw new Error(
      `workspace/setup.sh no longer declares DIRECT_PUSH_REPOS as a quoted assignment on its own line. ` +
        `The exemption list is duplicated by necessity (shell cannot import this file); fix the regex or restore the line.`,
    );
  }
  return m[1].trim().split(/\s+/).filter(Boolean);
}

/** Parse a ruleset definition by stem. */
export function readRuleset(stem) {
  return JSON.parse(readFileSync(join(RULESET_DIR, `${stem}.json`), "utf8"));
}

export const RULESET_NAMES = ["default-branch", "direct-push-default-branch", "release"];
