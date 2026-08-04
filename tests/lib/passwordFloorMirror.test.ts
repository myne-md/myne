// myne#289 — the password floor and the unit it is counted in, pinned across
// the Rust/TS boundary.
//
// `protocol/src/password_policy.rs` states the problem in its own module doc:
// "the frontend's minimum-length constant duplicates this value via a TS
// hand-mirror … A CI drift-check is a Phase 1 end task" — i.e. nothing checked
// it. Two things could drift, and both did damage:
//
//   - the VALUE (12), which would let the form accept what the host refuses;
//   - the UNIT. Rust counts `chars()` (Unicode scalars); the form counted
//     `String.length` (UTF-16 code units). Any password of >= 12 units but < 12
//     scalars — one emoji appended to a ten-character password is enough —
//     passed the form and was refused by the host, and the refusal had no
//     mapped arm, so the flow hung.
//
// The unit was fixed on the TS side (`passwordLength` iterates the string).
// This pins both halves so neither can drift back silently.

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { MIN_PASSWORD_LEN, passwordLength } from "../../src/components/PasswordInput";

const REPO = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

describe("the master-password floor", () => {
  it("matches the Rust constant it mirrors", () => {
    const src = readFileSync(join(REPO, "protocol/src/password_policy.rs"), "utf8");
    const m = /pub const MIN_PASSWORD_LEN: usize = (\d+);/.exec(src);
    expect(m, "MIN_PASSWORD_LEN must be declared in password_policy.rs").not.toBeNull();
    expect(MIN_PASSWORD_LEN).toBe(Number(m![1]));
  });

  it("is counted in the same unit the backend counts", () => {
    // Rust: `chars().count()`. TS must therefore iterate, not read `.length`.
    const twelveScalars = "😀🎉🚀🌍🔥🍕😀🎉🚀🌍🔥🍕";
    expect(passwordLength(twelveScalars)).toBe(12);
    expect(twelveScalars.length).toBe(24); // …which `.length` would have said

    // The exact shape that hung the creation flow: 12 UTF-16 units, 11 scalars.
    const elevenScalars = "Xk9#mQ2vLp😀";
    expect(elevenScalars.length).toBe(12);
    expect(passwordLength(elevenScalars)).toBe(11);
    expect(passwordLength(elevenScalars)).toBeLessThan(MIN_PASSWORD_LEN);
  });

  it("still counts plain ASCII the obvious way", () => {
    expect(passwordLength("correct horse battery staple")).toBe(28);
  });
});
