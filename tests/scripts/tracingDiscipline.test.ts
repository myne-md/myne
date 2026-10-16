// The tracing-discipline guard's own spec (myne-md/myne#860).
//
// Root `AGENTS.md`: "Verifying a guard means breaking it, not running it. Inject
// the exact defect the guard now claims to catch, watch it name that defect,
// then restore." Every case below injects a defect into a fixture, because a
// guard verified by the tree being green is a guard nobody has tested: it is
// green by definition once it stops checking.
//
// Three of these cases exist to hold a BOUNDARY rather than a defect, and they
// are the ones that make the rule honest instead of merely strict:
//
//   - a `%` below `info` is NOT a finding. The file layer's floor is `info`
//     (`src-tauri/src/logging`), so a `debug!` `%` cannot reach disk, and the
//     rule is scoped to what the file records rather than to a general dislike
//     of `%`.
//   - `target: "..."` is macro meta, not a value.
//   - a bare identifier and `?value` are `tracing`'s field shorthands, used 111
//     times across the tree. A guard that flagged them would be red on the tree
//     it ships against, which is how a guard gets disabled.
//
// Without those three the guard would be over-broad, and an over-broad gate gets
// an allowlist that grows until it means nothing. The measured count is asserted
// too, so the fixture cannot start passing for the wrong reason.

import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";

import {
  EXCEPTIONS,
  MIN_INVOCATIONS,
  displayField,
  lintSource,
  scan,
  staleExceptions,
  topLevelArgs,
  tracingInvocations,
} from "../../scripts/check-tracing-discipline.mjs";

const FIXTURE_FILE = "core/src/fixture.rs";

function lint(body: string) {
  return lintSource(FIXTURE_FILE, body);
}

function messages(body: string): string {
  return lint(body)
    .map((f) => f.message)
    .join("\n");
}

describe("tracing discipline: R1, the `%` rule is scoped to the levels the file records", () => {
  it("flags a % Display formatter at info", () => {
    const found = lint(`
      fn go(e: MyErr) {
        tracing::info!(stage = "save", error = %e, "failed");
      }
    `);
    expect(found).toHaveLength(1);
    expect(found[0].rule).toBe("R1");
    expect(found[0].message).toContain("`error`");
    expect(found[0].message).toContain("info");
  });

  it("flags a % shorthand at warn and error too", () => {
    expect(lint(`tracing::warn!(%reason);`)).toHaveLength(1);
    expect(lint(`tracing::error!(%reason);`)).toHaveLength(1);
  });

  it("does NOT flag a % below info, because the file layer's floor is info", () => {
    // The boundary, and the reason the rule is level-scoped rather than
    // absolute. `src-tauri/src/logging` installs the file layer with
    // `LevelFilter::INFO` and ignores `RUST_LOG` entirely, so this record cannot
    // reach disk by any configuration.
    expect(lint(`tracing::debug!(detail = %e);`)).toHaveLength(0);
    expect(lint(`tracing::trace!(detail = %e);`)).toHaveLength(0);
  });

  it("accepts a recorded exception at its own field and level", () => {
    const recorded = EXCEPTIONS[0];
    expect(
      lintSource(
        recorded.file,
        `tracing::${recorded.level}!(event = "prefs_written", ${recorded.field} = %key);`,
      ),
    ).toHaveLength(0);
  });

  it("still flags the SAME field at a different level, so an exception is not a blanket pass", () => {
    // The exception names a level as well as a field: the recorded site is an
    // `info!` whose value is a bounded grammar token, and moving that field to a
    // `warn!` is a different site with a different argument.
    const recorded = EXCEPTIONS[0];
    expect(
      lintSource(recorded.file, `tracing::warn!(${recorded.field} = %key);`),
    ).toHaveLength(1);
  });
});

describe("tracing discipline: R2, no value interpolated into the message", () => {
  it("flags format!-style interpolation at a recorded level", () => {
    const found = lint(`fn go(p: &str) { tracing::info!("opening {}", p); }`);
    expect(found).toHaveLength(1);
    expect(found[0].rule).toBe("R2");
    expect(found[0].message).toContain("placeholder");
  });

  it("flags interpolation below info too, because a message is what a reader quotes", () => {
    expect(lint(`tracing::debug!("opening {:?}", p);`)).toHaveLength(1);
  });

  it("does NOT flag the meta target, nor the field shorthands the tree actually uses", () => {
    // The three shapes the first revision of this guard wrongly failed on. They
    // are asserted together because the failure mode was one rule, not three.
    expect(
      lint(`
        fn go(e: MyErr, kind: Failure) {
          tracing::warn!(target: "myne::ai", device = "cpu", "falling back");
          tracing::debug!(stage, outcome, "a bare shorthand");
          tracing::debug!(stage = "x", io_failure_kind = ?kind);
          tracing::info!(?io_failure_kind);
        }
      `),
    ).toHaveLength(0);
  });

  it("flags an argument that is neither a message, a field, nor a shorthand", () => {
    expect(messages(`tracing::info!(build_label());`)).toContain(
      "neither the message",
    );
  });
});

describe("tracing discipline: the extractor and the stale arm", () => {
  it("does not read comments, so a sentence about tracing is not a call site", () => {
    const found = lint(`
      // tracing::info!(error = %e, "a comment that would fail the guard");
      /* tracing::warn!(%reason); */
      fn go() {}
    `);
    expect(found).toHaveLength(0);
  });

  it("does not treat a tracing::Level path as a call site", () => {
    expect(tracingInvocations(`let l = tracing::Level::TRACE;`)).toHaveLength(0);
  });

  it("reads a multi-line invocation with a message containing parentheses", () => {
    const invocations = tracingInvocations(`
      tracing::warn!(
        event = "x",
        "a message (with parens) and a comma, inside",
      );
    `);
    expect(invocations).toHaveLength(1);
    expect(invocations[0].level).toBe("warn");
    expect(topLevelArgs(invocations[0].args)).toHaveLength(2);
  });

  it("names the field a % argument belongs to", () => {
    expect(displayField("error = %e")).toBe("error");
    expect(displayField("%reason")).toBe("(shorthand)");
    expect(displayField("stage = \"x\"")).toBeNull();
  });

  it("fails on a stale exception rather than letting the record outlive its site", () => {
    const findings = staleExceptions(process.cwd(), [
      {
        file: "core/src/does-not-exist.rs",
        level: "info",
        field: "gone",
        reason: "an injected stale entry",
      },
    ]);
    expect(findings).toHaveLength(1);
    expect(findings[0].message).toContain("does not exist");
  });

  it("walks a built tree rather than only the real one, and counts what it read", () => {
    // The scan's directory walk is otherwise asserted by nothing: a `rustFiles`
    // that returned an empty list would make every rule above pass vacuously.
    const root = mkdtempSync(join(tmpdir(), "tracing-discipline-"));
    try {
      mkdirSync(join(root, "core", "src"), { recursive: true });
      writeFileSync(
        join(root, "core", "src", "planted.rs"),
        `tracing::info!(error = %e, "planted");`,
      );
      const { findings, invocations } = scan(root);
      expect(invocations).toBe(1);
      // The planted R1 finding is the subject. There is a SECOND finding here
      // and it is not noise: `EXCEPTIONS` names a file in the real tree, so
      // against a fixture root that does not contain it the stale arm fires,
      // which is itself evidence that arm runs rather than being wired to
      // nothing.
      const planted = findings.find(
        (f) => f.path === join("core", "src", "planted.rs"),
      );
      expect(planted?.rule).toBe("R1");
      expect(findings.some((f) => f.message.includes("does not exist"))).toBe(true);
      // And the floor is meaningful: this fixture is far below it, so a walk
      // that suddenly reads a fraction of the tree cannot pass silently.
      expect(invocations).toBeLessThan(MIN_INVOCATIONS);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("the real tree clears the floor it pins", () => {
    const { findings, invocations } = scan(process.cwd());
    expect(invocations).toBeGreaterThanOrEqual(MIN_INVOCATIONS);
    expect(findings).toHaveLength(0);
  });
});

afterAll(() => {
  // Nothing global to undo: every fixture above is built under `tmpdir()` and
  // removed in its own `finally`.
});
