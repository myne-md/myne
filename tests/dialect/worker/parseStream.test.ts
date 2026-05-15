// parseStream — async-iterable contract tests.
//
// In-process tests cover the public AsyncIterable contract (ordering,
// cancellation, independence). The actual off-main-thread Web Worker
// entry (`worker/main.ts`) wraps `parse()` with a postMessage protocol;
// it's not unit-tested in node (Vitest in node env has no Worker
// runtime), but its protocol mirrors what `parseStream` consumes.

import { describe, expect, it } from "vitest";
import * as fs from "node:fs";
import { fileURLToPath } from "node:url";
import { parseStream } from "../../../src/dialect/worker";

const enc = new TextEncoder();

describe("parseStream — ordering", () => {
  it("yields results in source order", async () => {
    const items = [
      { id: "a", bytes: enc.encode("# Alpha\n") },
      { id: "b", bytes: enc.encode("# Beta\n") },
      { id: "c", bytes: enc.encode("# Gamma\n") },
    ];
    const yielded: string[] = [];
    for await (const r of parseStream(items)) {
      yielded.push(r.id);
    }
    expect(yielded).toEqual(["a", "b", "c"]);
  });

  it("each yielded result carries the parsed ParseResult shape", async () => {
    const items = [{ id: "a", bytes: enc.encode("# Alpha\n") }];
    let count = 0;
    for await (const r of parseStream(items)) {
      count++;
      expect(r.id).toBe("a");
      expect(r.result.headings).toHaveLength(1);
      expect(r.result.headings[0]?.text).toBe("Alpha");
    }
    expect(count).toBe(1);
  });
});

describe("parseStream — cancellation", () => {
  it("stops pulling new items from the iterable after consumer break", async () => {
    let nextCalls = 0;
    function* itemGen() {
      for (let i = 0; i < 100; i++) {
        nextCalls++;
        yield { id: String(i), bytes: enc.encode("# x\n") };
      }
    }
    let yielded = 0;
    for await (const _r of parseStream(itemGen())) {
      yielded++;
      if (yielded === 5) break;
    }
    expect(yielded).toBe(5);
    // After break: at most one prefetched item past the consumer's break point.
    expect(nextCalls).toBeLessThanOrEqual(6);
  });

  it("empty input yields nothing", async () => {
    const yielded: string[] = [];
    for await (const r of parseStream([])) {
      yielded.push(r.id);
    }
    expect(yielded).toEqual([]);
  });
});

describe("parseStream — invariants", () => {
  it("Comlink is not a project dependency", () => {
    const pkgPath = fileURLToPath(
      new URL("../../../package.json", import.meta.url),
    );
    const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf-8")) as {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };
    expect(pkg.dependencies?.comlink).toBeUndefined();
    expect(pkg.devDependencies?.comlink).toBeUndefined();
  });

  it("multiple parseStream invocations are independent", async () => {
    const items1 = [{ id: "a1", bytes: enc.encode("# One\n") }];
    const items2 = [{ id: "a2", bytes: enc.encode("# Two\n") }];

    const r1: string[] = [];
    for await (const r of parseStream(items1)) r1.push(r.id);

    const r2: string[] = [];
    for await (const r of parseStream(items2)) r2.push(r.id);

    expect(r1).toEqual(["a1"]);
    expect(r2).toEqual(["a2"]);
  });

  it("never throws on adversarial input bytes", async () => {
    const items = [
      { id: "empty", bytes: enc.encode("") },
      { id: "invalid-utf8", bytes: new Uint8Array([0xff, 0xfe, 0xfd]) },
      { id: "long", bytes: enc.encode("x".repeat(10000)) },
    ];
    let count = 0;
    for await (const r of parseStream(items)) {
      count++;
      expect(r.result).toBeDefined();
    }
    expect(count).toBe(3);
  });
});
