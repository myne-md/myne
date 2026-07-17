// `runLayout` fallback path: in the node test env `Worker` is undefined, so
// the constructor throws and the synchronous kernel must serve the request —
// exactly the WKWebView/Android-WebView degradation path.

import { describe, expect, it } from "vitest";
import { computeGraphLayout } from "../src/lib/graph-layout-kernel";
import { runLayout } from "../src/lib/graph-layout-run";

describe("runLayout (no Worker available)", () => {
  it("falls back to the synchronous kernel and matches it exactly", async () => {
    const req = {
      nodes: [{ id: "a" }, { id: "b" }],
      edges: [{ source: "a", target: "b", weight: 1 }],
      seed: {},
      width: 390,
      height: 700,
    };
    const viaRun = await runLayout(req);
    const direct = computeGraphLayout(req);
    expect(viaRun).toEqual(direct); // deterministic kernel → byte-equal
  });
});
