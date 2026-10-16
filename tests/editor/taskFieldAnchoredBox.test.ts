import fs from "node:fs";

import { describe, expect, it } from "vitest";

// The anchored surfaces' BOX CONTRACT (myne-md/myne#884, task 4).
//
// **The defect.** The positioner clamps a surface's TOP against the viewport, so
// a window shorter than the surface pinned the top, pushed the bottom past the
// edge and left nothing to scroll: the Cancel/Save row went off-screen with no
// way to reach it. The fix is three rules that only work TOGETHER, and the
// review that closed this task found them unproven, because the scenario written
// for them was removed (the desktop seat cannot produce a short window, since
// `tauri.conf.json` sets `minHeight: 600`) and the web-lane half was never run.
//
// jsdom applies no stylesheet, so this spec asserts the SOURCE, the way
// `tests/editor/taskQueryBuilder.test.ts` does for the query dialog: a revert of
// the box contract fails here BY NAME instead of in a container nobody ran.
//
// **What this deliberately does not claim.** That the box MEASURES right under a
// real window. That half is the manual-test roster's item (`app.diagnostics`'s
// sibling, the task-field sheet's keyboard item) and the web lane's scenario, and
// neither has run. This is the half that needs no viewport, stated as the half it
// is rather than as the whole criterion.

function anchoredSection(): string {
  const css: string = fs.readFileSync("editor/src/task-surfaces.css", "utf8");
  // SLICE to the section before asserting anything about it. An assertion over
  // the whole sheet passes on a rule that lives in some other section, which is
  // exactly the drift this is meant to catch.
  const start = css.indexOf("── The anchored surfaces fit the window they were given");
  expect(start, "the anchored-surfaces section marker is gone").toBeGreaterThan(-1);
  return css.slice(start);
}

function ruleFor(section: string, selector: string): string {
  const pattern = new RegExp(
    `${selector.replace(/[.*+?^${}()|[\]\\-]/g, "\\$&")}\\s*\\{([\\s\\S]*?)\\n\\}`,
  );
  const match = pattern.exec(section);
  if (match === null) throw new Error(`the rule for ${selector} is gone`);
  return match[1];
}

describe("the anchored task-field surfaces fit a short window (task 4)", () => {
  it("bounds the editor by the VIEWPORT, so a short window cannot push the actions off-screen", () => {
    // Scoped to the editor's OWN rule rather than to the section. `toContain`
    // over the whole section passed while this rule was deleted, because the
    // popover's `.cm-task-field-menu` carries the identical string one rule
    // down: an anti-drift assertion over a sheet that holds the value twice
    // cannot fail on the drift it exists for.
    expect(ruleFor(anchoredSection(), ".cm-task-field-editor")).toContain(
      "max-height: calc(100vh - var(--space-6))",
    );
  });

  it("makes the BODY the scroller, so the bound has somewhere to put the overflow", () => {
    const body = ruleFor(anchoredSection(), ".cm-task-field-editor > :first-child");
    expect(body).toContain("flex: 1 1 auto");
    // Without this the flex item refuses to shrink below its content and the
    // scroller never engages, which is the box-contract failure that reads as
    // "the CSS is there and it still does not work".
    expect(body).toContain("min-height: 0");
    expect(body).toContain("overflow-y: auto");
  });

  it("keeps the actions row OUTSIDE that scroll", () => {
    const actions = ruleFor(anchoredSection(), ".cm-task-field-actions");
    expect(actions).toContain("flex: none");
    // Non-vacuity: the scroller must be the BODY and never the actions row, or
    // the row can scroll out of reach again under a different selector.
    expect(actions).not.toContain("overflow-y");
  });

  it("bounds the two-pane popover's own pane, which holds the same editor", () => {
    const section = anchoredSection();
    const menu = ruleFor(section, ".cm-task-field-menu");
    expect(menu).toContain("max-height: calc(100vh - var(--space-6))");
    // The PANE is what scrolls in this shape, not the shell: the shell holds the
    // left field list beside the right pane, and scrolling the shell would take
    // the list with it.
    const pane = ruleFor(section, ".cm-task-field-menu-pane");
    expect(pane).toContain("min-height: 0");
    expect(pane).toContain("overflow-y: auto");
  });
});
