// Shared reader for the DESKTOP WebView CSP, parsed from the canonical
// `src-tauri/tauri.conf.json`.
//
// Not a test file — the `_` prefix keeps it out of vitest's
// `tests/**/*.test.ts` collection, the same convention `_themeLink.ts` uses.
//
// It exists because two suites assert on that one string for unrelated
// reasons: `tests/editor/attachment-pdf-csp.test.ts` pins the `attachment:`
// entries the inline pdf.js render needs, and `tests/desktop-csp.test.ts`
// pins the injection vectors that cost nothing to close (myne#383). A second
// copy of the parser is a second thing to fix when the conf shape moves.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const confPath = resolve(here, "../../src-tauri/tauri.conf.json");

/**
 * The desktop CSP as a `directive -> value` map. A directive with no value
 * (there are none today) maps to the empty string rather than being dropped,
 * so `"x" in d` stays meaningful.
 */
export function desktopCspDirectives(): Record<string, string> {
  const conf = JSON.parse(readFileSync(confPath, "utf8")) as {
    app: { security: { csp: string } };
  };
  const directives: Record<string, string> = {};
  for (const part of conf.app.security.csp.split(";")) {
    const trimmed = part.trim();
    if (trimmed === "") continue;
    const sp = trimmed.indexOf(" ");
    const name = sp === -1 ? trimmed : trimmed.slice(0, sp);
    directives[name] = sp === -1 ? "" : trimmed.slice(sp + 1);
  }
  return directives;
}
