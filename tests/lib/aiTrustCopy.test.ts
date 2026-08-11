import { describe, expect, it } from "vitest";

import {
  AI_CHAT_HONESTY_NOTE,
  AI_TRUST_A7_RESIDUAL,
  AI_TRUST_INVARIANT,
  aiTrustDetail,
  aiTrustDisclosure,
  aiTrustHeadline,
  type AiTrustState,
} from "../../src/lib/load-bearing-copy";

// AI trust affordance (ai-ux-surface MYND-408 task 2 / ai-remote-providers
// myne#415 task 12, SYNC-16/SYNC-7). Load-bearing: the exact wording is a
// threat-model-bounded privacy claim. Asserted by FULL-literal `===` equality
// (never substring) so a future edit that over-claims — or silently collapses a
// clause — fails here rather than shipping. Mirrors the E2E discipline (SYNC-8).
//
// The shape is one INVARIANT sentence plus one STATE sentence, quoted from
// `decisions.md` 2026-08-09. Each clause below is annotated with the
// threat-model sentence it is bounded by, because "traceable to the threat
// model" is the actual contract and a literal with no provenance is just a
// string somebody liked.
const STATES: AiTrustState[] = [
  { kind: "in-process" },
  { kind: "local-runtime", name: "Ollama" },
  { kind: "remote", provider: "OpenRouter" },
];

describe("AI trust affordance copy (SYNC-16/SYNC-7, load-bearing)", () => {
  it("the invariant sentence is the exact literal, shown in every state", () => {
    // Bounded by threat-model.md §5: "no byte leaves the device unless the
    // user has named a provider" + the never-downloaded ruling.
    expect(AI_TRUST_INVARIANT).toBe(
      "Myne never sends your notes anywhere you have not named, and never downloads a model.",
    );
  });

  it("the A7 residual is unchanged from the pre-provider wording", () => {
    // Bounded by threat-model.md §5 "NOT Protected Against — A7". Deliberately
    // byte-identical to what shipped before the provider work: no provider
    // setting changes this residual, so the sentence must not drift either.
    expect(AI_TRUST_A7_RESIDUAL).toBe(
      "Like the rest of Myne, this does not protect against malware already running on your device — such software can read app memory.",
    );
  });

  it("the in-process state is the exact pair (no provider named)", () => {
    // Bounded by §7 "Local AI runs in-process, not yet sandboxed" — it claims
    // locality, never isolation.
    expect(aiTrustHeadline({ kind: "in-process" })).toBe(
      "This model runs entirely on your device.",
    );
    expect(aiTrustDetail({ kind: "in-process" })).toBe(
      "The model is a file on this computer and no network connection is involved.",
    );
  });

  it("the local-runtime state names the program and disclaims control (TB12)", () => {
    // Bounded by TB12: the far side is separately distributed, unsigned by
    // Myne, absent from Cargo.lock, unaudited.
    expect(aiTrustHeadline({ kind: "local-runtime", name: "Ollama" })).toBe(
      "This runs on a program on your computer. Your notes stay on this device.",
    );
    expect(aiTrustDetail({ kind: "local-runtime", name: "Ollama" })).toBe(
      "Your notes go to Ollama, a program running on this computer. They do not leave the device — but Ollama is not part of Myne, and Myne cannot see what it does with them.",
    );
  });

  it("the remote state says the notes LEAVE, and claims nothing for the provider (TB13/A17)", () => {
    // Bounded by TB13 + A17: retention, logging and onward routing are
    // unverifiable by Myne, so the copy states what is sent and to whom and
    // nothing about what the far side does with it.
    expect(aiTrustHeadline({ kind: "remote", provider: "OpenRouter" })).toBe(
      "Your notes are sent to OpenRouter, which Myne does not run.",
    );
    expect(aiTrustDetail({ kind: "remote", provider: "OpenRouter" })).toBe(
      "They leave this device. Myne cannot see or control what OpenRouter keeps, and if OpenRouter routes your request onward, Myne cannot see that either.",
    );
  });

  it("makes no absolute privacy claim in ANY state (A7/A13/A17 honesty)", () => {
    for (const state of STATES) {
      const combined =
        `${AI_TRUST_INVARIANT} ${aiTrustHeadline(state)} ${aiTrustDisclosure(state)}`.toLowerCase();
      // Over-claims explicitly banned by PRODUCT.md:41,80.
      expect(combined, state.kind).not.toContain("fully private");
      expect(combined, state.kind).not.toContain("completely secure");
      expect(combined, state.kind).not.toContain("never leaves");
      // …and it must positively acknowledge the on-device malware residual.
      expect(combined, state.kind).toContain("malware already running on your device");
      // …and it must NOT claim model-runtime isolation until the sidecar lands
      // (threat-model.md §7: the runtime is IN-PROCESS in v0.1).
      expect(combined, state.kind).not.toContain("sandbox");
      // NEW for the provider arm: Myne may state what it sends and to whom,
      // never what the far side retains (A17). No claim about the provider's
      // behaviour may appear in any state.
      expect(combined, state.kind).not.toContain("does not store");
      expect(combined, state.kind).not.toContain("does not keep");
      expect(combined, state.kind).not.toContain("private by default");
    }
  });

  it("the remote state does NOT reuse the on-device locality claim", () => {
    // The specific regression this whole edit exists to prevent: shipping
    // "runs entirely on your device" in front of a configured provider.
    const remote =
      `${aiTrustHeadline({ kind: "remote", provider: "X" })} ${aiTrustDisclosure({ kind: "remote", provider: "X" })}`.toLowerCase();
    expect(remote).not.toContain("entirely on your device");
    expect(remote).not.toContain("no network connection");
    expect(remote).toContain("leave this device");
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
