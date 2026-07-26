// @vitest-environment jsdom
//
// vim-keyboard-mode (MYND-313) — the chord conflict policy.
//
// The rule under test (design session Q4): Myne's application chords win, vim
// stays inside the editor. Concretely, on Ctrl-is-Mod platforms the overlapping
// bindings are removed from the VIM keymap so Myne's own dispatcher and the
// platform's copy/paste keep working — and on macOS nothing is touched at all,
// because `Mod` is Cmd there and the two grammars never collide.
//
// These are policy tests, driven through a recording stub rather than the real
// engine: `Vim.unmap` mutates a module-global `defaultKeymap` inside the package,
// so exercising it for real would leak across test files in the same process and
// make later suites depend on execution order.

import { beforeEach, describe, expect, it } from "vitest";
import {
  SURRENDERED_CHORDS,
  VISUAL_BLOCK_CHORD,
  applyChordPolicy,
  chordPolicyActive,
  resetChordPolicyForTests,
} from "../../editor/src/vim-chords";

function makeStub() {
  const unmapped: Array<{ lhs: string; ctx: string | undefined }> = [];
  const mapped: Array<{ lhs: string; rhs: string; ctx: string | undefined }> = [];
  return {
    unmapped,
    mapped,
    api: {
      Vim: {
        unmap: (lhs: string, ctx?: string) => {
          unmapped.push({ lhs, ctx });
          return true;
        },
        noremap: (lhs: string, rhs: string, ctx?: string) => {
          mapped.push({ lhs, rhs, ctx });
        },
      },
    },
  };
}

describe("vim chord policy (MYND-313)", () => {
  beforeEach(() => {
    resetChordPolicyForTests();
  });

  it("surrenders every conflicting chord on Ctrl-is-Mod platforms", () => {
    const stub = makeStub();
    applyChordPolicy(stub.api, /* mac */ false);

    const surrendered = new Set(stub.unmapped.map((u) => u.lhs));
    for (const { chord } of SURRENDERED_CHORDS) {
      expect(surrendered.has(chord)).toBe(true);
    }
  });

  it("keeps <C-[> with vim — it is Escape's only alternative", () => {
    const stub = makeStub();
    applyChordPolicy(stub.api, false);

    expect(stub.unmapped.map((u) => u.lhs)).not.toContain("<C-[>");
  });

  it("keeps <C-r> (redo on both sides) and <C-c> (engine already yields it)", () => {
    const stub = makeStub();
    applyChordPolicy(stub.api, false);

    const surrendered = stub.unmapped.map((u) => u.lhs);
    expect(surrendered).not.toContain("<C-r>");
    expect(surrendered).not.toContain("<C-c>");
  });

  it("rehomes visual-block, since <C-v> goes to paste", () => {
    const stub = makeStub();
    applyChordPolicy(stub.api, false);

    expect(stub.unmapped.map((u) => u.lhs)).toContain("<C-v>");
    expect(stub.mapped).toContainEqual({
      lhs: VISUAL_BLOCK_CHORD,
      rhs: "<C-v>",
      ctx: "normal",
    });
    expect(stub.mapped).toContainEqual({
      lhs: VISUAL_BLOCK_CHORD,
      rhs: "<C-v>",
      ctx: "visual",
    });
  });

  it("does nothing on macOS — Mod is Cmd, so there is no conflict to resolve", () => {
    const stub = makeStub();
    applyChordPolicy(stub.api, /* mac */ true);

    expect(stub.unmapped).toHaveLength(0);
    expect(stub.mapped).toHaveLength(0);
    expect(chordPolicyActive(true)).toBe(false);
    expect(chordPolicyActive(false)).toBe(true);
  });

  it("is idempotent — the engine's defaultKeymap is global and spliced in place", () => {
    // Re-running would keep splicing an already-spliced array, so a second
    // enable of vim must be a no-op.
    const stub = makeStub();
    applyChordPolicy(stub.api, false);
    const afterFirst = stub.unmapped.length;
    applyChordPolicy(stub.api, false);

    expect(stub.unmapped).toHaveLength(afterFirst);
  });

  it("surrenders each chord across every vim context, not just the default one", () => {
    // A binding can be declared per-context (`normal` / `insert` / `visual`) or
    // with none at all; missing one leaves the chord alive in that mode.
    const stub = makeStub();
    applyChordPolicy(stub.api, false);

    const contextsFor = (chord: string) =>
      new Set(stub.unmapped.filter((u) => u.lhs === chord).map((u) => u.ctx));

    expect(contextsFor("<C-a>")).toEqual(
      new Set([undefined, "normal", "insert", "visual"]),
    );
  });

  it("documents a reason for every surrendered chord", () => {
    // The list doubles as the source for the settings caveat copy, so an entry
    // without a reason would surface as a blank explanation to the user.
    for (const entry of SURRENDERED_CHORDS) {
      expect(entry.to.length).toBeGreaterThan(0);
    }
  });
});
