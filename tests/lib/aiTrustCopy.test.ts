import { describe, expect, it } from "vitest";

import {
  AI_CHAT_HONESTY_NOTE,
  AI_TRUST_DISCLOSURE,
  AI_TRUST_HEADLINE,
} from "../../src/lib/load-bearing-copy";

// Local-AI trust affordance (ai-ux-surface MYND-408, task 2, SYNC-16). The two
// constants are load-bearing: their exact wording is a threat-model-bounded
// privacy claim. Asserted by FULL-literal `===` equality (never substring) so a
// future edit that over-claims — or silently collapses the disclosure — fails
// here rather than shipping. Mirrors the E2E full-literal discipline (SYNC-8).
describe("local-AI trust affordance copy (SYNC-16, load-bearing)", () => {
  it("headline is the exact threat-model-bounded literal", () => {
    expect(AI_TRUST_HEADLINE).toBe(
      "This model runs entirely on your device. Myne never sends your notes to any server.",
    );
  });

  it("disclosure is the exact literal, acknowledging the A7 residual without over-claiming", () => {
    expect(AI_TRUST_DISCLOSURE).toBe(
      "Inference runs locally with no network access, so your notes are never transmitted. You pick the model file from your own disk. Like the rest of Myne, this does not protect against malware already running on your device — such software can read app memory.",
    );
  });

  it("makes no absolute privacy claim beyond the threat model (A7/A13 honesty)", () => {
    const combined =
      `${AI_TRUST_HEADLINE} ${AI_TRUST_DISCLOSURE}`.toLowerCase();
    // Over-claims explicitly banned by PRODUCT.md:41,80 — the copy must not
    // promise absolute privacy the threat model does not deliver.
    expect(combined).not.toContain("fully private");
    expect(combined).not.toContain("completely secure");
    expect(combined).not.toContain("never leaves");
    // …and it must positively acknowledge the on-device malware residual (A7).
    expect(combined).toContain("malware already running on your device");
    // …and it must NOT claim model-runtime isolation until the sidecar lands —
    // `threat-model.md` §7: the runtime is IN-PROCESS in v0.1, so a "sandbox"
    // claim over-states the guarantee. Re-add only when the sidecar ships.
    expect(combined).not.toContain("sandbox");
  });
});

// Conversational-AI-chat honesty note (conversational-ai-chat task 13). The
// fallibility + grounding framing for a weak on-device model. Load-bearing:
// full-literal `===` so an edit that over-claims capability/accuracy or claims
// runtime isolation fails here rather than shipping.
describe("conversational-AI-chat honesty note (task 13, load-bearing)", () => {
  it("is the exact literal admitting fallibility + pointing at the citations", () => {
    expect(AI_CHAT_HONESTY_NOTE).toBe(
      "Answers come from a small model running on your device and may be wrong — check the notes it cites.",
    );
  });

  it("admits fallibility and claims no cloud-grade capability, accuracy, or isolation", () => {
    const lower = AI_CHAT_HONESTY_NOTE.toLowerCase();
    // Positively admits the model can be wrong (the honest counterweight).
    expect(lower).toContain("may be wrong");
    // Must not over-claim capability/accuracy or imply isolation.
    expect(lower).not.toContain("accurate");
    expect(lower).not.toContain("sandbox");
    expect(lower).not.toContain("fully private");
    expect(lower).not.toContain("always");
  });
});
