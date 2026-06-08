// Two-tier on-demand trigger for the unlinked-mentions section (MYND-196 task 2,
// SYNC-14 cost classification). The reducer is the decrypt-verify cost gate: the
// vault-change nonce must NEVER yield a "verify" effect — collapsed does zero
// work, open does the cheap candidate-recall only. Decrypt-verify is reachable
// exclusively from an explicit expand (first open) or refresh.

import { describe, expect, it } from "vitest";

import {
  initialMentionsState,
  reduceMentions,
  type MentionsAction,
} from "../../src/notes/unlinkedMentionsController";

describe("reduceMentions — collapsed tier (SYNC-14 condition 1)", () => {
  it("does NO work on a vault-change nonce while collapsed", () => {
    const { state, effect } = reduceMentions(initialMentionsState, {
      type: "nonce",
    });
    expect(effect).toBe("none");
    expect(state).toEqual(initialMentionsState); // untouched
  });

  it("collapse preserves computed results + a pending refresh signal", () => {
    let s = initialMentionsState;
    s = reduceMentions(s, { type: "expand" }).state;
    s = reduceMentions(s, { type: "verified", sig: "a" }).state;
    s = reduceMentions(s, { type: "candidate-sig", sig: "b" }).state; // refresh avail
    const { state, effect } = reduceMentions(s, { type: "collapse" });
    expect(effect).toBe("none");
    expect(state.expanded).toBe(false);
    expect(state.computedSig).toBe("a"); // cached, not discarded
    expect(state.refreshAvailable).toBe(true); // signal survives re-expand
  });
});

describe("reduceMentions — open tier (SYNC-14 condition 2)", () => {
  it("first expand (never computed) triggers the decrypt-verify", () => {
    const { state, effect } = reduceMentions(initialMentionsState, {
      type: "expand",
    });
    expect(effect).toBe("verify");
    expect(state.expanded).toBe(true);
  });

  it("re-expand after a prior compute shows cache — does NOT re-verify", () => {
    let s = reduceMentions(initialMentionsState, { type: "expand" }).state;
    s = reduceMentions(s, { type: "verified", sig: "a" }).state;
    s = reduceMentions(s, { type: "collapse" }).state;
    const { effect } = reduceMentions(s, { type: "expand" });
    expect(effect).toBe("none");
  });

  it("a nonce while open runs the CHEAP candidate-recall — never verify", () => {
    let s = reduceMentions(initialMentionsState, { type: "expand" }).state;
    s = reduceMentions(s, { type: "verified", sig: "a" }).state;
    const { effect } = reduceMentions(s, { type: "nonce" });
    expect(effect).toBe("cheap-recall");
  });

  it("a changed candidate set surfaces the refresh signal — but does NOT auto-verify", () => {
    let s = reduceMentions(initialMentionsState, { type: "expand" }).state;
    s = reduceMentions(s, { type: "verified", sig: "a" }).state;
    const { state, effect } = reduceMentions(s, {
      type: "candidate-sig",
      sig: "b",
    });
    expect(effect).toBe("none"); // signal only — the decrypt cost is gated
    expect(state.refreshAvailable).toBe(true);
  });

  it("an unchanged candidate set leaves the refresh signal off", () => {
    let s = reduceMentions(initialMentionsState, { type: "expand" }).state;
    s = reduceMentions(s, { type: "verified", sig: "a" }).state;
    const { state, effect } = reduceMentions(s, {
      type: "candidate-sig",
      sig: "a",
    });
    expect(effect).toBe("none");
    expect(state.refreshAvailable).toBe(false);
  });

  it("a cheap-recall landing before the first verify does NOT flag refresh", () => {
    // expand fired a verify; a candidate-sig arrives while computedSig is still
    // null (verify in flight) — must not produce a spurious refresh affordance.
    let s = reduceMentions(initialMentionsState, { type: "expand" }).state;
    const { state } = reduceMentions(s, { type: "candidate-sig", sig: "x" });
    expect(state.refreshAvailable).toBe(false);
  });
});

describe("reduceMentions — explicit refresh + verified settle", () => {
  it("refresh is an explicit decrypt-verify", () => {
    let s = reduceMentions(initialMentionsState, { type: "expand" }).state;
    s = reduceMentions(s, { type: "verified", sig: "a" }).state;
    s = reduceMentions(s, { type: "candidate-sig", sig: "b" }).state;
    const { effect } = reduceMentions(s, { type: "refresh" });
    expect(effect).toBe("verify");
  });

  it("refresh while collapsed is a no-op (cannot bypass the collapsed gate)", () => {
    const { effect } = reduceMentions(initialMentionsState, { type: "refresh" });
    expect(effect).toBe("none");
  });

  it("verified records the signature and clears the refresh signal", () => {
    let s = reduceMentions(initialMentionsState, { type: "expand" }).state;
    s = reduceMentions(s, { type: "verified", sig: "a" }).state;
    s = reduceMentions(s, { type: "candidate-sig", sig: "b" }).state;
    const { state } = reduceMentions(s, { type: "verified", sig: "b" });
    expect(state.computedSig).toBe("b");
    expect(state.refreshAvailable).toBe(false);
  });
});

describe("reduceMentions — the SYNC-14 invariant", () => {
  it("ONLY expand and refresh can ever emit a verify effect", () => {
    // Exhaustive sweep over every action against a representative open+computed
    // state: a nonce or a candidate-sig must never trigger the expensive path.
    const open = reduceMentions(
      reduceMentions(initialMentionsState, { type: "expand" }).state,
      { type: "verified", sig: "a" },
    ).state;
    const actions: MentionsAction[] = [
      { type: "nonce" },
      { type: "candidate-sig", sig: "z" },
      { type: "collapse" },
      { type: "verified", sig: "z" },
    ];
    for (const action of actions) {
      expect(reduceMentions(open, action).effect).not.toBe("verify");
    }
  });
});
