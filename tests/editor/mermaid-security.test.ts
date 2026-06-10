// Mermaid security config (MYND-49, task 4). Mermaid sanitizes its own SVG via
// an internal DOMPurify gated by `securityLevel`; the editor's job is to
// initialize it with the locked-down config. The real render needs a browser, so
// this verifies the initialization config through a mocked mermaid module.

import { describe, expect, it, vi } from "vitest";

interface InitConfig {
  securityLevel?: string;
  htmlLabels?: boolean;
  startOnLoad?: boolean;
}
const initCalls: InitConfig[] = [];

vi.mock("mermaid", () => ({
  default: {
    initialize: (cfg: InitConfig) => {
      initCalls.push(cfg);
    },
    render: async (_id: string, code: string) => ({ svg: `<svg>${code}</svg>` }),
  },
}));

describe("mermaid security config", () => {
  it("initializes mermaid with securityLevel:'strict' + htmlLabels:false", async () => {
    // Real loader (no _conformance stub imported here) → uses the mocked mermaid.
    const { loadMermaidRenderer } = await import(
      "../../src/editor/mermaid/render-mermaid"
    );
    await loadMermaidRenderer();
    expect(initCalls.length).toBeGreaterThan(0);
    const cfg = initCalls[initCalls.length - 1];
    expect(cfg.securityLevel).toBe("strict");
    expect(cfg.htmlLabels).toBe(false);
    expect(cfg.startOnLoad).toBe(false);
  });
});
