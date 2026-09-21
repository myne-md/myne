// The `protected-branch` pre-push guard's own spec (myne-md/myne#592).
//
// Root `AGENTS.md`: "Verifying a guard means breaking it, not running it. Inject
// the exact defect the guard now claims to catch, watch it name that defect,
// then restore." That rule applies to this guard more sharply than to most,
// because its load-bearing keys fail SILENTLY and GREEN:
//
//   - Without `use_stdin: true` the command receives empty stdin, the loop runs
//     zero times, and lefthook prints a green tick while the push to `develop`
//     completes. Measured, not reasoned: deleting that one line produced
//     `✔️ protected-branch (0.02 seconds)` and `* [new branch] HEAD -> develop`
//     landing on the remote.
//   - `priority: 1` keeps the refusal at the front of a repo's battery, because
//     lefthook sorts commands alphabetically rather than in file order.
//   - `min_version` is what makes the first of those non-silent: `lefthook run`
//     and the real git hook path IGNORE an unknown key without a word, so an
//     older binary would drop `use_stdin` and leave a guard checking nothing.
//     Only `lefthook validate` rejects one, and hooks never call it.
//
// None of that is visible to `lefthook validate`, to CI, or to a reviewer not
// looking for it, and the block lives in eleven separate repositories where a
// hand edit to one copy is invisible in the other ten. So the shell is executed
// here directly against synthetic pre-push stdin, and the keys are asserted as
// data.
//
// Every invocation runs in a THROWAWAY git repo with `GIT_CONFIG_GLOBAL` and
// `GIT_CONFIG_SYSTEM` pointed away from the machine's real files. The guard
// reads git config, so without that isolation this spec would consult the
// developer's own settings and pass or fail based on them.

import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

// Companions are cloned INTO the main repo as nested directories by
// `workspace/setup.sh`, which reads `workspace/manifest.txt`. Two more repos
// carry the guard without being on that manifest, so the sweep in setup.sh
// walks disk rather than the manifest. Both facts matter to the floor below.
const MANIFEST = join(REPO_ROOT, "workspace", "manifest.txt");
const manifestRepos = readFileSync(MANIFEST, "utf8")
  .split("\n")
  .map((l: string) => l.replace(/#.*$/, "").trim())
  .filter(Boolean);
const OFF_MANIFEST = ["myne-range", "homebrew-tap"];
const COMPANIONS = [...manifestRepos, ...OFF_MANIFEST];

const ZERO = "0".repeat(40);
const SHA = "a".repeat(40);

interface GuardBlock {
  text: string;
  run: string;
  priority: string | null;
  useStdin: string | null;
  minVersion: string | null;
}

/**
 * Pull the `protected-branch` command out of a lefthook.yml as raw text.
 *
 * The end anchor is the NEXT command key, not a shell line inside the block: an
 * anchor on `exit 1` silently truncates the moment the script grows a second
 * one, and a truncated block would still parse here while asserting less.
 */
function extractGuard(yml: string): GuardBlock | null {
  const lines = yml.split("\n");
  const start = lines.findIndex((l) => l === "    protected-branch:");
  if (start === -1) return null;
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    if (/^ {4}\S/.test(lines[i]) || /^\S/.test(lines[i])) {
      end = i;
      break;
    }
  }
  const block = lines.slice(start, end);

  const runStart = block.findIndex((l) => l === "      run: |");
  if (runStart === -1) return null;
  const run = block
    .slice(runStart + 1)
    .map((l) => l.replace(/^ {8}/, ""))
    .join("\n");

  const keyed = (key: string, indent: string) => {
    const line = block.find((l) => l.startsWith(`${indent}${key}:`));
    return line ? line.split(":").slice(1).join(":").trim() : null;
  };
  const mv = yml.split("\n").find((l) => l.startsWith("min_version:"));

  return {
    text: block.join("\n"),
    run,
    priority: keyed("priority", "      "),
    useStdin: keyed("use_stdin", "      "),
    minVersion: mv ? mv.split(":").slice(1).join(":").trim() : null,
  };
}

function readGuard(repoDir: string): GuardBlock | null {
  const path = join(repoDir, "lefthook.yml");
  if (!existsSync(path)) return null;
  return extractGuard(readFileSync(path, "utf8"));
}

const guard = readGuard(REPO_ROOT);

// A scratch git repo, so `git config --local` reads something this spec owns.
let scratch: string;

/**
 * Every `git` call here runs with git's ambient variables STRIPPED, and that is
 * load-bearing rather than tidy. Git exports `GIT_DIR` (absolute) into hook
 * processes, so when this spec runs under `pre-push` an inherited `GIT_DIR`
 * outranks `-C <scratch>`: `git -C scratch config --local` then writes the flag
 * into the REAL repository instead of the scratch one. The guard, which runs
 * with a clean environment, correctly refuses, and the test fails while having
 * quietly written a guard-disabling setting somewhere it does not own.
 *
 * That is exactly what happened: green under `npx vitest run`, red under
 * `git push`, three times, before the environment was the thing suspected.
 */
function gitEnv(extra: Record<string, string> = {}): Record<string, string> {
  return {
    PATH: process.env.PATH ?? "/usr/bin:/bin",
    HOME: scratch,
    GIT_CONFIG_GLOBAL: join(scratch, "fake-global"),
    GIT_CONFIG_SYSTEM: "/dev/null",
    ...extra,
  };
}

beforeAll(() => {
  scratch = mkdtempSync(join(tmpdir(), "protected-branch-"));
  writeFileSync(join(scratch, "fake-global"), "");
  execFileSync("git", ["init", "-q", "-b", "develop", scratch], { env: gitEnv() });
});
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

function runGuard(
  run: string,
  stdinLines: string[],
  opts: { env?: Record<string, string> } = {},
): { status: number; out: string } {
  const env = gitEnv(opts.env);
  try {
    const out = execFileSync("sh", ["-c", run], {
      input: stdinLines.map((l) => `${l}\n`).join(""),
      env,
      cwd: scratch,
      encoding: "utf8",
      stdio: ["pipe", "pipe", "pipe"],
    });
    return { status: 0, out };
  } catch (e) {
    const err = e as { status?: number; stdout?: string; stderr?: string };
    return { status: err.status ?? 1, out: `${err.stdout ?? ""}${err.stderr ?? ""}` };
  }
}

const setLocal = (v: string | null) => {
  const opts = { env: gitEnv() };
  if (v === null) {
    try {
      execFileSync(
        "git",
        ["-C", scratch, "config", "--local", "--unset", "myne.allowProtectedPush"],
        opts,
      );
    } catch {
      /* already unset */
    }
  } else {
    execFileSync("git", ["-C", scratch, "config", "--local", "myne.allowProtectedPush", v], opts);
  }
  // Prove the write landed where this spec owns it. Without the assertion an
  // inherited GIT_DIR silently redirects it and the failure reads as the guard
  // being wrong rather than the harness writing to the wrong repository.
  const seen = readFileSync(join(scratch, ".git", "config"), "utf8");
  if (v === null) {
    expect(seen).not.toContain("allowProtectedPush");
  } else {
    expect(seen, "the flag must land in the scratch repo, not an inherited GIT_DIR").toContain(
      "allowProtectedPush",
    );
  }
};

describe("protected-branch pre-push guard", () => {
  it("is present in the main repo's lefthook.yml", () => {
    expect(guard).not.toBeNull();
  });

  it("declares use_stdin: true, without which lefthook feeds it empty stdin", () => {
    expect(guard?.useStdin).toBe("true");
  });

  it("declares priority: 1, because lefthook sorts commands alphabetically", () => {
    expect(guard?.priority).toBe("1");
  });

  // The backstop for the key above: an older lefthook drops an unknown key
  // without a word on the path that matters, so the config has to refuse it.
  it("pins min_version, so an older lefthook refuses rather than drops a key", () => {
    expect(guard?.minVersion).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it("carries no skip_empty key, which was tried and does nothing", () => {
    expect(guard?.text).not.toContain("skip_empty");
  });

  it("reads the config hatch with --local, so a --global flag cannot disable it everywhere", () => {
    expect(guard?.run).toContain("git config --local --bool --get myne.allowProtectedPush");
  });

  describe("decision logic", () => {
    const run = () => {
      if (!guard) throw new Error("guard block missing");
      return guard.run;
    };

    for (const branch of ["develop", "main", "release"]) {
      it(`refuses a push whose remote ref is refs/heads/${branch}`, () => {
        const r = runGuard(run(), [`refs/heads/${branch} ${SHA} refs/heads/${branch} ${ZERO}`]);
        expect(r.status).toBe(1);
        expect(r.out).toContain(`refs/heads/${branch}`);
      });
    }

    // `release` is the branch that DEPLOYS: myne-website's .woodpecker.yml maps
    // it to production while `develop` goes to staging. Guarding only `develop`
    // protected the branch with no blast radius.
    it("refuses HEAD:release pushed from a feature branch", () => {
      const r = runGuard(run(), [`refs/heads/feat/x ${SHA} refs/heads/release ${ZERO}`]);
      expect(r.status).toBe(1);
      expect(r.out).toContain("refs/heads/release");
    });

    it("refuses a deletion of a protected branch", () => {
      const r = runGuard(run(), [`(delete) ${ZERO} refs/heads/develop ${SHA}`]);
      expect(r.status).toBe(1);
    });

    it("allows an ordinary feature branch, and says how many refs it saw", () => {
      const r = runGuard(run(), [`refs/heads/feat/x ${SHA} refs/heads/feat/x ${ZERO}`]);
      expect(r.status).toBe(0);
      expect(r.out).toContain("checked 1 ref(s)");
    });

    it("allows deleting an ordinary branch", () => {
      const r = runGuard(run(), [`(delete) ${ZERO} refs/heads/scratch ${SHA}`]);
      expect(r.status).toBe(0);
    });

    // What the command sees when `use_stdin: true` is missing. It exits 0
    // because there is nothing to refuse, which is correct for the shell, and
    // the ref count is what makes that state visible rather than silent.
    it("reports `checked 0 ref(s)` on empty stdin, the symptom of a lost use_stdin", () => {
      const r = runGuard(run(), []);
      expect(r.status).toBe(0);
      expect(r.out).toContain("checked 0 ref(s)");
    });

    it("names every protected ref in a multi-ref push, with single spacing", () => {
      const r = runGuard(run(), [
        `refs/heads/feat/x ${SHA} refs/heads/feat/x ${ZERO}`,
        `refs/heads/develop ${SHA} refs/heads/develop ${ZERO}`,
        `refs/heads/main ${SHA} refs/heads/main ${ZERO}`,
      ]);
      expect(r.status).toBe(1);
      // The accumulator carries a deliberate leading space so the message can
      // interpolate it straight after a word. A "fix" adding one here doubles it.
      expect(r.out).toContain("refusing a direct push to refs/heads/develop refs/heads/main");
    });

    it("tells the user both hatches when it refuses", () => {
      const r = runGuard(run(), [`refs/heads/develop ${SHA} refs/heads/develop ${ZERO}`]);
      expect(r.out).toContain("MYNE_ALLOW_PROTECTED_PUSH=1");
      expect(r.out).toContain("git config myne.allowProtectedPush true");
    });
  });

  // Both hatches parse a VALUE. Testing the env var for non-emptiness let
  // `MYNE_ALLOW_PROTECTED_PUSH=0` open the gate, the opposite of what someone
  // typing that means, while the git-config side rejected the same literal.
  describe("escape hatches agree on what allow means", () => {
    const push = [`refs/heads/develop ${SHA} refs/heads/develop ${ZERO}`];
    const run = () => guard!.run;

    for (const v of ["1", "true", "TRUE", "yes", "on"]) {
      it(`env ${v} allows`, () => {
        const r = runGuard(run(), push, { env: { MYNE_ALLOW_PROTECTED_PUSH: v } });
        expect(r.status).toBe(0);
        expect(r.out).toContain("allowed");
      });
    }

    for (const v of ["0", "false", "no", "off", "banana"]) {
      it(`env ${v} still refuses, failing closed`, () => {
        const r = runGuard(run(), push, { env: { MYNE_ALLOW_PROTECTED_PUSH: v } });
        expect(r.status).toBe(1);
      });
    }

    it("a repo-local git config flag allows", () => {
      setLocal("true");
      try {
        expect(runGuard(run(), push).status).toBe(0);
      } finally {
        setLocal(null);
      }
    });

    it("a repo-local false refuses", () => {
      setLocal("false");
      try {
        expect(runGuard(run(), push).status).toBe(1);
      } finally {
        setLocal(null);
      }
    });

    // The `--local` reason, exercised rather than asserted as a substring: a
    // plain `--get` would read this and disable the guard in every clone.
    it("a --global flag does NOT allow, which is why the read is --local", () => {
      writeFileSync(join(scratch, "fake-global"), "[myne]\n\tallowProtectedPush = true\n");
      try {
        expect(runGuard(run(), push).status).toBe(1);
      } finally {
        writeFileSync(join(scratch, "fake-global"), "");
      }
    });
  });

  // The block is hand-copied into ten other repositories with nothing holding
  // the copies identical (`scripts/hooks-parity-check.sh` records why a guard
  // for that would be worse than none). This is the weaker thing available:
  // when a companion clone is here, its copy must match.
  describe("copies in companion clones", () => {
    const present = COMPANIONS.map((name) => ({
      name,
      guard: readGuard(join(REPO_ROOT, name)),
    })).filter((c) => c.guard !== null);

    it.runIf(present.length > 0)("every present copy is byte-identical to this one", () => {
      for (const c of present) {
        expect(c.guard?.text, `${c.name} drifted from the main repo's copy`).toBe(guard?.text);
      }
    });

    // Non-vacuity floor, keyed to what `workspace/setup.sh` can actually
    // produce. The floor was `COMPANIONS.length` until myne-bot pointed out
    // that the manifest clones eight of the ten, so the assertion could go
    // permanently red in a correctly-set-up workspace with no remedy to offer.
    // Zero (a fresh checkout) and "at least the manifest" are the two honest
    // states; anything between them means a partial workspace is quietly
    // covering less than this spec appears to.
    it("compared either no copies or at least every manifest companion", () => {
      const compared = present.length;
      expect(
        compared === 0 || compared >= manifestRepos.length,
        `compared ${compared} of ${COMPANIONS.length} companion copies, and the manifest ` +
          `alone names ${manifestRepos.length}: a PARTIAL workspace means this spec covers ` +
          `less than it appears to. Run ./workspace/setup.sh, or accept a fresh checkout ` +
          `with none present.`,
      ).toBe(true);
    });

    // A directory that exists and has a lefthook.yml but yields no block is a
    // different state from a directory that is not here, and only one of them
    // is fine. Reporting them together would let a mangled copy read as absent.
    it("no present companion has an unextractable block", () => {
      const broken = COMPANIONS.filter(
        (n) => existsSync(join(REPO_ROOT, n, "lefthook.yml")) && readGuard(join(REPO_ROOT, n)) === null,
      );
      expect(broken, `these carry a lefthook.yml with no readable guard block`).toEqual([]);
    });
  });
});
