// @vitest-environment node
//
// Focus is never entirely hidden by sticky chrome (myne-md/myne#728, task 14;
// WCAG 2.2 SC 2.4.11, Focus Not Obscured, Minimum).
//
// The failure is specific and silent: a scroll container has a
// `position: sticky; top: 0` header with an opaque background, and a
// keyboard-focusable element inside it. Tab to an element just above the fold
// and the browser scrolls it to the scroll TOP, which is precisely where the
// header is. The focused control, ring and all, ends up entirely behind it and
// the user is tabbing blind. Nothing reports it: the DOM is right, the ring is
// drawn, it is simply drawn underneath something.
//
// This is a LAYOUT property, so jsdom cannot judge it and neither can axe
// (there is no rule for 2.4.11). What can be checked here is the pairing that
// produces it: a sticky top header plus focusable content plus no
// `scroll-padding-top` on the scroller. So the audit is recorded as a table of
// every sticky in the shared trees, with the verdict and the reason, and the
// table is compared against the tree in BOTH directions, so a new sticky fails
// here rather than being discovered by a user.

import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

type Verdict =
  | { kind: "fixed"; why: string }
  | { kind: "not-applicable"; why: string };

/**
 * Every `position: "sticky"` in the shared client trees, with what it does
 * about 2.4.11. A verdict per sticky rather than a blanket rule, because the
 * criterion only bites when the sticky can cover something KEYBOARD-focusable,
 * and three of the four here cannot.
 */
const STICKY_VERDICTS: Record<string, Verdict> = {
  "src/components/attachments/AttachmentsLibrary.tsx": {
    kind: "fixed",
    why: "A sticky top list header over rows whose preview target is tabIndex 0. The scroller carries scroll-padding-top.",
  },
  "src/components/settings/EditorPanel.tsx": {
    kind: "not-applicable",
    why: "The sticky is a right-hand preview COLUMN, a flex sibling of the controls column rather than an overlay on it, so it is never between the viewport and a focused control.",
  },
  "src/notes/components/DiffView.tsx": {
    kind: "not-applicable",
    why: "Sticky column labels over read-only diff cells. The view contains no focusable element at all, so there is no focus to obscure.",
  },
  "src/notes/views/tableView.tsx": {
    kind: "not-applicable",
    why: "The pinned Name column is sticky on the INLINE axis, and the rows it can cover carry tabIndex -1: they are click targets, never keyboard-focus stops.",
  },
  "mobile/src/app/flows/EditorFlow.tsx": {
    kind: "not-applicable",
    why: "A sticky section header over the note list. The rows beneath it take focus only through the shared `tappable` helper, whose Tab stop exists for an EXTERNAL keyboard, and the mobile list scrolls the focused row into the middle of a short viewport rather than under a header the height of one line. Re-checked by hand per the device matrix rather than by a static clearance nobody can measure here.",
  },
  "mobile/src/app/flows/editor/views/tableView.tsx": {
    kind: "not-applicable",
    why: "The mobile mirror of the desktop saved-view table: the pinned Name column is sticky on the INLINE axis, and the rows it can cover are not keyboard-focus stops.",
  },
  "mobile/src/gallery/Gallery.tsx": {
    kind: "not-applicable",
    why: "The design gallery, not the app. `scripts/check-manual-test-roster.mjs` exempts `mobile/src/screens` for the same reason: it renders static mocks into device frames and ships to nobody.",
  },
};

const ROOTS = [
  "src",
  "editor/src",
  "client-core/src",
  "web/src",
  // `mobile/src` was missing from the first version, and it carries three
  // stickies. A roster with a whole client outside it reports `ok` over that
  // client forever, which is the `check-prefs-nonce.mjs` blind spot the root
  // AGENTS.md records.
  "mobile/src",
] as const;

function filesUnder(dir: string, out: string[] = []): string[] {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  for (const entry of entries) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      if (entry !== "node_modules") filesUnder(full, out);
    } else if (full.endsWith(".ts") || full.endsWith(".tsx")) {
      out.push(full);
    }
  }
  return out;
}

function code(path: string): string {
  return readFileSync(path, "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/.*$/gm, "$1");
}

/** Files declaring a sticky position in real code (comments stripped). */
function stickyFiles(): string[] {
  const found: string[] = [];
  for (const root of ROOTS) {
    for (const file of filesUnder(root)) {
      if (/position:\s*"sticky"/.test(code(file))) found.push(file);
    }
  }
  return found.sort();
}

describe("every sticky has a 2.4.11 verdict", () => {
  it("finds the stickies at all", () => {
    // Non-vacuity: a scan that silently stops matching reports a clean tree.
    expect(stickyFiles().length).toBeGreaterThanOrEqual(7);
  });

  it("a new sticky fails here rather than being found by a user", () => {
    const unjudged = stickyFiles().filter((f) => !(f in STICKY_VERDICTS));
    expect(unjudged, unjudged.join("\n")).toEqual([]);
  });

  it("a verdict does not outlive its sticky", () => {
    // The other direction: a file that stopped being sticky leaves a verdict
    // behind that reads as coverage.
    const present = new Set(stickyFiles());
    const stale = Object.keys(STICKY_VERDICTS).filter((f) => !present.has(f));
    expect(stale, stale.join("\n")).toEqual([]);
  });

  it("every verdict states a reason", () => {
    for (const [file, verdict] of Object.entries(STICKY_VERDICTS)) {
      expect(verdict.why.length, file).toBeGreaterThan(40);
    }
  });

  it("every FIXED sticky's scroller really carries the clearance", () => {
    // The claim the verdict makes, checked against the file rather than
    // trusted. A verdict saying "the scroller carries scroll-padding-top" over
    // a scroller that does not is worse than no verdict.
    for (const [file, verdict] of Object.entries(STICKY_VERDICTS)) {
      if (verdict.kind !== "fixed") continue;
      expect(code(file), file).toContain("scrollPaddingTop");
    }
  });

  it("the clearance is a spacing token, not a pixel guess", () => {
    const src = code("src/components/attachments/AttachmentsLibrary.tsx");
    expect(src).toMatch(/scrollPaddingTop:\s*"var\(--space-\d\)"/);
  });
});
