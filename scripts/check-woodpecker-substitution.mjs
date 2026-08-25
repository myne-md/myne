#!/usr/bin/env node
// No Woodpecker workflow file may contain a single-dollar brace-substitution
// token, ANYWHERE, including inside a comment.
//
// THE FAILURE THIS PREVENTS, and why it cannot be a CI check. Woodpecker runs
// an envsubst pass over the whole file before it compiles. A token it cannot
// resolve to one of its own variables fails that pass with "unable to parse
// variable name", and the failure is not scoped to the step, the line, or even
// to code: it errors the ENTIRE pipeline before any step runs. Every gate on
// the repository is simply gone (fmt, clippy, cargo-test, vitest, the web
// lane), on every branch, and CI cannot tell you because CI is what broke. The
// repo has been here before (2026-07-28, a `from_secret` naming an absent
// secret; every gate dead for a day).
//
// So this guard is a `pre-commit` guard on purpose. A CI-side check for "the CI
// config does not compile" can never fire.
//
// EVERY workflow file, not one. The config is a directory since
// myne-md/myne#579 (`.woodpecker/main.yml` + `.woodpecker/e2e.yml`), and one
// bad token in either kills the same pipeline. The roster comes from
// `lib/woodpecker-configs.mjs` rather than a glob written here, so a guard that
// cannot find the config fails by name instead of scanning nothing and
// reporting ok.
//
// Comments are the trap. The file's prose has to TALK about this syntax to warn
// about it, and writing the token to explain the token is exactly how it gets
// reintroduced. This guard exists because that is precisely what happened
// while documenting the sync-sim escape fix. Describe it in words ("dollar-brace
// token", "single dollar"), or write `$$` if you need the escaped form, which
// is what a command should contain anyway.
//
//   node scripts/check-woodpecker-substitution.mjs

import { readWoodpeckerConfigs } from "./lib/woodpecker-configs.mjs";

const offenders = [];

for (const { rel, text } of readWoodpeckerConfigs()) {
  text.split("\n").forEach((line, i) => {
    // A `${` whose preceding character is not `$`. `$${` is the escaped form and
    // is what every legitimate use in these files looks like.
    for (const m of line.matchAll(/\$\{/g)) {
      if (m.index > 0 && line[m.index - 1] === "$") continue;
      offenders.push({ rel, line: i + 1, text: line.trim() });
      break;
    }
  });
}

if (offenders.length > 0) {
  console.error(
    "check-woodpecker-substitution: single-dollar brace token in a Woodpecker config\n",
  );
  for (const o of offenders) {
    console.error(`  ${o.rel}:${o.line}: ${o.text.slice(0, 100)}`);
  }
  console.error(
    "\n  Woodpecker's envsubst pass runs over the WHOLE file, comments included.\n" +
      "  A token it cannot resolve fails config-compile with 'unable to parse\n" +
      "  variable name' and kills the entire pipeline on every branch: every\n" +
      "  gate gone, and CI unable to report it because CI is what broke.\n\n" +
      "  In a command: write the escaped form with two dollars, so the shell\n" +
      "  gets it instead of the pre-processor. In prose: describe it in words.\n" +
      "  Brace-less `$VAR` is left alone by the pre-processor and is fine.",
  );
  process.exit(1);
}

console.log("check-woodpecker-substitution: ok (no unescaped brace token)");
