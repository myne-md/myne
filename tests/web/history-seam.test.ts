// @vitest-environment jsdom
//
// The WEB arm of the history seam (phase3-web-client task 64).
//
// jsdom, because this module is nothing but browser API: `location.pathname`,
// `history.pushState/replaceState`, and the `popstate` event. Mocking those
// would leave the file untested — the assertions below are about what the
// browser actually does with what we hand it.
//
// The desktop arm is asserted in `tests/stage/route-binding.test.tsx` by the
// binding tests (it is all no-ops, and "desktop behaviour unchanged" is the
// criterion those cover).

import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  onRouteChange,
  pushRoute,
  readRoute,
  replaceRoute,
} from "../../web/src/platform/history";

const NOTE = "0199c1de-7b3a-7000-8000-0123456789ab";

beforeEach(() => {
  history.replaceState(null, "", "/");
});

describe("readRoute", () => {
  it("parses a stage path", () => {
    history.replaceState(null, "", "/unlock");
    expect(readRoute()).toEqual({ name: "unlock" });
  });

  it("parses a note deep link", () => {
    history.replaceState(null, "", `/editor/${NOTE}`);
    expect(readRoute()).toEqual({ name: "editor", noteId: NOTE });
  });

  it("returns null at the root, where the URL addresses nothing", () => {
    history.replaceState(null, "", "/");
    expect(readRoute()).toBeNull();
  });

  it("returns null for a stage name it does not know", () => {
    // Untrusted input: anything can be typed into the address bar. An unknown
    // name means "the URL says nothing" — the caller falls back to the boot
    // probe rather than inventing a stage.
    history.replaceState(null, "", "/admin");
    expect(readRoute()).toBeNull();
  });

  it("DROPS a malformed note id rather than failing the whole route", () => {
    // The difference between a stale bookmark and an error screen: the user
    // still lands on the view they asked for.
    history.replaceState(null, "", "/editor/not-a-uuid");
    expect(readRoute()).toEqual({ name: "editor" });
  });

  it("rejects a note id that is only uuid-SHAPED", () => {
    // Uppercase hex and a 37-char id are both "looks like a uuid" and neither
    // is one; a note id is the canonical 36-char lowercase form or it is not a
    // note id.
    history.replaceState(null, "", `/editor/${NOTE.toUpperCase()}`);
    expect(readRoute()).toEqual({ name: "editor" });
    history.replaceState(null, "", `/editor/${NOTE}a`);
    expect(readRoute()).toEqual({ name: "editor" });
  });

  it("ignores trailing path segments", () => {
    history.replaceState(null, "", `/editor/${NOTE}/extra/junk`);
    expect(readRoute()).toEqual({ name: "editor", noteId: NOTE });
  });
});

describe("pushRoute / replaceRoute", () => {
  it("writes the path a route addresses", () => {
    pushRoute({ name: "editor", noteId: NOTE });
    expect(location.pathname).toBe(`/editor/${NOTE}`);
    replaceRoute({ name: "unlock" });
    expect(location.pathname).toBe("/unlock");
  });

  it("writes NOTHING but the stage and the id", () => {
    // The closed `Route` type is the design guarantee; this is the runtime one.
    // A future field — a title, a search term, a folder — must not reach the
    // address bar by being spread into the path or a query string, and a type
    // cannot catch an implementation that iterates the object at runtime.
    const smuggled = {
      name: "editor",
      noteId: NOTE,
      title: "quarterly-plan",
      query: "salary",
    } as unknown as Parameters<typeof pushRoute>[0];
    pushRoute(smuggled);
    expect(location.pathname).toBe(`/editor/${NOTE}`);
    expect(location.search).toBe("");
    expect(location.hash).toBe("");
  });

  it("never stacks a duplicate entry", () => {
    // A re-render that re-asserts the same location must not cost the user a
    // back press.
    const before = history.length;
    pushRoute({ name: "picker" });
    const after = history.length;
    pushRoute({ name: "picker" });
    pushRoute({ name: "picker" });
    expect(location.pathname).toBe("/picker");
    expect(history.length).toBe(after);
    expect(after).toBeGreaterThan(before);
  });

  it("replaceRoute does not grow the history", () => {
    const before = history.length;
    replaceRoute({ name: "welcome" });
    replaceRoute({ name: "recover" });
    expect(history.length).toBe(before);
    expect(location.pathname).toBe("/recover");
  });
});

describe("onRouteChange", () => {
  it("reads the PATH, not the popstate state", () => {
    // A popstate can arrive for an entry this app never pushed (a manual URL
    // edit, a restored session) where `state` is null but the path is still
    // meaningful.
    const seen: unknown[] = [];
    const off = onRouteChange((r) => seen.push(r));
    history.replaceState(null, "", `/editor/${NOTE}`);
    dispatchEvent(new PopStateEvent("popstate", { state: null }));
    expect(seen).toEqual([{ name: "editor", noteId: NOTE }]);
    off();
  });

  it("stays silent for a path that addresses nothing", () => {
    const handler = vi.fn();
    const off = onRouteChange(handler);
    history.replaceState(null, "", "/somewhere-else");
    dispatchEvent(new PopStateEvent("popstate"));
    expect(handler).not.toHaveBeenCalled();
    off();
  });

  it("detaches on unsubscribe", () => {
    const handler = vi.fn();
    onRouteChange(handler)();
    history.replaceState(null, "", "/picker");
    dispatchEvent(new PopStateEvent("popstate"));
    expect(handler).not.toHaveBeenCalled();
  });
});
