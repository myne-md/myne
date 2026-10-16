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
// A fourth holds the boundary of the field-VALUE rule: an unbounded-value rule
// that names `format!`, `concat!`, `.to_string()`, `.to_owned()` and
// `String::from` must still accept a literal, a `%` and a `?`, or it widens
// into a ban on every field expression.
//
// Without those boundaries the guard would be over-broad, and an over-broad gate
// gets an allowlist that grows until it means nothing. The measured count is
// asserted too, so the fixture cannot start passing for the wrong reason.

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

  it("does NOT flag a percent sign inside a message or a literal field value", () => {
    // The false positive a literal-unaware lookup produced: the first revision
    // took the first `%` ANYWHERE in the argument, so a message reading "50% of
    // the file was read" was read as a Display formatter and R1 named a fragment
    // of the literal as its field (`"50`). A message may contain a percent sign,
    // and so may a literal field value, and neither is a formatter.
    expect(
      lint(`
        fn go() {
          tracing::info!(stage = "read_meta", "50% of the file was read");
          tracing::info!(event = "100% complete");
          tracing::warn!(percent = '%');
        }
      `),
    ).toHaveLength(0);
    expect(displayField(`"50% of the file was read"`)).toBeNull();
    expect(displayField(`event = "100% complete"`)).toBeNull();
    expect(displayField(`percent = '%'`)).toBeNull();
  });

  it("still flags a real % formatter beside a literal percent, so the rule is not vacuous", () => {
    // The rejection half: skipping the `%` inside the literal must not skip the
    // one after it.
    const found = lint(`
      fn go(e: MyErr) {
        tracing::info!(event = "100% complete", error = %e);
      }
    `);
    expect(found).toHaveLength(1);
    expect(found[0].rule).toBe("R1");
    expect(found[0].message).toContain("`error`");
    expect(displayField("error = %e")).toBe("error");
  });
});

describe("tracing discipline: R2, no unbounded value in the message or a field value", () => {
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

  it("flags a field VALUE that builds an unbounded string", () => {
    // The shape the pre-fix guard skipped: `arg.includes("=")` short-circuited
    // R2 for every `field = value`, so a `format!`-built value went through with
    // no finding at all. A fresh string has no bound a field-name rule can see,
    // and the log file is one the user is invited to publish.
    const found = lint(`
      fn go(p: &str) {
        tracing::info!(detail = format!("path {}", p));
      }
    `);
    expect(found).toHaveLength(1);
    expect(found[0].rule).toBe("R2");
    expect(found[0].message).toContain("unbounded");
    expect(found[0].message).toContain("detail");
  });

  it("flags the other unbounded field-value constructors and conversions", () => {
    expect(lint(`tracing::info!(detail = concat!("a", "b"));`)).toHaveLength(1);
    expect(lint(`tracing::info!(detail = name.to_string());`)).toHaveLength(1);
    expect(lint(`tracing::info!(detail = name.to_owned());`)).toHaveLength(1);
    expect(lint(`tracing::info!(detail = String::from(name));`)).toHaveLength(1);
  });

  it("accepts a literal, a `%` and a `?` field value, so the new rule stays narrow", () => {
    // The accept half of the boundary, and the reason the rule is not vacuous:
    // a string literal is accepted by R2 itself, `?` Debug is deliberately
    // exempt, and a `%` field value below a recorded level is nobody's rule.
    expect(
      lint(`
        fn go(e: MyErr) {
          tracing::info!(stage = "save", detail = ?e);
          tracing::debug!(detail = %e);
        }
      `),
    ).toHaveLength(0);
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

  it("reads the BARE macro spelling, which is why the extractor was widened", () => {
    // The idiomatic `use tracing::info;` then `info!(%path)` was invisible to a
    // qualified-only scan: R1, R2 and the invocation floor all read zero, so a
    // call site could carry a `%` path into the log the user is invited to
    // publish while the guard reported ok (myne#860 adversarial review). This is
    // the rejection half, and the bare name is admitted only because the file
    // imports from `tracing`.
    const bare = `
      use tracing::info;
      fn go(path: &str) { info!(%path, "opening"); }
    `;
    expect(tracingInvocations(bare)).toHaveLength(1);
    expect(lint(bare).length).toBeGreaterThan(0);
  });

  it("reads a macro imported under an alias, single and braced", () => {
    // The widened extractor admitted a bare name only when it was one of the
    // five level names, so an ALIASED import read as zero invocations and zero
    // findings, the same hole the bare-spelling widening closed one name over.
    // The alias is that call site under a different name, and it is read.
    const single = `
      use tracing::info as log_info;
      fn go(path: &str) { log_info!(%path, "opening"); }
    `;
    expect(tracingInvocations(single)).toHaveLength(1);
    const singleFindings = lint(single);
    expect(singleFindings).toHaveLength(1);
    expect(singleFindings[0].rule).toBe("R1");

    const braced = `
      use tracing::{info as log_info, warn as log_warn};
      fn go(path: &str) { log_info!(%path, "opening"); log_warn!(%path, "bye"); }
    `;
    expect(tracingInvocations(braced)).toHaveLength(2);
    expect(lint(braced)).toHaveLength(2);
  });

  it("still ignores an alias name that is not bound to tracing", () => {
    // The boundary that keeps the alias rule from becoming "any name in a file
    // that mentions tracing": a macro nothing here imports from `tracing` is not
    // a tracing call site, whatever it is called.
    const foreign = `
      use tracing::debug;
      use crate::fmt::pretty as log_info;
      fn go(path: &str) { log_info!(%path, "not a log record"); debug!("ok"); }
    `;
    const found = tracingInvocations(foreign);
    expect(found).toHaveLength(1);
    expect(found[0].level).toBe("debug");
  });

  it("does not resolve a crate rename or a re-export, the limits the header states", () => {
    // The shapes the header lists rather than claims. Resolving either needs a
    // module graph, not a `use` statement, so both read as zero invocations and
    // the limit is asserted rather than left to be discovered.
    expect(
      tracingInvocations(`
        use crate::log::info;
        fn go(p: &str) { info!(%p, "opening"); }
      `),
    ).toHaveLength(0);
    expect(
      tracingInvocations(`
        use tracing as t;
        fn go(p: &str) { t::info!(%p, "opening"); }
      `),
    ).toHaveLength(0);
  });

  it("still ignores a `!(` inside a string literal, so a quoted macro name is not a call site", () => {
    // The widened patterns require the `(` after the `!` for exactly this: this
    // tree's own specs quote `tracing::warn!` as data, and a pattern that
    // accepted the bare `!` read the rest of the file as its arguments.
    const quoted = `
      use tracing::warn;
      fn go() { let s = "tracing::warn!({" ; assert!(!s.is_empty()); }
    `;
    expect(tracingInvocations(quoted)).toHaveLength(0);
  });

  it("does not read a bare assert! as a call site even when the file imports tracing", () => {
    const withAssert = `
      use tracing::debug;
      fn go(v: &str) { assert!(!v.is_empty()); debug!("ok"); }
    `;
    const found = tracingInvocations(withAssert);
    expect(found).toHaveLength(1);
    expect(found[0].level).toBe("debug");
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
