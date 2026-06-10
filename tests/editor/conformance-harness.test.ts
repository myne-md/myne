// @vitest-environment jsdom
//
// Smoke test for the shared conformance harness (MYND-208, task 1). Proves the
// full `myneExtensions()` editor mounts the torture document without throwing,
// produces decorations, and that the byte round-trip helper is sound. The
// whole-doc byte-stability assertion + per-construct cases land in task 2/3.

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  type Mounted,
  mount,
  query,
  renderedText,
  roundTripBytes,
  teardown,
} from "./_conformance";

// Vitest runs with the repo root as cwd (vitest.config.ts at root).
const TESTS_MD = readFileSync(
  resolve(process.cwd(), "tests/fixtures/tests.md"),
  "utf8",
);

let mounted: Mounted | null = null;
afterEach(() => {
  if (mounted !== null) teardown(mounted);
  mounted = null;
});

describe("conformance harness", () => {
  it("mounts the full editor over tests.md without throwing", () => {
    mounted = mount(TESTS_MD);
    expect(mounted.view).toBeDefined();
    expect(renderedText(mounted).length).toBeGreaterThan(0);
  });

  it("renders a heading decoration through the real pipeline", () => {
    mounted = mount("# Hello\n");
    expect(query(mounted, ".cm-h1")).not.toBeNull();
  });

  it("roundTripBytes returns a representative doc unchanged", () => {
    const doc = "# H\n\n- a\n- b\n\n> quote\n\n`code` and **bold**\n";
    expect(roundTripBytes(doc)).toBe(doc);
  });
});
