// Injection tests for `check-pinned-ci-tools.mjs` (myne-md/myne#758, NV02).
//
// The guard exists because fourteen CI invocations executed `/cache/tools/bin/sccache`
// and `/cache/tools/bin/cargo-nextest` off a host mount that nothing in this repository
// provisions, pins or checksums. None of the three ways that state can come back
// is visible to a compiler or to a green pipeline. Each case below IS one of
// those ways, written as the smallest fixture that reproduces it, because the
// guard's own "ok" is worth nothing until a defect makes it name that defect.
//
// The fixtures are text, not a scratch tree: the guard is pure over
// `{ provisionerText, files }` for exactly this reason (the same shape as
// `coreIoSeam.test.ts` exporting its matcher).

import { describe, expect, it } from "vitest";
import { audit, readPins, splitSteps } from "../../scripts/check-pinned-ci-tools.mjs";

/** The pin block from the real provisioner, trimmed to what the parser reads. */
const PINS = [
  "ensure_tool() {",
  "  local tool=\"$1\"",
  "  case \"$tool\" in",
  "    sccache)",
  '      version="0.19.0"',
  '      url="https://example.invalid/v${version}/sccache.tar.gz"',
  '      tarball_sha="' + "a".repeat(64) + '"',
  '      member="sccache-v${version}/sccache"',
  '      bin_sha="' + "b".repeat(64) + '"',
  "      ;;",
  "    *)",
  "      exit 2",
  "      ;;",
  "  esac",
  "}",
  "",
].join("\n");

const PROVISION_LINE = "      - bash scripts/ci-pinned-tools.sh sccache cargo-nextest\n";

function workflow(stepBody) {
  return [
    "steps:",
    "  build:",
    "    image: rust:1.96.0-slim",
    "    environment:",
    "      RUSTC_WRAPPER: /cache/tools/bin/sccache",
    "    commands:",
    stepBody,
    "",
  ].join("\n");
}

function run({ provisionerText = PINS, files }) {
  return audit({ provisionerText, files }).failures;
}

describe("readPins", () => {
  it("reads a case arm's five fields", () => {
    const pins = readPins(PINS);
    expect([...pins.keys()]).toEqual(["sccache"]);
    expect(pins.get("sccache").version).toBe("0.19.0");
    expect(pins.get("sccache").binSha).toBe("b".repeat(64));
  });
});

describe("splitSteps", () => {
  it("splits on the step declarations and stops at the next top-level key", () => {
    const steps = splitSteps(workflow("      - echo hi\n"));
    expect(steps.map((s) => s.name)).toEqual(["build"]);
    expect(steps[0].text).toContain("echo hi");
  });
});

describe("the guard reports ok for the shape the tree now carries", () => {
  it("passes a step that provisions then executes", () => {
    const files = [
      {
        rel: ".woodpecker/main.yml",
        text: workflow(`${PROVISION_LINE}      - /cache/tools/bin/sccache --show-stats\n`),
      },
    ];
    expect(run({ files })).toEqual([]);
  });
});

describe("the three ways the defect comes back", () => {
  it("names a tool the provisioner does not pin", () => {
    const files = [
      {
        rel: ".woodpecker/main.yml",
        text: workflow(`${PROVISION_LINE}      - /cache/tools/bin/typos --force\n`),
      },
    ];
    const failures = run({ files });
    expect(failures).toHaveLength(1);
    expect(failures[0]).toContain("/cache/tools/bin/typos");
    expect(failures[0]).toContain("does not pin");
  });

  it("names a step that executes a pinned tool without provisioning it", () => {
    const files = [
      {
        rel: ".woodpecker/main.yml",
        text: workflow("      - /cache/tools/bin/cargo-nextest nextest run --profile ci\n"),
      },
    ];
    const failures = run({ files });
    // Two failures, and both are real: the step does not provision, AND the
    // `sccache` pin is now referenced by nothing. Asserting the count would make
    // this test churn on every pin added, so it names the one it is about.
    const unprovisioned = failures.filter((f) => f.includes("never calls"));
    expect(unprovisioned).toHaveLength(1);
    expect(unprovisioned[0]).toContain("never calls scripts/ci-pinned-tools.sh");
  });

  it("refuses a step that reaches back for the read-only /cache/bin mount", () => {
    const files = [
      {
        rel: ".woodpecker/main.yml",
        text: workflow(`${PROVISION_LINE}      - /cache/bin/sccache --show-stats\n`),
      },
    ];
    const failures = run({ files });
    const readOnly = failures.filter((f) => f.includes("READ-ONLY mount"));
    expect(readOnly).toHaveLength(1);
    expect(readOnly[0]).toContain("/cache/tools/bin/<tool>");
  });

  it("names a mangled pin digest, in both halves", () => {
    const mangled = PINS.replace("b".repeat(64), "NOTAHASH").replace("a".repeat(64), "SHORT");
    const failures = run({
      provisionerText: mangled,
      files: [
        {
          rel: ".woodpecker/main.yml",
          text: workflow(`${PROVISION_LINE}      - /cache/tools/bin/sccache --show-stats\n`),
        },
      ],
    });
    expect(failures.filter((f) => f.includes("not a lowercase sha256"))).toHaveLength(2);
  });

  it("names a URL left on an older release while the version moved", () => {
    const stale = PINS.replace('url="https://example.invalid/v0.18.0/', 'url="https://example.invalid/v0.18.0/').replace(
      'url="https://example.invalid/v${version}/',
      'url="https://example.invalid/v0.18.0/',
    );
    const failures = run({
      provisionerText: stale,
      files: [
        {
          rel: ".woodpecker/main.yml",
          text: workflow(`${PROVISION_LINE}      - /cache/tools/bin/sccache --show-stats\n`),
        },
      ],
    });
    expect(failures).toHaveLength(1);
    expect(failures[0]).toContain("names neither the version");
  });

  it("names a pin nothing references", () => {
    const extraPin = PINS.replace(
      "    *)",
      ["    cargo-nextest)", '      version="0.9.151"', '      url="https://x/v${version}/n.tgz"',
        '      tarball_sha="' + "c".repeat(64) + '"', '      member="cargo-nextest"',
        '      bin_sha="' + "d".repeat(64) + '"', "      ;;", "    *)"].join("\n"),
    );
    const failures = run({
      provisionerText: extraPin,
      files: [
        {
          rel: ".woodpecker/main.yml",
          text: workflow(`${PROVISION_LINE}      - /cache/tools/bin/sccache --show-stats\n`),
        },
      ],
    });
    expect(failures).toHaveLength(1);
    expect(failures[0]).toContain("pins `cargo-nextest` but no workflow file");
  });
});

describe("the guard fails rather than passing on an input it could not read", () => {
  it("fails when the provisioner declares no pins", () => {
    const failures = run({
      provisionerText: "echo nothing here\n",
      files: [{ rel: ".woodpecker/main.yml", text: workflow("      - echo hi\n") }],
    });
    expect(failures.some((f) => f.includes("declares no pins"))).toBe(true);
  });

  it("fails when no workflow references /cache/bin at all", () => {
    const failures = run({
      files: [
        {
          rel: ".woodpecker/main.yml",
          // No `environment:` block here on purpose: `RUSTC_WRAPPER` in one is a
          // reference this guard must see, which is what makes the `workflow()`
          // helper useless for this case.
          text: ["steps:", "  build:", "    image: rust:1.96.0-slim", "    commands:", "      - echo hi", ""].join("\n"),
        },
      ],
    });
    expect(failures.some((f) => f.includes("reports ok while checking nothing"))).toBe(true);
  });

  it("judges the E2E lane script by the same rule", () => {
    const failures = run({
      files: [
        {
          rel: "scripts/ci-e2e-lane.sh",
          isLaneScript: true,
          text: 'INNER="$INNER RUSTC_WRAPPER=/cache/tools/bin/sccache"\n',
        },
      ],
    });
    expect(failures).toHaveLength(1);
    expect(failures[0]).toContain("never calls scripts/ci-pinned-tools.sh");
  });
});
