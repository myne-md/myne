// @vitest-environment jsdom
//
// Render-performance benchmark harness (MYND-210, render-performance tasks 1+2).
// Run with `pnpm exec vitest bench`. Measures the decoration pipeline (full
// `myneExtensions()` via the shared harness) on tests.md and a synthetic
// large doc. The frame-budget target is ≤ ~16ms (60fps) per cursor-move rebuild
// within a documented doc-size ceiling; the heavy async widgets (KaTeX/Mermaid/
// emoji/DOMPurify) are stubbed-out by the harness, so this isolates the CORE
// decoration cost (the cursor-aware StateField walks that #7 watches).

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { bench, describe } from "vitest";
import { focusAt, mount, teardown } from "./_conformance";
import { syntheticDoc } from "./_synthetic-doc";

const TESTS_MD = readFileSync(
  resolve(process.cwd(), "tests/fixtures/tests.md"),
  "utf8",
);

const BIG = syntheticDoc(10_000);

describe("decoration pipeline", () => {
  bench("mount + initial decoration build — tests.md", () => {
    const m = mount(TESTS_MD);
    teardown(m);
  });

  bench("mount + initial decoration build — 10k-line synthetic doc", () => {
    const m = mount(BIG);
    teardown(m);
  });

  bench("cursor-move rebuild — 10k-line synthetic doc", () => {
    const m = mount(BIG, 0);
    focusAt(m, Math.floor(BIG.length / 2)); // triggers cursor-aware rebuilds
    teardown(m);
  });
});
