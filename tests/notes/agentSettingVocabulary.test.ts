// The Rust mirror of the display-format vocabulary is held to the editor's list
// (myne-md/myne#850, from the 2026-10-14 review).
//
// **Two lists in two languages, and the failure is silent.** The agent's
// `editor.date-format` / `editor.time-format` values are validated host-side
// against `DATE_FORMAT_VALUES` / `TIME_FORMAT_VALUES` in
// `core/src/plugins/agent/setting.rs`, while `editor/src/host/lib/datetimeFormat.ts`
// owns the vocabulary and coerces an unknown value to `system`. A member added on
// one side only means the agent either refuses a value the app accepts, or writes
// one that silently becomes `system` with the row already approved.
//
// Parsed rather than imported, the `settingRejectionMirror.test.ts` shape: the
// Rust list is the thing being checked, so reading it as data is the point. A
// parse that finds nothing throws rather than passing over an empty denominator.

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import {
  DATE_FORMATS,
  TIME_FORMATS,
} from "@myne/editor/host/lib/datetimeFormat";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, "..", "..");

const settingRs = readFileSync(
  join(REPO, "core/src/plugins/agent/setting.rs"),
  "utf8",
);

/** The members of one `pub const <name>: &[&str] = &[…]` in `setting.rs`. */
function rustList(name: string): string[] {
  const match = new RegExp(
    `pub const ${name}: &\\[&str\\] = &\\[([^\\]]*)\\]`,
  ).exec(settingRs);
  if (match === null) {
    throw new Error(
      `${name} not found in core/src/plugins/agent/setting.rs. If it moved, ` +
        `this test has to follow it rather than be deleted`,
    );
  }
  const values = [...match[1].matchAll(/"([^"]*)"/g)].map((m) => m[1]);
  if (values.length === 0) {
    throw new Error(`${name} parsed as an empty list, which checks nothing`);
  }
  return values;
}

describe("the display-format vocabulary mirror", () => {
  it("matches the editor's DATE_FORMATS", () => {
    expect(rustList("DATE_FORMAT_VALUES")).toEqual([...DATE_FORMATS]);
  });

  it("matches the editor's TIME_FORMATS", () => {
    expect(rustList("TIME_FORMAT_VALUES")).toEqual([...TIME_FORMATS]);
  });
});
