import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { audit, scan } from "../../scripts/check-update-channel.mjs";

/**
 * The guard reads four files that live in different subtrees, so the test reads
 * the real ones and injects one defect into a copy. Reading the real files is
 * deliberate rather than a fixture: if a rename moves the shape the guard
 * matches, `withDefect` fails on its own `toContain` and the guard's regexes
 * are the thing under test, not a hand-written sample of them.
 */
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

const FILES = {
  config: "src-tauri/tauri.conf.json",
  channel: "src-tauri/src/update/mod.rs",
  vite: "vite.config.ts",
  vitest: "vitest.config.ts",
  about: "src/components/settings/AboutPanel.tsx",
} as const;

type Inputs = Record<string, string>;

function realInputs(): Inputs {
  const input: Inputs = {};
  for (const [key, rel] of Object.entries(FILES)) {
    input[key] = readFileSync(join(REPO_ROOT, rel), "utf8");
    input[`${key}Path`] = rel;
  }
  return input;
}

/** A copy of the real inputs with one literal replaced. */
function withDefect(key: string, from: string, to: string): Inputs {
  const input = realInputs();
  const before = input[key];
  // Non-vacuity: a rename that moves the defect's anchor breaks the fixture
  // here rather than quietly turning the injection into a no-op.
  expect(before).toContain(from);
  input[key] = before.replace(from, to);
  return input;
}

describe("check-update-channel", () => {
  it("passes on this tree", () => {
    expect(scan(REPO_ROOT)).toEqual([]);
  });

  it("fails when the config takes an endpoint back", () => {
    // The exact defect this guard was written for: the plugin overrides the
    // configured list rather than merging with it, so a value here is ignored
    // and a reader believes the opposite of what ships.
    const failures = audit(
      withDefect(
        "config",
        `"requireSignedVersion": true`,
        `"requireSignedVersion": true,\n      "endpoints": ["https://downloads.myne.md/releases/latest.json"]`,
      ),
    );
    expect(failures.join("\n")).toMatch(/plugins\.updater\.endpoints/);
  });

  it("fails by name when the updater block is gone", () => {
    const input = realInputs();
    input.config = JSON.stringify({ plugins: {} });
    expect(audit(input).join("\n")).toMatch(/no `plugins\.updater` block/);
  });

  it("fails when the updater has no public key", () => {
    const input = realInputs();
    input.config = JSON.stringify({ plugins: { updater: { requireSignedVersion: true } } });
    expect(audit(input).join("\n")).toMatch(/pubkey` is missing/);
  });

  it("fails when a channel's manifest file moves and the emitter did not", () => {
    const failures = audit(
      withDefect("channel", `manifest: "latest-beta.json"`, `manifest: "latest.json"`),
    );
    expect(failures.join("\n")).toMatch(/the emitter writes latest-beta\.json/);
  });

  it("fails when a third channel joins without the emitter learning it", () => {
    const failures = audit(
      withDefect(
        "channel",
        `Channel {
        name: "beta",
        manifest: "latest-beta.json",
    },`,
        `Channel {
        name: "beta",
        manifest: "latest-beta.json",
    },
    Channel {
        name: "nightly",
        manifest: "latest-nightly.json",
    },`,
      ),
    );
    const joined = failures.join("\n");
    expect(joined).toMatch(/`nightly` joined the channel set/);
    expect(joined).toMatch(/the emitter does not know/);
  });

  it("fails when a shipped channel disappears", () => {
    const failures = audit(
      withDefect(
        "channel",
        `    Channel {
        name: "beta",
        manifest: "latest-beta.json",
    },
`,
        "",
      ),
    );
    expect(failures.join("\n")).toMatch(/the `beta` channel is gone/);
  });

  it("fails when the two languages read the variable under different names", () => {
    const failures = audit(
      withDefect("vite", "process.env.MYNE_UPDATE_CHANNEL", "process.env.MYNE_RELEASE_CHANNEL"),
    );
    expect(failures.join("\n")).toMatch(/read under two names/);
  });

  it("fails when the unset-variable default disagrees across the two languages", () => {
    const failures = audit(
      withDefect("vite", `?? "stable")`, `?? "beta")`),
    );
    expect(failures.join("\n")).toMatch(/unset-variable default disagrees/);
  });

  it("fails by name when the Vite define is gone", () => {
    const input = realInputs();
    input.vite = input.vite.replace(/__UPDATE_CHANNEL__: JSON\.stringify\([^\n]*\n/, "");
    expect(audit(input).join("\n")).toMatch(/`__UPDATE_CHANNEL__` define is gone/);
  });

  it("fails when an unrecognized channel stops failing the build", () => {
    // The rule the maintainer chose: a typo is a build failure, not a silent
    // fallback to a channel nobody asked for.
    const input = realInputs();
    input.channel = input.channel.replace(
      /panic!\("MYNE_UPDATE_CHANNEL must be[^"]*"\)/,
      `found = 0`,
    );
    expect(audit(input).join("\n")).toMatch(/no longer fails the build/);
  });

  it("fails when the About panel stops naming a non-default channel", () => {
    const input = realInputs();
    input.about = input.about.replace(`__UPDATE_CHANNEL__ === "beta"`, `false`);
    expect(audit(input).join("\n")).toMatch(/does not mention the `beta` channel/);
  });

  it("fails when the test define names a different default than the build", () => {
    // vitest.config.ts writes the channel a fourth time, because Vitest does not
    // read vite.config.ts's environment. A unit test of the About panel would
    // then assert a label no shipped build shows.
    const failures = audit(withDefect("vitest", `JSON.stringify("stable")`, `JSON.stringify("beta")`));
    expect(failures.join("\n")).toMatch(/disagree about the default channel/);
  });

  it("fails by name when the test define is gone", () => {
    const input = realInputs();
    input.vitest = "export default {};\n";
    expect(audit(input).join("\n")).toMatch(/no `__UPDATE_CHANNEL__: JSON\.stringify/);
  });

  it("fails when the manifest origin moves", () => {
    const failures = audit(
      withDefect(
        "channel",
        `MANIFEST_ORIGIN: &str = "https://downloads.myne.md/releases/"`,
        `MANIFEST_ORIGIN: &str = "https://cdn.example.com/releases/"`,
      ),
    );
    expect(failures.join("\n")).toMatch(/the manifest origin is/);
  });

  it("fails by name when the channel table is reshaped", () => {
    const input = realInputs();
    input.channel = input.channel.replace(/Channel \{/g, "ChannelSpec {");
    expect(audit(input).join("\n")).toMatch(/no `Channel \{ name/);
  });

  describe("the scan itself", () => {
    it("names a defect in a tree it walks, not only in injected strings", () => {
      const root = mkdtempSync(join(tmpdir(), "update-channel-"));
      try {
        for (const [key, rel] of Object.entries(FILES)) {
          const target = join(root, rel);
          mkdirSync(dirname(target), { recursive: true });
          const text = readFileSync(join(REPO_ROOT, rel), "utf8");
          writeFileSync(
            target,
            key === "channel"
              ? text.replace(`manifest: "latest-beta.json"`, `manifest: "latest.json"`)
              : text,
          );
        }
        const failures = scan(root);
        expect(failures.join("\n")).toMatch(/the emitter writes latest-beta\.json/);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    });

    it("fails by name rather than passing over a tree it cannot read", () => {
      const failures = scan(join(tmpdir(), "update-channel-that-does-not-exist"));
      expect(failures.join("\n")).toMatch(/not found: .*src-tauri\/tauri\.conf\.json/);
    });
  });
});
