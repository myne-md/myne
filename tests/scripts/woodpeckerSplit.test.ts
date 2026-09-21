// The workflow-split guard's own spec (myne-md/myne#579).
//
// Root `AGENTS.md`: "Verifying a guard means breaking it, not running it. Inject
// the exact defect the guard now claims to catch, watch it name that defect,
// then restore." Every case below is an injection, and the guard shipped for one
// review round with two of them passing, so this file is the record that they no
// longer do.
//
// What the guard protects. `.woodpecker/e2e.yml` builds its own desktop binary,
// because Woodpecker workflows share no workspace, and it needs
// `--features voice-capture-stub,local-inference-stub`. `.woodpecker/main.yml`'s
// `tauri-compile` carries the same two even though the push pipeline consumes
// neither: that is what keeps those compile arms alive between releases, so the
// manual E2E lane cannot be handed a build failure at release time. The
// protection is real only while the two lists agree AND the push-side step still
// runs on a push, which is two separate things and the reason the guard checks
// two separate things.
//
// The case that shipped broken: the first version mapped each file to a step
// name in its failure text and never looked at the step, so renaming
// `tauri-compile:` left it green. A guard's failure message may not claim more
// than its inputs prove.

import { describe, expect, it } from "vitest";

import {
  check,
  featureList,
  gatesOnEvent,
  stepBlock,
} from "../../scripts/check-woodpecker-split.mjs";

const STUBS = "voice-capture-stub,local-inference-stub";

/** A `main.yml` whose `tauri-compile` step builds with `features`. */
const mainYml = (features = STUBS, step = "tauri-compile", when = "    when: *code-paths") => `
steps:
  cargo-fmt:
    image: rust
    commands:
      - cargo fmt --all -- --check

  ${step}:
    image: rust
${when}
    commands:
      # prose mentioning --features other-thing must not be read as a command
      - pnpm tauri build --no-bundle -- --features ${features}
      - cargo check -p e2e-fixture-gen

  cargo-test-tauri:
    image: rust
    commands:
      - cargo test
`;

/** An `e2e.yml` whose `e2e-compile` step builds with `features`. */
const e2eYml = (features = STUBS, step = "e2e-compile") => `
steps:
  myne-server-build:
    image: golang
    commands:
      - go build

  ${step}:
    image: rust
    commands:
      - pnpm tauri build --no-bundle -- --features ${features}

  e2e:
    image: rust
    commands:
      - bash scripts/ci-e2e-lane.sh stable
`;

const configs = (main: string, e2e: string) => [
  { rel: ".woodpecker/main.yml", text: main },
  { rel: ".woodpecker/e2e.yml", text: e2e },
];

describe("the healthy case", () => {
  it("passes and reports the shared feature list", () => {
    const { failures, features } = check(configs(mainYml(), e2eYml()));
    expect(failures).toEqual([]);
    expect(features).toEqual(["local-inference-stub", "voice-capture-stub"]);
  });
});

describe("the feature-list injections, both directions", () => {
  it("names a feature present only on the push side", () => {
    const { failures } = check(configs(mainYml(), e2eYml("voice-capture-stub")));
    expect(failures.join("\n")).toMatch(/only in \.woodpecker\/main\.yml: local-inference-stub/);
  });

  // The direction a one-way set difference reports clean, which is the
  // half-comparison this repo has caught in three separate guards.
  it("names a feature present only on the E2E side", () => {
    const { failures } = check(configs(mainYml(), e2eYml(`${STUBS},extra-probe`)));
    expect(failures.join("\n")).toMatch(/only in \.woodpecker\/e2e\.yml: extra-probe/);
  });

  it("fails when a build line carries no --features at all", () => {
    const stripped = mainYml().replace(` -- --features ${STUBS}`, "");
    const { failures } = check(configs(stripped, e2eYml()));
    expect(failures.join("\n")).toMatch(/carries no `--features` flag/);
  });
});

describe("the step injections, which the first version of this guard missed", () => {
  // MEASURED against the real config before this case existed: renaming
  // `tauri-compile:` to `release-only-compile:` left the guard printing ok.
  it("fails by name when the push-side build step is renamed away", () => {
    const { failures } = check(configs(mainYml(STUBS, "release-only-compile"), e2eYml()));
    expect(failures.join("\n")).toMatch(/no `tauri-compile` step/);
  });

  it("fails by name when the E2E build step is renamed away", () => {
    const { failures } = check(configs(mainYml(), e2eYml(STUBS, "release-only-compile")));
    expect(failures.join("\n")).toMatch(/no `e2e-compile` step/);
  });

  // The flags protect nothing if the step carrying them stops running on a push.
  it("fails when the push-side build step gates itself on an event", () => {
    const gated = mainYml(STUBS, "tauri-compile", "    when:\n      - event: manual");
    const { failures } = check(configs(gated, e2eYml()));
    expect(failures.join("\n")).toMatch(/gates itself on a specific event/);
  });

  // Same key on the E2E side is legitimate: that whole workflow is manual.
  it("accepts an event gate on the E2E build step", () => {
    const gated = e2eYml().replace(
      "  e2e-compile:\n    image: rust",
      "  e2e-compile:\n    image: rust\n    when:\n      - event: manual",
    );
    expect(check(configs(mainYml(), gated)).failures).toEqual([]);
  });

  it("fails when the build line moves outside its step", () => {
    const moved = mainYml().replace(
      `      - pnpm tauri build --no-bundle -- --features ${STUBS}\n`,
      "",
    );
    const { failures } = check(configs(moved, e2eYml()));
    expect(failures.join("\n")).toMatch(/found 0/);
  });

  it("fails when a whole config is missing from the roster", () => {
    const { failures } = check([{ rel: ".woodpecker/main.yml", text: mainYml() }]);
    expect(failures.join("\n")).toMatch(/\.woodpecker\/e2e\.yml: not present/);
  });
});

describe("the helpers, where the parsing is easy to get subtly wrong", () => {
  it("stops a step block at the next step key, not at the next indented key", () => {
    const block = stepBlock(mainYml(), "tauri-compile");
    expect(block?.join("\n")).toMatch(/pnpm tauri build/);
    expect(block?.join("\n")).not.toMatch(/cargo test/);
    expect(block?.join("\n")).not.toMatch(/cargo fmt/);
  });

  it("returns null for a step that is not there", () => {
    expect(stepBlock(mainYml(), "no-such-step")).toBeNull();
  });

  // A comment is where this repo keeps writing the flag it warns about, so a
  // scanner that reads comments would find the wrong build line.
  it("ignores a --features mention inside a comment", () => {
    const lines = [
      "      # --features something-else is what NOT to do",
      `      - pnpm tauri build --no-bundle -- --features ${STUBS}`,
    ];
    expect(featureList(lines).features).toEqual([
      "local-inference-stub",
      "voice-capture-stub",
    ]);
  });

  it("does not read a commented-out `event:` as a gate", () => {
    expect(gatesOnEvent(["    when: *code-paths", "      # event: manual, historically"])).toBe(
      false,
    );
    expect(gatesOnEvent(["    when:", "      - event: manual"])).toBe(true);
  });
});
