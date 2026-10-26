// @vitest-environment jsdom
//
// myne-md/myne#908 item 7 — a slash query never spans whitespace, but the live
// filter path did not enforce it. `filterCommands` hands the raw query to
// `fuzzyFilter`, which TRIMS it: `"/"` followed by a space produced the empty
// query, every command matched, and `Prec.highest` Enter applied the first one
// instead of inserting the newline the user asked for.
//
// The trigger scan already states the invariant ("a slash query never spans
// whitespace"). These specs hold the live path to the same rule, in both
// directions: whitespace closes, and a non-space query still does not.

import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { type Mounted, mount, teardown } from "./_conformance";

beforeAll(() => {
  if (typeof Element.prototype.scrollIntoView !== "function") {
    Element.prototype.scrollIntoView = () => {};
  }
});

const raf = (): Promise<void> =>
  new Promise((resolve) => requestAnimationFrame(() => resolve()));

let m: Mounted | null = null;
afterEach(() => {
  if (m !== null) teardown(m);
  m = null;
});

const menu = () => document.body.querySelector(".cm-slash-menu");

describe("the slash menu closes on whitespace", () => {
  it("closes the moment a space follows the trigger", async () => {
    m = mount("hello ", 6);
    m.view.coordsAtPos = () => null;

    m.view.dispatch({ changes: { from: 6, insert: "/" }, selection: { anchor: 7 } });
    await raf();
    expect(menu()).not.toBeNull();

    m.view.dispatch({ changes: { from: 7, insert: " " }, selection: { anchor: 8 } });
    await raf();
    expect(menu()).toBeNull();
  });

  it("closes on a space after a typed query too", async () => {
    m = mount("", 0);
    m.view.coordsAtPos = () => null;

    m.view.dispatch({ changes: { from: 0, insert: "/" }, selection: { anchor: 1 } });
    await raf();
    m.view.dispatch({ changes: { from: 1, insert: "h1" }, selection: { anchor: 3 } });
    await raf();
    expect(menu()).not.toBeNull();

    m.view.dispatch({ changes: { from: 3, insert: " " }, selection: { anchor: 4 } });
    await raf();
    expect(menu()).toBeNull();

    // The space is a space, not a command application: `/h1 ` must survive.
    expect(m.view.state.doc.toString()).toBe("/h1 ");
  });

  it("does not reopen when the query already contains whitespace", async () => {
    m = mount("/a b", 4);
    m.view.coordsAtPos = () => null;

    // Deleting the trailing character leaves the caret after the whitespace,
    // which is the reopen-on-deletion path. It must decline for the same
    // reason: the run from the trigger to the caret contains a space.
    m.view.dispatch({ changes: { from: 3, to: 4 }, selection: { anchor: 3 } });
    await raf();
    expect(menu()).toBeNull();
  });

  it("still stays open for a query with no whitespace", async () => {
    m = mount("", 0);
    m.view.coordsAtPos = () => null;

    m.view.dispatch({ changes: { from: 0, insert: "/" }, selection: { anchor: 1 } });
    await raf();
    m.view.dispatch({ changes: { from: 1, insert: "h" }, selection: { anchor: 2 } });
    await raf();
    expect(menu()).not.toBeNull();
  });
});
