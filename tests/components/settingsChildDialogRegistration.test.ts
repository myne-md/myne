/**
 * Every Settings panel that can put a dialog on screen tells the shell about
 * it — myne-md/myne#555, the `settings.shell` bullet ("Esc-once-closes-child,
 * Esc-again-closes-Settings and the backdrop equivalent are shared modal-stack
 * logic").
 *
 * # The mechanism, and why it is fragile
 *
 * There is no modal stack. `SettingsModal` installs a `window` keydown listener
 * that closes Settings on Escape, and `ModalShell` — which every child dialog
 * is built from — installs its own `window` keydown listener that closes the
 * child. Both are on `window`, both fire for the same event, and neither calls
 * `stopPropagation`. What keeps one Escape from closing both is a single
 * boolean:
 *
 *     if (childDialogOpenRef.current) return;   // SettingsModal.tsx
 *
 * and that boolean is raised by the CHILD, through an `onDialogOpenChange` prop
 * the shell has to be passing to that panel in the first place. It is
 * hand-wired, per panel, in one object literal.
 *
 * # What breaks, and what does not notice
 *
 * A panel that grows a dialog and is not given the prop takes the user's single
 * Escape and closes BOTH surfaces at once: the dialog they meant to dismiss and
 * the Settings modal behind it, losing whatever they were in the middle of. The
 * backdrop path has the same shape — `handleBackdropClick` consults the same
 * flag.
 *
 * Nothing else sees it. `tsc` is happy, because `onDialogOpenChange` is
 * OPTIONAL on both panels that take it (it has to be: the panels are rendered
 * in tests and stories without a shell). A component test of the panel alone
 * passes, because the panel's own dialog closes correctly. A component test of
 * the shell alone passes, because no child is mounted. The defect exists only
 * in the composition, and only for the panels nobody thought about.
 *
 * # Why this is a source scan rather than a render
 *
 * Rendering all twelve panels and driving Escape through each would need a real
 * vault, a real IPC surface and, for two of them, a provider key — which is why
 * the roster row was a hand-walk. The wiring itself is a syntactic fact: a
 * panel file either reaches for a dialog primitive or it does not, and the
 * shell either passes it the prop or it does not. Comparing those two lists is
 * the whole check, and it holds for panels a rendering test could never reach.
 *
 * Compared in BOTH directions, so a stale registration — a panel that keeps the
 * prop after its dialog is gone — fails too. A prop nothing raises is a reader
 * being told a coordination exists when it does not.
 */

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// `process.cwd()` rather than `import.meta.url`: under jsdom the module URL is
// served as `/@fs/…`, which `fileURLToPath` turns into a path that does not
// exist. Vitest runs from the repo root.
const REPO_ROOT = process.cwd();
const SHELL = join(REPO_ROOT, "src/components/SettingsModal.tsx");
const PANEL_DIR = join(REPO_ROOT, "src/components/settings");

const shellSource = readFileSync(SHELL, "utf8");

/** The panel map's own entries: `<id>: <JSX for the panel>`.
 *
 *  Parsed out of the `panelContent` literal rather than hard-coded, so a panel
 *  added to the shell enters this test without anyone remembering to add it —
 *  which is the exact class of omission the test is about. */
function panelEntries(): { id: string; jsx: string }[] {
  const start = shellSource.indexOf("const panelContent: Record<PanelId, ReactNode> = {");
  expect(
    start,
    "could not find the `panelContent` map in SettingsModal.tsx — this test reads " +
      "the shell's own panel list, and a rename means it is now measuring nothing",
  ).toBeGreaterThan(-1);

  // Walk to the literal's matching close brace, counting depth. A regex cannot
  // do this: every entry is JSX carrying braces of its own.
  const open = shellSource.indexOf("{", start);
  let depth = 0;
  let end = -1;
  for (let i = open; i < shellSource.length; i += 1) {
    if (shellSource[i] === "{") depth += 1;
    else if (shellSource[i] === "}") {
      depth -= 1;
      if (depth === 0) {
        end = i;
        break;
      }
    }
  }
  expect(end, "the `panelContent` literal is unbalanced").toBeGreaterThan(-1);

  const body = shellSource.slice(open + 1, end);
  const out: { id: string; jsx: string }[] = [];
  // Split on top-level commas: entry boundaries, not commas inside JSX props.
  //
  // Braces and parens only. A first draft also tracked `<`/`>` to stay outside
  // JSX tags, which is wrong in a way that produced a confident false finding:
  // `=>` carries a `>`, so every arrow function in a prop drove the counter
  // negative, entries stopped splitting, and `account` was reported as holding
  // a prop that in fact belongs to `sync` two entries further down. Nothing is
  // needed here anyway — a multi-line entry is wrapped in parens and a
  // single-line one is a self-closing tag whose props are space-separated, so
  // no comma inside an entry is ever at depth zero.
  let depth2 = 0;
  let chunk = "";
  for (const ch of body) {
    if (ch === "{" || ch === "(") depth2 += 1;
    else if (ch === "}" || ch === ")") depth2 -= 1;
    if (ch === "," && depth2 === 0) {
      if (chunk.trim() !== "") out.push(parseEntry(chunk));
      chunk = "";
      continue;
    }
    chunk += ch;
  }
  if (chunk.trim() !== "") out.push(parseEntry(chunk));
  return out;
}

function parseEntry(chunk: string): { id: string; jsx: string } {
  const colon = chunk.indexOf(":");
  return { id: chunk.slice(0, colon).trim(), jsx: chunk.slice(colon + 1).trim() };
}

/** The component name a panel entry renders, e.g. `PrivacyPanel`. */
function componentOf(jsx: string): string {
  const m = jsx.match(/<([A-Z][A-Za-z0-9]*)/);
  return m ? m[1]! : "";
}

/** The three shapes a child dialog can take. `ModalShell` and `ConfirmDialog`
 *  are the primitives; a hand-rolled `role="dialog"` is the third, and it is
 *  included because a panel that builds its own overlay has exactly the same
 *  Escape collision — `ModalShell` is a convenience, not the mechanism.
 *
 *  Matched as JSX OPEN TAGS rather than as bare words, and that too is a
 *  measurement: `\bModalShell\b` reported `privacy` as opening a dialog, on the
 *  strength of a COMMENT inside `SearchableSelect` that mentions the z-index
 *  ModalShell sits at. A word match over source treats prose as code, and the
 *  finding it produced was confident and wrong. `<Name` is what rendering one
 *  actually looks like. */
function hasDialogSignal(source: string): boolean {
  return (
    /<ModalShell\b/.test(source) ||
    /<ConfirmDialog\b/.test(source) ||
    /role=["']dialog["']/.test(source)
  );
}

function readOrNull(path: string): string | null {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return null;
  }
}

/** Does this panel put a dialog on screen, directly or through one component it
 *  imports?
 *
 *  One level of indirection, and that is a measurement rather than a guess:
 *  scanning the panel file alone reported `sync` as holding the prop for no
 *  reason, because `SyncPanel` opens its dialog by rendering `BetaTermsConsent`
 *  from a sibling directory. A panel that delegates its overlay to a child
 *  component has exactly the same Escape collision as one that inlines it — the
 *  listener is on `window` either way — so the check has to follow the render,
 *  not the file.
 *
 *  It stops at one level on purpose. Two levels starts pulling in every shared
 *  primitive that happens to contain the word, and a check that flags
 *  everything is a check nobody can act on. */
function rendersADialog(componentName: string): boolean {
  const source = readOrNull(join(PANEL_DIR, `${componentName}.tsx`));
  if (source === null) return false;
  if (hasDialogSignal(source)) return true;

  for (const m of source.matchAll(/^import\s+\{([^}]*)\}\s+from\s+["'](\.[^"']*)["']/gm)) {
    const names = m[1]!.split(",").map((n) => n.trim().split(/\s+as\s+/)[0]!.trim());
    // Only follow an import the panel actually RENDERS — a type or a helper
    // brought in from a file that also happens to hold a dialog is not this
    // panel opening one.
    const rendered = names.filter((n) => /^[A-Z]/.test(n) && new RegExp(`<${n}\\b`).test(source));
    if (rendered.length === 0) continue;
    const imported = readOrNull(join(PANEL_DIR, `${m[2]!}.tsx`));
    if (imported !== null && hasDialogSignal(imported)) return true;
  }
  return false;
}

describe("Settings child dialogs are registered with the shell", () => {
  const entries = panelEntries();

  it("finds the shell's panel map and every panel in it", () => {
    // Non-vacuity. A parse that silently produced an empty list would make
    // every assertion below hold.
    expect(entries.length).toBeGreaterThanOrEqual(10);
    expect(entries.map((e) => e.id)).toContain("ai");
    expect(entries.map((e) => e.id)).toContain("sync");
    for (const e of entries) expect(componentOf(e.jsx), `panel ${e.id}`).not.toBe("");
  });

  it("passes onDialogOpenChange to every panel that can open a dialog", () => {
    const missing = entries
      .filter((e) => rendersADialog(componentOf(e.jsx)))
      .filter((e) => !/onDialogOpenChange/.test(e.jsx))
      .map((e) => `${e.id} (${componentOf(e.jsx)})`);

    expect(
      missing,
      `these Settings panels can put a dialog on screen and are NOT given ` +
        `\`onDialogOpenChange\`: ${missing.join(", ")}.\n` +
        `SettingsModal and ModalShell each install their own window keydown ` +
        `listener and neither stops propagation, so the user's single Escape ` +
        `closes the child dialog AND the Settings modal behind it. The only ` +
        `thing preventing that is the \`childDialogOpen\` flag, which the panel ` +
        `raises through this prop.`,
    ).toEqual([]);
  });

  it("does not leave the prop on a panel that no longer opens one", () => {
    const stale = entries
      .filter((e) => /onDialogOpenChange/.test(e.jsx))
      .filter((e) => !rendersADialog(componentOf(e.jsx)))
      .map((e) => `${e.id} (${componentOf(e.jsx)})`);

    expect(
      stale,
      `these panels are given \`onDialogOpenChange\` but render no dialog: ` +
        `${stale.join(", ")}. The prop then documents a coordination that ` +
        `nothing raises, which is worse than not having it — the next reader ` +
        `assumes the panel is covered.`,
    ).toEqual([]);
  });

  it("the shell still consults the flag on both dismissal paths", () => {
    // The registration above is worthless if the shell stops reading it, and
    // that deletion is one line in a file this test otherwise only parses.
    expect(
      shellSource,
      "SettingsModal no longer stands down on Escape while a child dialog is open",
    ).toMatch(/if \(childDialogOpenRef\.current\) return;/);
    expect(
      shellSource,
      "SettingsModal's backdrop click no longer consults the child-dialog flag",
    ).toMatch(/if \(childInFlight \|\| childDialogOpen\) return;/);
  });
});
