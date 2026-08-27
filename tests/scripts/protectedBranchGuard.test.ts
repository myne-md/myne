// The `protected-branch` pre-push guard's own spec (myne-md/myne#592).
//
// Root `CLAUDE.md`: "Verifying a guard means breaking it, not running it. Inject
// the exact defect the guard now claims to catch, watch it name that defect,
// then restore." That rule applies to this guard more sharply than to most,
// because its two load-bearing keys fail SILENTLY and GREEN:
//
//   - Without `use_stdin: true` the command receives empty stdin, the loop runs
//     zero times, and lefthook prints a green tick while the push to `develop`
//     completes. Measured, not reasoned: deleting that one line produced
//     `✔️ protected-branch (0.02 seconds)` and `* [new branch] HEAD -> develop`
//     landing on the remote.
//   - `priority: 1` is what keeps the refusal at the front of a repo's battery,
//     because lefthook sorts commands alphabetically rather than in file order.
//
// Neither loss is visible to `lefthook validate`, to any CI step, or to a
// reviewer who is not looking for it, and the block lives in eleven separate
// repositories where a hand edit to one copy is invisible in the other ten. So
// the shell is executed here directly against synthetic pre-push stdin, which
// needs neither lefthook nor git, and the two keys are asserted as data.
//
// Deliberately NOT here: whether `git push` actually refuses end to end. That
// needs a real remote and is the hand-run in the issue. This file pins the
// decision logic and the two keys, which is the half that rots silently.

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

// The main repo plus every companion clone that happens to be present. The
// companions are gitignored nested clones, so a fresh checkout has none and a
// full workspace has ten; both are legitimate. The floor below is what stops
// that flexibility from turning into a spec that asserts nothing.
const COMPANIONS = [
  "myne-website",
  "myne-server",
  "myne-clipper",
  "myne-test-vectors",
  "agent-tooling",
  "operations",
  "myne-themes",
  "myne-branding",
  "internal-service",
  "homebrew-tap",
];

const ZERO = "0".repeat(40);
const SHA = "a".repeat(40);

interface GuardBlock {
  text: string;
  run: string;
  priority: string | null;
  useStdin: string | null;
}

/** Pull the `protected-branch` command out of a lefthook.yml as raw text. */
function extractGuard(yml: string): GuardBlock | null {
  const lines = yml.split("\n");
  const start = lines.findIndex((l) => l === "    protected-branch:");
  if (start === -1) return null;
  const end = lines.findIndex((l, i) => i > start && l === "        exit 1");
  if (end === -1) return null;
  const block = lines.slice(start, end + 1);

  const runStart = block.findIndex((l) => l === "      run: |");
  const run = block
    .slice(runStart + 1)
    .map((l) => l.replace(/^ {8}/, ""))
    .join("\n");

  const keyed = (key: string) => {
    const line = block.find((l) => l.trimStart().startsWith(`${key}:`));
    return line ? line.split(":").slice(1).join(":").trim() : null;
  };

  return {
    text: block.join("\n"),
    run,
    priority: keyed("priority"),
    useStdin: keyed("use_stdin"),
  };
}

function readGuard(repoDir: string): GuardBlock | null {
  const path = join(repoDir, "lefthook.yml");
  if (!existsSync(path)) return null;
  return extractGuard(readFileSync(path, "utf8"));
}

/**
 * Run the guard's shell with the given pre-push stdin lines, in an environment
 * with no inherited escape hatch. Returns the exit status and combined output.
 */
function runGuard(
  run: string,
  stdinLines: string[],
  opts: { env?: Record<string, string>; cwd?: string } = {},
): { status: number; out: string } {
  const env: Record<string, string> = {
    PATH: process.env.PATH ?? "/usr/bin:/bin",
    HOME: process.env.HOME ?? "/tmp",
    ...(opts.env ?? {}),
  };
  try {
    const out = execFileSync("sh", ["-c", run], {
      input: stdinLines.map((l) => `${l}\n`).join(""),
      env,
      cwd: opts.cwd ?? REPO_ROOT,
      encoding: "utf8",
      stdio: ["pipe", "pipe", "pipe"],
    });
    return { status: 0, out };
  } catch (e) {
    const err = e as { status?: number; stdout?: string; stderr?: string };
    return { status: err.status ?? 1, out: `${err.stdout ?? ""}${err.stderr ?? ""}` };
  }
}

const guard = readGuard(REPO_ROOT);

describe("protected-branch pre-push guard", () => {
  it("is present in the main repo's lefthook.yml", () => {
    expect(guard).not.toBeNull();
  });

  // The two keys whose loss is silent and green. Asserted as data rather than
  // through behaviour on purpose: the shell below would still pass every
  // decision case with `use_stdin` deleted, because this file feeds it stdin
  // directly. Only lefthook decides whether the real hook gets any.
  it("declares use_stdin: true, without which lefthook feeds it empty stdin", () => {
    expect(guard?.useStdin).toBe("true");
  });

  it("declares priority: 1, because lefthook sorts commands alphabetically", () => {
    expect(guard?.priority).toBe("1");
  });

  it("carries no skip_empty key, which was tried and does nothing", () => {
    expect(guard?.text).not.toContain("skip_empty");
  });

  it("reads the config hatch with --local, so a --global flag cannot disable it everywhere", () => {
    expect(guard?.run).toContain("git config --local --bool --get myne.allowProtectedPush");
    // The plain form is the defect: `--get` reads the merged cascade.
    expect(guard?.run).not.toMatch(/git config --bool --get myne\.allowProtectedPush/);
  });

  describe("decision logic", () => {
    const run = () => {
      if (!guard) throw new Error("guard block missing");
      return guard.run;
    };

    it("refuses a push whose remote ref is refs/heads/develop", () => {
      const r = runGuard(run(), [`refs/heads/develop ${SHA} refs/heads/develop ${ZERO}`]);
      expect(r.status).toBe(1);
      expect(r.out).toContain("refusing a direct push");
    });

    it("refuses a push whose remote ref is refs/heads/main", () => {
      const r = runGuard(run(), [`refs/heads/main ${SHA} refs/heads/main ${ZERO}`]);
      expect(r.status).toBe(1);
      expect(r.out).toContain("refs/heads/main");
    });

    // The shape the accident actually takes, and the one a branch-name check
    // misses: the local ref is a feature branch, the remote ref is not.
    it("refuses HEAD:develop pushed from a feature branch", () => {
      const r = runGuard(run(), [`refs/heads/feat/x ${SHA} refs/heads/develop ${ZERO}`]);
      expect(r.status).toBe(1);
      expect(r.out).toContain("refs/heads/develop");
    });

    it("refuses a deletion of a protected branch", () => {
      const r = runGuard(run(), [`(delete) ${ZERO} refs/heads/develop ${SHA}`]);
      expect(r.status).toBe(1);
    });

    it("allows an ordinary feature branch", () => {
      const r = runGuard(run(), [`refs/heads/feat/x ${SHA} refs/heads/feat/x ${ZERO}`]);
      expect(r.status).toBe(0);
      expect(r.out).not.toContain("refusing");
    });

    it("allows deleting an ordinary branch", () => {
      const r = runGuard(run(), [`(delete) ${ZERO} refs/heads/scratch ${SHA}`]);
      expect(r.status).toBe(0);
    });

    // The injected defect itself: this is what the command sees when
    // `use_stdin: true` is missing, and it must not be mistaken for consent.
    // It exits 0 because there is nothing to refuse, which is correct for the
    // shell and is exactly why the key above is asserted separately.
    it("exits 0 on empty stdin, which is what a missing use_stdin produces", () => {
      const r = runGuard(run(), []);
      expect(r.status).toBe(0);
    });

    it("names every protected ref in a multi-ref push, with single spacing", () => {
      const r = runGuard(run(), [
        `refs/heads/feat/x ${SHA} refs/heads/feat/x ${ZERO}`,
        `refs/heads/develop ${SHA} refs/heads/develop ${ZERO}`,
        `refs/heads/main ${SHA} refs/heads/main ${ZERO}`,
      ]);
      expect(r.status).toBe(1);
      // The accumulator carries a deliberate leading space so the message can
      // interpolate it straight after a word. A "fix" that adds one here would
      // double it, and this is what catches that.
      expect(r.out).toContain("refusing a direct push to refs/heads/develop refs/heads/main");
    });

    it("allows the protected branch when the env hatch is set", () => {
      const r = runGuard(run(), [`refs/heads/develop ${SHA} refs/heads/develop ${ZERO}`], {
        env: { MYNE_ALLOW_PROTECTED_PUSH: "1" },
      });
      expect(r.status).toBe(0);
      expect(r.out).toContain("allowed");
    });

    it("tells the user both hatches when it refuses", () => {
      const r = runGuard(run(), [`refs/heads/develop ${SHA} refs/heads/develop ${ZERO}`]);
      expect(r.out).toContain("MYNE_ALLOW_PROTECTED_PUSH=1");
      expect(r.out).toContain("git config myne.allowProtectedPush true");
    });
  });

  // The block is hand-copied into ten other repositories with nothing holding
  // the copies identical (`scripts/hooks-parity-check.sh` records why a guard
  // for that would be worse than none: it could only see the clones present on
  // the machine, and a check that skips on missing input reads as a pass). This
  // is the weaker thing that IS available: when a companion clone happens to be
  // here, its copy must match.
  describe("copies in companion clones", () => {
    // Companions are cloned INTO the main repo as nested directories
    // (`workspace/setup.sh`), not beside it.
    const present = COMPANIONS.map((name) => ({
      name,
      guard: readGuard(join(REPO_ROOT, name)),
    })).filter((c) => c.guard !== null);

    it.runIf(present.length > 0)("every present copy is byte-identical to this one", () => {
      for (const c of present) {
        expect(c.guard?.text, `${c.name} drifted from the main repo's copy`).toBe(guard?.text);
      }
    });

    // Non-vacuity floor. Without it a machine whose companions are absent
    // reports a green spec that asserted nothing about ten repositories, which
    // is the failure mode this whole file exists to argue against.
    it("says out loud how many copies it could actually compare", () => {
      const compared = present.length;
      expect(compared === 0 || compared === COMPANIONS.length,
        `compared ${compared} of ${COMPANIONS.length} companion copies: a PARTIAL workspace ` +
        `means this spec is silently covering less than it appears to. Clone the rest ` +
        `(./workspace/setup.sh) or accept a fresh checkout with none.`,
      ).toBe(true);
    });
  });
});
