#!/usr/bin/env node
// The two Woodpecker workflow files carry ONE duplicated-by-design contract:
// the desktop release build's `--features` list. This holds the two halves
// equal, in both directions, and holds each build line inside the step that is
// supposed to run it.
//
// THE FAILURE THIS PREVENTS. `.woodpecker/e2e.yml` builds its own binary,
// because Woodpecker workflows do not share a workspace, and it builds it with
// `--features voice-capture-stub,local-inference-stub`: the stub capture source
// the voice scenarios need and the deterministic engine nine of the ten AI
// scenarios assert against. `.woodpecker/main.yml`'s `tauri-compile` builds with
// the same two features even though nothing on the push pipeline consumes the
// stubs, and `docs/decisions/ops/0529` states why: it is what keeps those
// compile arms alive on every push, so they cannot bit-rot between releases and
// hand the manual lane a build failure at the one moment nobody has time for it.
//
// That protection is only real while the two lists AGREE, and until this guard
// existed nothing checked it. Four prose blocks asserted it (`main.yml`'s build
// comment, `e2e.yml`'s, the decision entry and `docs/dev/e2e.md`), which is four
// copies of a claim and zero enforcement. Add a feature on the E2E side only and
// the per-push compile silently stops covering it; the discovery is a red build
// inside the pre-release lane.
//
// WHY IT ALSO CHECKS THE STEP, and not only the flag. The first version of this
// guard mapped each file to a step name in its failure text and never looked at
// the step. Renaming `tauri-compile:` to anything else left it green, which
// means it did not measure the property it named: the flags matter because the
// PUSH pipeline compiles them, so a build line that moved into a manual-gated
// step, or lost the step around it, takes the protection away while the feature
// lists still match. A guard's failure message may not claim more than its
// inputs prove.
//
// WHAT IT STILL DOES NOT PROVE, said plainly rather than left to be assumed:
// that Woodpecker will actually schedule that step on a push. It reads the
// step's own `when:` region for an `event:` key, which catches the obvious
// regression (gating the build to a manual or tag event); it does not resolve
// YAML anchors, does not model `depends_on`, and cannot see a pipeline-level
// gate. Those need the config compiler, not a text guard.
//
// Same shape as `check-cli-sidecar.mjs` (one contract duplicated across two
// trees, compared both ways) and `check-e2e-toolchain.mjs` (one pinned value in
// two files). Narrow on purpose: it compares one list rather than diffing the
// two build lines, and it fails BY NAME when either line cannot be found, so a
// renamed or deleted build command costs an argument rather than reporting ok
// on an input it never read.
//
//   node scripts/check-woodpecker-split.mjs

import { readWoodpeckerConfigs } from "./lib/woodpecker-configs.mjs";

/** The step whose build line each file is expected to carry. */
export const BUILD_STEPS = {
  ".woodpecker/main.yml": { step: "tauri-compile", mustRunOnPush: true },
  ".woodpecker/e2e.yml": { step: "e2e-compile", mustRunOnPush: false },
};

/** The lines of one top-level step's block, or `null` when the key is absent.
 *
 *  A step key is `  <name>:` at exactly two spaces of indent under `steps:`;
 *  the block runs until the next such key or the end of the file. */
export function stepBlock(text, stepName) {
  const lines = text.split("\n");
  const start = lines.findIndex((l) => l === `  ${stepName}:`);
  if (start === -1) return null;
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    if (/^ {2}[A-Za-z0-9_-]+:\s*$/.test(lines[i])) {
      end = i;
      break;
    }
  }
  return lines.slice(start, end);
}

/** `--features a,b` on a `pnpm tauri build` COMMAND line (comments stripped). */
export function featureList(lines) {
  const commands = lines
    .filter((line) => !/^\s*#/.test(line))
    .filter((line) => line.includes("pnpm tauri build"));
  if (commands.length !== 1) return { count: commands.length, features: null };
  const m = commands[0].match(/--features\s+([A-Za-z0-9_,-]+)/);
  return {
    count: 1,
    features: m ? m[1].split(",").map((f) => f.trim()).filter(Boolean).sort() : null,
  };
}

/** Does this step block gate itself on a specific event? */
export function gatesOnEvent(lines) {
  const whenAt = lines.findIndex((l) => /^\s{4}when:/.test(l));
  if (whenAt === -1) return false;
  for (let i = whenAt; i < lines.length; i++) {
    if (i > whenAt && /^\s{4}[A-Za-z0-9_-]+:/.test(lines[i])) break;
    if (/^\s*#/.test(lines[i])) continue;
    if (/\bevent:/.test(lines[i])) return true;
  }
  return false;
}

/** Every failure this guard can report, as strings. Exported for its spec. */
export function check(configs) {
  const failures = [];
  const seen = new Map();

  for (const { rel, text } of configs) {
    const spec = BUILD_STEPS[rel];
    if (!spec) continue;
    const block = stepBlock(text, spec.step);
    if (block === null) {
      failures.push(
        `${rel}: no \`${spec.step}\` step. This guard holds the desktop build's ` +
          "`--features` list equal across the two workflow files, and it anchors " +
          "each build line to the step that is supposed to run it. A renamed or " +
          "deleted step is exactly the regression that would leave the flags " +
          "matching while the protection is gone, so it fails rather than " +
          "reporting ok on an input it did not read.",
      );
      continue;
    }
    const { count, features } = featureList(block);
    if (count !== 1) {
      failures.push(
        `${rel}: expected exactly ONE \`pnpm tauri build\` command line inside the ` +
          `\`${spec.step}\` step, found ${count}. A build line that moved out of ` +
          "that step is the regression this guard exists to catch: the flags only " +
          "protect anything while the step that carries them runs.",
      );
      continue;
    }
    if (features === null) {
      failures.push(
        `${rel}: the \`pnpm tauri build\` line in \`${spec.step}\` carries no ` +
          "`--features` flag. Both builds are supposed to carry " +
          "`voice-capture-stub,local-inference-stub`: on the E2E side because the " +
          "suite needs the stubs, on the push side so those compile arms cannot " +
          "bit-rot between releases (docs/decisions/ops/0529).",
      );
      continue;
    }
    if (spec.mustRunOnPush && gatesOnEvent(block)) {
      failures.push(
        `${rel}: the \`${spec.step}\` step now gates itself on a specific event. ` +
          "The whole reason it carries the stub features is that it compiles them " +
          "on every push; gated to an event, it stops doing that and the manual " +
          "E2E lane discovers the bit-rot at release time.",
      );
      continue;
    }
    seen.set(rel, features);
  }

  for (const rel of Object.keys(BUILD_STEPS)) {
    if (!seen.has(rel) && !failures.some((f) => f.startsWith(rel))) {
      failures.push(
        `${rel}: not present among the Woodpecker configs. Both workflow files are ` +
          "named in `scripts/lib/woodpecker-configs.mjs`; removing one is a decision " +
          "to argue for there, not a rename to make quietly.",
      );
    }
  }

  if (failures.length === 0) {
    const [[relA, a], [relB, b]] = [...seen.entries()];
    // Both directions, deliberately: a set difference in one direction reports ok
    // when the other side has an EXTRA feature, which is the same half-comparison
    // this repo has caught in three separate guards.
    const onlyA = a.filter((f) => !b.includes(f));
    const onlyB = b.filter((f) => !a.includes(f));
    if (onlyA.length > 0 || onlyB.length > 0) {
      failures.push(
        `feature lists differ between ${relA} and ${relB}:\n` +
          (onlyA.length ? `  only in ${relA}: ${onlyA.join(", ")}\n` : "") +
          (onlyB.length ? `  only in ${relB}: ${onlyB.join(", ")}\n` : "") +
          "  The push pipeline builds the stub arms so they cannot bit-rot while the\n" +
          "  E2E suite that consumes them runs only before a release. A feature on\n" +
          "  one side only breaks that: the arm stops compiling per push, and the\n" +
          "  failure surfaces inside the manual lane at release time.",
      );
    }
  }

  return { failures, features: [...seen.values()][0] ?? null };
}

// Running as a script rather than being imported by the spec.
if (import.meta.url === `file://${process.argv[1]}`) {
  const { failures, features } = check(readWoodpeckerConfigs());
  if (failures.length > 0) {
    console.error("check-woodpecker-split: FAIL\n");
    for (const f of failures) console.error(`  ${f}\n`);
    process.exit(1);
  }
  console.log(
    `check-woodpecker-split: ok (both builds carry --features ${features.join(",")})`,
  );
}
