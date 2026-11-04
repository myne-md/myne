// @vitest-environment node
//
// The Rust↔TypeScript event-name mirrors: two constants per pair, written in two
// languages, with no compiler between them.
//
// # Why this is a test rather than a comment saying "keep these in step"
//
// `core` emits a Tauri event under a `&'static str`; the WebView subscribes under
// a TypeScript string literal. Nothing compares the two. A mismatch fails in the
// one direction that is invisible: the backend emits a name nobody listens for,
// or the page listens for a name nobody emits, no error is raised on either side,
// and the surface the event was meant to refresh simply stays stale, which is
// exactly the symptom the events exist to remove (MYND-478 for prefs, myne#943
// for themes).
//
// # Why it reads the files as text instead of importing the TS constants
//
// The claim is about the LITERALS, so the check has to see what is written rather
// than what a module happens to export at test time, and it has to run without a
// DOM or a mocked IPC layer. It therefore also fails when a constant is renamed
// on either side, which is the other half of the same silence.

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/** One pair: the file and constant name on each side. */
const PAIRS = [
  {
    what: "prefs-changed (MYND-478)",
    rust: ["core/src/plugins/prefs/commands.rs", "PREFS_CHANGED_EVENT"],
    ts: ["src/lib/prefs.ts", "PREFS_SYNC_APPLIED_EVENT"],
  },
  {
    what: "themes-changed (myne#943)",
    rust: ["core/src/plugins/themes/commands.rs", "THEMES_CHANGED_EVENT"],
    ts: ["src/lib/themesSignal.ts", "THEMES_SYNC_APPLIED_EVENT"],
  },
] as const;

/** The string literal a declaration of `name` is initialised with. */
function literal([file, name]: readonly [string, string]): string {
  const source = readFileSync(file, "utf8");
  // `name`, then anything that cannot cross an `=`, then the quoted value. The
  // `[^=]*` is what keeps a prose mention of the constant in a doc comment from
  // being read as its declaration.
  const match = source.match(new RegExp(`\\b${name}\\b[^=]*=\\s*"([^"]+)"`));
  expect(match, `${file} declares no string literal for ${name}`).not.toBeNull();
  return match![1];
}

describe("backend event names and their WebView mirrors", () => {
  for (const { what, rust, ts } of PAIRS) {
    it(`${what}: the WebView subscribes to the name core emits`, () => {
      expect(literal(ts)).toBe(literal(rust));
    });
  }
});
