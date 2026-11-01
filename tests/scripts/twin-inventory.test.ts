// The twin inventory's own test (myne-md/myne#472 task 1).
//
// A guard nobody breaks is a guard nobody has tested, and this repo has shipped
// that shape more than once: a check that passed while the thing it checked was
// wrong, "verified" by the check passing afterwards. So what matters here is not
// that the script runs. It is that it FAILS, by name, on each defect it claims
// to catch.
//
// Every failure case runs against a THROWAWAY tree via `--roots`. An earlier
// version of `check-token-adoption.mjs` mutated `src/lib/theme.ts` on disk and
// restored it in `afterEach`; a crashed run left a production source file
// corrupted, and a parallel worker could read it mid-write.

import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  ROSTER,
  discover,
  normalize,
  seamAliases,
  stripComments,
} from "../../scripts/check-twin-inventory.mjs";

const ROOT = new URL("../../", import.meta.url).pathname;
const SCRIPT = `${ROOT}scripts/check-twin-inventory.mjs`;
const PROJECTION = `${ROOT}docs/dev/twin-inventory.md`;

function run(args: string[] = []): { code: number; out: string } {
  try {
    return {
      code: 0,
      out: execFileSync("node", [SCRIPT, ...args], { cwd: ROOT, encoding: "utf8" }),
    };
  } catch (e) {
    const err = e as { status: number; stdout: string; stderr: string };
    return { code: err.status, out: `${err.stdout}${err.stderr}` };
  }
}

let scratch: string | null = null;

afterEach(() => {
  if (scratch) rmSync(scratch, { recursive: true, force: true });
  scratch = null;
});

type Entry = { a: string; b: string; verdict: string; reason: string };

/**
 * A scratch pair of trees plus the roster to check them against.
 *
 * `files` maps a relative path to which side gets it: "both" makes a twin, "a"
 * or "b" makes a file with no counterpart. The roster is written as JSON beside
 * the desktop side, which is where `--roots` looks for it. It is an ARRAY,
 * because the unit is the pair and a desktop file may have two counterparts.
 */
function withTrees(
  files: Record<string, "both" | "a" | "b">,
  roster: Entry[],
): [string, string] {
  scratch = mkdtempSync(join(tmpdir(), "myne-twin-inventory-"));
  const a = join(scratch, "desk");
  const b = join(scratch, "mob");
  for (const [rel, side] of Object.entries(files)) {
    if (side === "both" || side === "a") {
      mkdirSync(join(a, rel, ".."), { recursive: true });
      writeFileSync(join(a, rel), "export const x = 1;\n");
    }
    if (side === "both" || side === "b") {
      mkdirSync(join(b, rel, ".."), { recursive: true });
      writeFileSync(join(b, rel), "export const x = 1;\n");
    }
  }
  mkdirSync(a, { recursive: true });
  writeFileSync(join(a, "roster.json"), JSON.stringify(roster, null, 2));
  return [a, b];
}

const entry = (a: string, b: string, verdict = "delegated"): Entry => ({
  a,
  b,
  verdict,
  reason: "scratch",
});

describe("check-twin-inventory", () => {
  // One spawn, shared. Several tests below assert on different substrings of
  // byte-identical output, and nothing between them can change it, so paying a
  // separate 88 ms sweep per assertion buys nothing. The tests that deliberately
  // run their own command (injection, projection) still do.
  const full = run();

  it("passes on the tree as recorded", () => {
    expect(full.out).toContain("twin-inventory: ok");
    expect(full.code).toBe(0);
  });

  it("classifies exactly the twins it discovers, both ways", () => {
    // The record is COMPLETE, which is the precondition myne#473 needs: a
    // ratchet over a partial roster counts a number that does not describe the
    // tree.
    //
    // An earlier version of this test asserted `not.toContain("awaiting
    // classification")`, and once the incremental-landing scaffold was removed
    // that string became unprintable, so the assertion passed by construction
    // and tested nothing. Asserting the SET EQUALITY instead cannot go vacuous:
    // it compares two things that both still exist.
    const key = (e: { a: string; b: string }) => `${e.a}::${e.b}`;
    const discovered = new Set(discover().map(key));
    const rostered = new Set(ROSTER.map(key));
    expect([...discovered].filter((k) => !rostered.has(k))).toEqual([]);
    expect([...rostered].filter((k) => !discovered.has(k))).toEqual([]);
  });

  it("fails on a roster entry whose pair is no longer a twin, even when both files exist", () => {
    // The hole the existence check left. An entry can stop being a twin without
    // either file disappearing: a path moves out from under the sweep, or a
    // curated entry is deleted while its roster row stays. The old check asked
    // "do both files exist", which is a proxy, and this case walked straight
    // past it while every published count stayed wrong.
    const [a, b] = withTrees({ "real.ts": "both", "lonely.ts": "a" }, []);
    writeFileSync(join(b, "elsewhere.ts"), "export const x = 1;\n");
    writeFileSync(
      join(a, "roster.json"),
      JSON.stringify(
        [
          entry(join(a, "real.ts"), join(b, "real.ts")),
          // Both files exist. The pair is not a twin: different relative paths,
          // and no curated entry declares it.
          entry(join(a, "lonely.ts"), join(b, "elsewhere.ts")),
        ],
        null,
        2,
      ),
    );
    const { code, out } = run(["--roots", a, b]);
    expect(code).toBe(1);
    expect(out).toContain("no longer a twin");
    expect(out).toContain("both files exist but the pair is not discovered");
  });

  it("discovers the path sweep's twins plus the curated ones", () => {
    // 98 from the same-relative-path sweep, and 6 curated pairs the sweep cannot
    // see because their sides sit at different paths. A record fixed at the
    // sweep's number alone would omit this epic's own motivating case.
    //
    // The sweep's half was 90 when this epic was measured and is 98 now: the
    // six platform-seam files (myne-md/myne#492 gave `mobile/src` its own seam
    // directory) plus `navigation.rs` (myne-md/myne#453) and
    // `useHeadFingerprintCompare.ts` (myne-md/myne#462) entered the set while
    // this branch was open. That is the guard's stated purpose working: a twin
    // ENTERING the set fails rather than passing unnoticed, and each of the
    // eight cost a verdict and a reason before this number could move.
    //
    // The curated half went 6 to 8 with myne-md/myne#410's two cover pairs,
    // which is the OTHER half working: both sit at different paths on the two
    // sides, so the sweep cannot see either, and the guard was green and blind
    // to them until they were rostered by hand.
    //
    // Then 106 to 105: myne-md/myne#390 deleted `mobile/src/platform/
    // clipboardManager.ts`, a seam module re-exporting a package the same change
    // removed, and the STALE direction is what said so. A verdict that outlives
    // its files describes nothing and inflates every count published here.
    //
    // Then 105 to 104: myne-md/myne#520's review moved the cover-signal event
    // names and detail types into `@myne/editor/cover-signal` and deleted both
    // clients' copies, which is the destination the entry itself named. A twin
    // that stops being a twin because the duplication was resolved leaves the
    // roster the same way a deleted file does.
    //
    // Then 104 to 107, in myne-md/myne#456, and it is worth reading as two
    // moves that happen to net out plus one that does not.
    //
    // THREE LEFT THE SWEEP AND CAME BACK CURATED. `engine.rs`, `error.rs` and
    // `state.rs` moved out of `src-tauri/src/plugins/local_inference/` into
    // `core/src/inference/`, so their desktop side is no longer under a sweep
    // root and the STALE direction named all three by path. Mobile still holds
    // its own copy of each, so the duplication is not resolved and dropping the
    // pairs would have shrunk the denominator at the exact moment the shared
    // side landed, which reads as progress and is the opposite. They are in
    // `CURATED_TWINS` now, cross-path, the way every other pair the sweep
    // cannot see already is. Net zero.
    //
    // THREE ENTERED. `src-tauri/src/plugins/agent/{mod,commands,adapters}.rs`
    // gained mobile counterparts, because the same change ships the agent on
    // the phone. That is the guard's stated purpose working once more: each of
    // the three failed as unclassified and cost a verdict and a reason before
    // this number could move, and all three came out `absent` after measuring
    // rather than assuming, since what is left in each file after the shared
    // half went to `myne-core` is per-client host wiring.
    //
    // Then 107 to 108, in the same issue one task later: `src/lib/agent-run.ts`
    // gained a mobile counterpart. Both are `delegated` shells around a shared
    // `agent-run-core.ts`, and the pair is recorded rather than waved through
    // as trivial precisely because it is the place a client could quietly stop
    // delegating and start retyping a command name.
    //
    // Then 108 to 109 when this branch met myne-md/myne#622 at a merge:
    // `core/src/plugins/agent/history.rs` arrived from develop while the agent
    // command surface had already moved into `myne-core` here, so the pair the
    // sweep sees is new to the merged tree rather than to either branch.
    //
    // Then 134 to 133: the device-admission ceremony's pair of client bindings
    // went with the surface (myne-md/myne#956), so the sweep discovers one pair
    // fewer. This number tracks what is left to classify, which is why it comes
    // back down without ceremony when work leaves the tree.
    //
    // Then 133 to 135, and this one was shipped RED rather than argued: the
    // approval-wait fix added `src/lib/pending-approval.ts` and
    // `src/hooks/useIdleAutoLock.ts` with their mobile counterparts, the guard's
    // projection was regenerated, and these literals were not moved with it, so
    // the suite failed on a number nobody re-measured. Both new pairs are
    // `decision` verdicts in the roster and both files exist on both sides;
    // the count is right and the comment is the part that was missing.
    expect(full.out).toContain("135 twin(s) discovered");
    // Then 104 to 105: myne-md/myne#177 rostered `src/notes/dailyNote.ts`
    // against `mobile/src/lib/daily.ts`, the period resolver hand-mirrored at
    // two different paths. The curated half again, and again the half that was
    // green and blind: six doc comments across the two files claimed they
    // mirrored each other exactly and nothing measured it.
    expect(full.out).toContain("135 twin(s) discovered");
    //
    // Then 109 to 110 when the two met at a merge: neither branch could see
    // the other's pair, and both are real.
    // Then 104 to 106: myne-md/myne#613 added two CROSS-PATH pairs, the two
    // `folderBackfill.ts` back-fills and `src/notes/moveNote.ts` against
    // `mobile/src/lib/note-organize.ts`. Neither is findable by the path sweep,
    // and the second is where the review found mobile issuing one prefs write
    // per note in a folder rename while desktop batched: an unrostered pair is
    // how that stayed green.
    expect(full.out).toContain("135 twin(s) discovered");
    //
    // Then to 112 when the two met at a merge: neither branch could see the
    // other's pairs, and all of them are real.
    //
    // Then 112 to 114: myne-md/myne#675 adds the chats pair twice over, once
    // per tree: the Rust host-registration shim
    // (`src-tauri/src/plugins/chats/mod.rs` against its mobile twin,
    // `delegated` like every other `pub use myne_core` shim) and the TS
    // bindings twin (`src/lib/chats.ts` against `mobile/src/lib/chats.ts`,
    // same six commands plus the error-kind unions, byte-identical in shape).
    // Two entries, one decision, both verdicts recorded at entry time rather
    // than discovered later by the drift ratchet.
    //
    // Then 114 to 116: myne-md/myne#684 adds the account pair the same way,
    // once per tree: the Rust host-registration shim
    // (`src-tauri/src/plugins/account/mod.rs` against its mobile twin) and the
    // TS bindings twin (`src/lib/account.ts` against `mobile/src/lib/account.ts`).
    //
    // Then 116 to 120: myne-md/myne#697 adds the memory surface pair twice
    // over, at two different paths the sweep cannot pair (the path-sweep half
    // of the roster cannot see them, so without the curated entries the guard
    // would have printed ok over two unrostered surfaces): the management
    // surface (`src/components/settings/MemorySection.tsx` against
    // `mobile/src/app/flows/MemorySection.tsx`) and the in-chat surface
    // (`src/notes/components/MemoryPopover.tsx` against
    // `mobile/src/app/flows/MemorySheet.tsx`). Both `screen`: same surface,
    // per-client container by design, recorded with reasons at entry time.
    //
    // Then 120 to 121: myne-md/myne#768 adds the person-account bindings twin
    // (`src/lib/personAccount.ts` against `mobile/src/lib/personAccount.ts`),
    // recorded `decision` at entry time. A same-path pair the sweep DOES find,
    // so it is the roster entry rather than a curated one that classifies it.
    //
    // Then 122 to 124: myne-md/myne#851 adds the member-names pair twice over,
    // in the shape #675 and #684 established, both `delegated` at entry time:
    // the Rust host-registration shim (`src-tauri/src/plugins/member_names/mod.rs`
    // against its mobile twin) and the TS bindings twin (`src/lib/memberNames.ts`
    // against `mobile/src/lib/memberNames.ts`). The second is the pair the drift
    // ratchet records as SEMANTICALLY different, and that is the honest reading
    // rather than a regression: the wire-shape mirror and the refusal-to-copy
    // mapper both moved into `@myne/client-core` in the same change, so what
    // remains per-client is the `invoke` wrapper and what differs is two wrapped
    // commands against one.
    //
    // Then 124 to 125: the `member-devices` feature adds the device-binding pair,
    // the Rust host-registration shim
    // (`src-tauri/src/plugins/device_binding/mod.rs` against its mobile twin),
    // `delegated` like every other `pub use myne_core` shim. It is the one pair in
    // this list that arrived with its SECOND side missing: `myne-core` already
    // held the whole family and desktop registered it while the phone registered
    // nothing, so the pair could not enter the roster until the mobile half was
    // written. Byte-different and semantically identical, since the two files
    // differ in one doc paragraph and in nothing the comparison counts, which is
    // why this number moves and the drift ratchet's does not.
    //
    // Then 125 to 129: myne-md/myne#849 (the mobile presence surface) adds FOUR
    // pairs, and the shape splits two and two. Two are the by-now familiar
    // `pub use myne_core` shim plus TS bindings twin, both `delegated` at entry
    // time: the live-session plugin shim
    // (`src-tauri/src/plugins/live/mod.rs` against its mobile twin) and the five
    // command wrappers (`src/lib/live.ts` against `mobile/src/lib/live.ts`). The
    // shim pair is the one this list has now seen three times and is worth
    // stating again: `mobile/src-tauri/src/lib.rs` already MANAGED the
    // `LiveSessionRegistry` and spawned the awareness supervisor while the plugin
    // was registered nowhere, so the whole subsystem was wired and inert.
    //
    // The other two are not that shape, and each is a different kind of entry.
    // `src/lib/identity.ts` against `mobile/src/lib/identity.ts` is a bindings
    // twin whose desktop side had existed since `collab-provenance` task 2 and
    // whose mobile side did not exist at all: the shared label rule had nothing
    // to call on the phone, so every presence row there rendered the degraded
    // device form with every gate green. And
    // `src/platform/capabilities.ts` against
    // `mobile/src/platform/capabilities.ts` is the roster's first pair whose
    // verdict is `decision` BECAUSE the two differ: a capability descriptor
    // answers "does THIS client provide X", so converging them would be the
    // defect. It is in this list only because the mobile side is new; what the
    // same change moved is the VOCABULARY (`Capability` and the keyed
    // `CAPABILITY_KEYS` record) into `@myne/client-core`, which is what let the
    // phone answer the closed list at all.
    expect(full.out).toContain("135 twin(s) discovered");
  });

  it("keeps both counterparts when one desktop file has two", () => {
    // `src/App.tsx` has a same-path twin in `mobile/src/App.tsx` (the viewport
    // wrapper) AND a behavioural counterpart in `mobile/src/app/AppShell.tsx`.
    // Deduping on the desktop path would drop one, and the one it drops is the
    // corrected pairing. Proven here in isolation so the property does not rest
    // on a count that other work can move.
    const [a, b] = withTrees({ "App.tsx": "both", "other/Shell.tsx": "b" }, []);
    writeFileSync(
      join(a, "curated.json"),
      JSON.stringify(
        [{ a: join(a, "App.tsx"), b: join(b, "other/Shell.tsx"), why: "scratch" }],
        null,
        2,
      ),
    );
    // Both pairs classified, so the run reaches its summary line rather than
    // stopping at the missing-verdict failure.
    writeFileSync(
      join(a, "roster.json"),
      JSON.stringify(
        [
          entry(join(a, "App.tsx"), join(b, "App.tsx")),
          entry(join(a, "App.tsx"), join(b, "other/Shell.tsx")),
        ],
        null,
        2,
      ),
    );
    const { code, out } = run(["--roots", a, b]);
    expect(code).toBe(0);
    expect(out).toContain("2 twin(s) discovered");
  });

  it("does not record a curated pair twice when the sweep already found it", () => {
    const [a, b] = withTrees({ "same.ts": "both" }, []);
    writeFileSync(
      join(a, "curated.json"),
      JSON.stringify(
        [{ a: join(a, "same.ts"), b: join(b, "same.ts"), why: "scratch" }],
        null,
        2,
      ),
    );
    writeFileSync(
      join(a, "roster.json"),
      JSON.stringify([entry(join(a, "same.ts"), join(b, "same.ts"))], null, 2),
    );
    const { code, out } = run(["--roots", a, b]);
    expect(code).toBe(0);
    expect(out).toContain("1 twin(s) discovered");
  });

  it("fails, by name, on a curated pair whose file is gone", () => {
    // A curated pair is hand-asserted, so a missing side means somebody moved a
    // file this list says answers a shared product question. Silently dropping
    // it would shrink the denominator without an argument, which is exactly the
    // shape this record exists to prevent.
    const [a, b] = withTrees({ "present.ts": "both" }, []);
    writeFileSync(
      join(a, "curated.json"),
      JSON.stringify(
        [{ a: join(a, "present.ts"), b: join(b, "moved-away.ts"), why: "scratch" }],
        null,
        2,
      ),
    );
    const { code, out } = run(["--roots", a, b]);
    expect(code).toBe(1);
    expect(out).toContain("curated pair(s) name a file that no longer exists");
    expect(out).toContain("moved-away.ts");
  });

  // ── direction 1: a twin with no verdict ────────────────────────────────────

  it("fails, by name, on a twin that has no roster entry", () => {
    const [a, b] = withTrees({ "shared.ts": "both" }, []);
    const { code, out } = run(["--roots", a, b]);
    expect(code).toBe(1);
    expect(out).toContain("have no verdict");
    expect(out).toContain("shared.ts");
  });

  it("says WHY a missing verdict matters, not just that one is missing", () => {
    // The message has to teach. A refusal that does not say what the next
    // person should do gets silenced rather than fixed.
    const [a, b] = withTrees({ "shared.ts": "both" }, []);
    const { out } = run(["--roots", a, b]);
    expect(out).toContain("seven inconsistent ones");
  });

  // ── direction 2: a verdict with no twin ────────────────────────────────────

  it("fails, by name, on an entry whose desktop file is gone", () => {
    const [a, b] = withTrees({ "kept.ts": "both" }, []);
    // Written after the trees exist, so the paths are real. One entry names a
    // file that is not.
    writeFileSync(
      join(a, "roster.json"),
      JSON.stringify(
        [
          entry(join(a, "kept.ts"), join(b, "kept.ts")),
          entry(join(a, "vanished.ts"), join(b, "vanished.ts")),
        ],
        null,
        2,
      ),
    );
    const { code, out } = run(["--roots", a, b]);
    expect(code).toBe(1);
    expect(out).toContain("no longer exists");
    expect(out).toContain("vanished.ts");
  });

  it("fails when only the MOBILE side of an entry is gone", () => {
    // The asymmetric case. A pair whose desktop file survives still reads as
    // present to anything that only checks one side, which is how a roster goes
    // on describing a twin that stopped being one.
    // `other.ts` exists on both sides purely so the mobile root exists at all.
    // Without it the walk reports a broken checkout and exits before the stale
    // check, which is correct behaviour and the wrong thing to be testing here.
    const [a, b] = withTrees({ "other.ts": "both", "half.ts": "a" }, []);
    writeFileSync(
      join(a, "roster.json"),
      JSON.stringify(
        [
          entry(join(a, "other.ts"), join(b, "other.ts")),
          entry(join(a, "half.ts"), join(b, "half.ts")),
        ],
        null,
        2,
      ),
    );
    const { code, out } = run(["--roots", a, b]);
    expect(code).toBe(1);
    expect(out).toContain("no longer exists");
    expect(out).toContain("half.ts");
  });

  // ── a file on one side only is not a twin ──────────────────────────────────

  it("does not invent a twin from a file that exists on one side only", () => {
    const [a, b] = withTrees({ "desktop-only.ts": "a", "mobile-only.ts": "b" }, []);
    const { code, out } = run(["--roots", a, b]);
    expect(code).toBe(0);
    expect(out).toContain("0 twin(s) discovered");
  });

  // ── the vocabulary is closed ───────────────────────────────────────────────

  it("fails on a verdict outside the four", () => {
    const [a, b] = withTrees({ "shared.ts": "both" }, []);
    writeFileSync(
      join(a, "roster.json"),
      JSON.stringify(
        [entry(join(a, "shared.ts"), join(b, "shared.ts"), "narrowed")],
        null,
        2,
      ),
    );
    const { code, out } = run(["--roots", a, b]);
    expect(code).toBe(1);
    expect(out).toContain("outside the vocabulary");
    expect(out).toContain("narrowed");
  });

  it("has a verdict for every discovered twin, both trees", () => {
    // Asserted rather than eyeballed from the summary, because "no missing
    // verdicts" is exactly the kind of thing that reads true in a count and is
    // false for one file.
    expect(full.code).toBe(0);
    expect(full.out).not.toContain("have no verdict");
    // 125 to 132: SIX pairs myne-md/myne#849 adds (the count also carries develop's
    // +1, `src/hooks/useMemberVault.ts`, which landed while this branch was open).
    // Four of the six are same-path pairs the
    // sweep finds (the live plugin shim, the live transport, the identity binding,
    // the capability descriptor, explained at the count assertion above), and TWO are
    // cross-path pairs the sweep CANNOT see, which is the review round's finding
    // rather than the feature's original state: the desktop presence roster
    // (`WhoIsHereTab.tsx`) against the mobile sheet (`PresenceSheet.tsx`), and the two
    // policy shims (`src/notes/liveNote.ts` against `mobile/src/lib/liveNote.ts`).
    // Task 11's own What-to-build named both, and the first pass classified only what
    // the sweep could see. They are in `CURATED_TWINS` now, which is where a pair at
    // two different paths belongs. Kept as a second number on purpose rather than
    // derived, because this one is what fails when an entry is added to the TREE
    // without one being added here.
    //
    // 132 to 133: the device-key rungs (myne-md/myne#938 tasks 9 and 10) put the same
    // dispatch file in two hosts. The sweep cannot see the pair: the two files share a
    // path only below different crate roots, which is why it is rostered rather than
    // converged. The ceremony-binding pair that raised this to 134 went with the
    // surface (myne-md/myne#956), and the count comes back down with it: a ratchet on
    // the roster is a count of what is left to decide, so it is allowed to shrink.
    //
    // 133 to 135: the approval-wait fix (`src/lib/pending-approval.ts`,
    // `src/hooks/useIdleAutoLock.ts` and their mobile counterparts). This literal
    // was left at 133 while the roster and the projection both moved, which is
    // the one direction this pair exists to make loud: a verdict added to the
    // tree without the roster noticing.
    expect(ROSTER.length).toBe(135);
  });

  it("keeps `screen` narrow", () => {
    // A count, and it is the weaker half of this pair on purpose: it catches the
    // verdict spreading, which is the failure the definition warns about.
    //
    // Raised from 11 to 12 by myne-md/myne#788, the plain-file editor: its
    // `src/platform/plainFile.ts` is a seam module on the desktop side with a
    // refusing mobile mirror, which is the same `screen` shape (#492) rather
    // than a shared decision with a drifted twin.
    //
    // Raised from 6 to 11 when the platform seam entered the set. That is five
    // entries at once, which is exactly the spread this ceiling watches for, so
    // the reason has to hold: they are ONE decision (myne-md/myne#492) that
    // produced six files, five of them `screen` and one `decision`, not five
    // independent judgement calls. The enumeration below is what actually holds
    // the line; this number only notices growth nobody argued for.
    const screens = ROSTER.filter((e) => e.verdict === "screen");
    expect(screens.length).toBeLessThanOrEqual(13);
  });

  it("holds `screen` to its definition, not to its count", () => {
    // The half the count cannot do. An earlier version shipped only the count,
    // passing at five entries of which three were miscategorised: the verdict
    // read "render, layout and navigation shape only" while `src/main.tsx`,
    // `src/vite-env.d.ts` and `src-tauri/src/main.rs` are none of those. A
    // number cannot notice that, so the definition was widened to its real two
    // clauses (the surface, or the host) and this asserts the membership rather
    // than the size.
    //
    // Enumerated rather than pattern-matched. A regex over paths would be a
    // second rule that can drift from the first; a list of four cannot, and
    // adding a fifth entry should cost a reviewer's argument. The fifth is
    // myne-md/myne#849's: the desktop live-presence roster, whose mobile side is a
    // bottom sheet rather than a right-panel tab, so the container is the
    // per-client half while the store and the label rule are shared. The
    // reviewer's argument is in the roster entry itself and in
    // `CURATED_TWINS`.
    const screens = ROSTER.filter((e) => e.verdict === "screen").map((e) => e.a);
    expect(screens.sort()).toEqual([
      "src-tauri/src/main.rs", // host: binary entry point
      "src/App.tsx", // surface: the shell each client renders
      "src/components/settings/MemorySection.tsx", // surface: the memory management panel
      "src/main.tsx", // host: boot side-effect composition
      "src/notes/components/MemoryPopover.tsx", // surface: the in-chat memory roster
      "src/notes/components/WhoIsHereTab.tsx", // surface: the presence roster (#849)
      "src/platform/core.ts", // host: the IPC entry point
      "src/platform/deepLink.ts", // host: deep-link registration
      "src/platform/event.ts", // host: backend-to-UI push
      "src/platform/path.ts", // host: path arithmetic over the host's filesystem
      "src/platform/plainFile.ts", // seam (#788): desktop binding, mobile mirror refuses
      "src/platform/window.ts", // host: host-window lifecycle
      "src/vite-env.d.ts", // host: build-time ambient globals
    ]);
  });

  it("records a destination on every decision entry", () => {
    // A decision with no destination is the field doing nothing. `undecided` is
    // an answer; absent is not.
    const withoutDestination = ROSTER.filter(
      (e) => e.verdict === "decision" && !e.destination,
    );
    expect(withoutDestination.map((e) => e.a)).toEqual([]);
  });

  it("gives every entry a reason", () => {
    // The record's whole value is that the next reader does not re-derive the
    // verdict, so an entry without a reason is a verdict pretending to be one.
    //
    // A minimum LENGTH was tried first and dropped. It flagged the six
    // byte-identical `src/dialect/` shims, whose reason is "Re-export shim,
    // byte-identical." That is a complete explanation of a two-line file, and a
    // threshold that rejects it teaches people to pad rather than to explain,
    // which is worse than not checking. Non-empty is the honest assertion; the
    // quality of a reason is a review question, not a regex one.
    const missing = ROSTER.filter((e) => !(e.reason ?? "").trim());
    expect(missing.map((e) => e.a)).toEqual([]);
  });

  // ── the byte flag and the semantic one ─────────────────────────────────────

  it("reports both difference counts, not one", () => {
    expect(full.out).toContain("byte-different");
    expect(full.out).toContain("semantically different");
    expect(full.out).toContain("differing only in comments or the seam import");
  });

  it("computes the three difference counts correctly, on known answers", () => {
    // The test above asserts the LABELS are present and nothing asserts the
    // NUMBERS, which is how the published counts came to be unverified: with
    // `semanticDiff` replaced by `!byteEqual` and `cosmeticOnly` hardcoded to 0,
    // every other test in this file still passed. myne-md/myne#473 is meant to
    // ratchet on these, and `--check` against the checked-in projection no
    // longer covers them either, because they were moved out of the byte-gated
    // document precisely so an unrelated comment edit stops reddening it.
    //
    // So: a scratch tree whose answer is known by construction, one pair per
    // way a pair can land, asserting the exact summary line.
    const dir = mkdtempSync(join(tmpdir(), "myne-twin-counts-"));
    scratch = dir;
    const a = join(dir, "desk");
    const b = join(dir, "mob");
    const write = (root: string, rel: string, text: string) => {
      mkdirSync(join(root, rel, ".."), { recursive: true });
      writeFileSync(join(root, rel), text);
    };

    // 1. byte-identical: not byte-different, not semantic, not cosmetic.
    write(a, "same.ts", "export const x = 1;\n");
    write(b, "same.ts", "export const x = 1;\n");

    // 2. comment-only: byte-different, cosmetic.
    write(a, "comment.ts", "// desktop says this\nexport const x = 1;\n");
    write(b, "comment.ts", "// mobile says something else\nexport const x = 1;\n");

    // 3. blank-line and indentation only: byte-different, cosmetic. This is the
    //    clause that carries thirteen of the real roster's fifteen and that no
    //    published statement of the rule mentioned until it was measured.
    write(a, "blank.ts", "export const x = 1;\n\n\n  export const y = 2;\n");
    write(b, "blank.ts", "export const x = 1;\nexport const y = 2;\n");

    // 4. seam import only: byte-different, cosmetic. Needs a real `platform/`
    //    directory, because `seamAliases` derives the map from one at runtime
    //    and returns an EMPTY map without it, so every scratch tree before this
    //    left the seam arm of the comparison unexercised end to end.
    write(a, "platform/core.ts", 'export { invoke } from "@tauri-apps/api/core";\n');
    write(a, "uses-seam.ts", 'import { invoke } from "./platform/core";\nexport const x = 1;\n');
    write(b, "uses-seam.ts", 'import { invoke } from "../platform/core";\nexport const x = 1;\n');

    // 5. genuinely different: byte-different AND semantic, not cosmetic.
    write(a, "real.ts", "export const x = 1;\n");
    write(b, "real.ts", "export const x = 2;\n");

    const roster = ["same.ts", "comment.ts", "blank.ts", "uses-seam.ts", "real.ts"].map((rel) => ({
      a: join(a, rel),
      b: join(b, rel),
      verdict: "decision",
      destination: "undecided",
      reason: "scratch",
    }));
    writeFileSync(join(a, "roster.json"), JSON.stringify(roster, null, 2));

    const { code, out } = run(["--roots", a, b]);
    expect(code).toBe(0);
    // 4 byte-different (everything but `same.ts`), 1 semantic (`real.ts`),
    // 3 cosmetic (comment, blank, seam).
    expect(out).toContain("4 byte-different, 1 semantically different, 3 differing only in");
  });

  it("counts a seam-only difference as cosmetic only when the seam map is real", () => {
    // The companion to the case above, and the reason it is separate: if
    // `seamAliases` silently returned an empty map, case 4 would fall into the
    // semantic bucket and the assertion above would fail with an off-by-one
    // that reads like a counting bug rather than a missing seam. Dropping the
    // `platform/` directory is what makes that concrete.
    const dir = mkdtempSync(join(tmpdir(), "myne-twin-seam-"));
    scratch = dir;
    const a = join(dir, "desk");
    const b = join(dir, "mob");
    const write = (root: string, rel: string, text: string) => {
      mkdirSync(join(root, rel, ".."), { recursive: true });
      writeFileSync(join(root, rel), text);
    };
    write(a, "uses-seam.ts", 'import { invoke } from "./platform/core";\nexport const x = 1;\n');
    write(b, "uses-seam.ts", 'import { invoke } from "../platform/core";\nexport const x = 1;\n');
    writeFileSync(
      join(a, "roster.json"),
      JSON.stringify(
        [
          {
            a: join(a, "uses-seam.ts"),
            b: join(b, "uses-seam.ts"),
            verdict: "decision",
            destination: "undecided",
            reason: "scratch",
          },
        ],
        null,
        2,
      ),
    );

    const { out } = run(["--roots", a, b]);
    // No `platform/` directory, so no alias map, so the differing specifier is
    // a real difference.
    expect(out).toContain("1 byte-different, 1 semantically different, 0 differing only in");
  });

  // ── the prose projection ───────────────────────────────────────────────────

  // These four run against a THROWAWAY tree, like every other failure case in
  // this file and for the reason its header gives. An earlier version pointed
  // them at the repository's tracked `docs/dev/twin-inventory.md`: one emitted
  // into it twice with no restore at all, three restored in `finally`, which
  // narrows the window without closing it. Both halves of the guard now accept
  // an injected target under `--roots`, so there is no reason left to touch the
  // real document.

  /** A scratch tree with one classified twin, plus its emitted projection path. */
  function scratchProjection(): { args: string[]; target: string } {
    const [a, b] = withTrees({ "shared.ts": "both" }, []);
    writeFileSync(
      join(a, "roster.json"),
      JSON.stringify([entry(join(a, "shared.ts"), join(b, "shared.ts"))], null, 2),
    );
    return { args: ["--roots", a, b], target: join(a, "projection.md") };
  }

  it("regenerates the projection deterministically", () => {
    // Two consecutive emits must be byte-identical, or "hand-edited then
    // restored" is a hope rather than a check. Nothing in the output may depend
    // on when it ran.
    const { args, target } = scratchProjection();
    run([...args, "--emit"]);
    const first = readFileSync(target, "utf8");
    run([...args, "--emit"]);
    expect(readFileSync(target, "utf8")).toBe(first);
  });

  it("undoes a hand edit on the next emit", () => {
    // The document is a projection, never a second source. This is what makes
    // that claim testable rather than a comment.
    //
    // On a scratch tree, so the literal string `HAND EDIT` never reaches a
    // tracked document even if an expectation below fails.
    const { args, target } = scratchProjection();
    run([...args, "--emit"]);
    const before = readFileSync(target, "utf8");
    writeFileSync(target, before + "\nHAND EDIT\n");
    run([...args, "--emit"]);
    const after = readFileSync(target, "utf8");
    expect(after).not.toContain("HAND EDIT");
    expect(after).toBe(before);
  });

  it("emits even when the gate is failing", () => {
    // The order that makes the test above safe. `--emit` used to run AFTER the
    // missing-verdict exit, so a guard red for any unrelated reason (the
    // ordinary mid-work state) regenerated nothing and left a hand edit
    // standing.
    //
    // Asserted on the FILE, not on the exit code or a message: the weaker
    // reading would pass for a run that failed the gate without ever reaching
    // the emit. Under --roots the emit lands in the throwaway tree, so this
    // never touches the repository's document.
    const [a, b] = withTrees({ "shared.ts": "both" }, []);
    const target = join(a, "projection.md");
    const { code, out } = run(["--roots", a, b, "--emit"]);
    expect(code).toBe(1);
    expect(out).toContain("have no verdict");
    expect(existsSync(target)).toBe(true);
    expect(readFileSync(target, "utf8")).toContain("# Twin inventory");
  });

  it("carries the rubric, not only the table", () => {
    // The deliverable includes a rubric two people must reach the same answer
    // with. A table of verdicts without it is a list nobody can check.
    // The tracked document, read only. Nothing here writes.
    const doc = readFileSync(PROJECTION, "utf8");
    expect(doc).toContain("GENERATED by scripts/check-twin-inventory.mjs --emit");
    expect(doc).toContain("The four verdicts");
    expect(doc).toContain("How to tell them apart");
    expect(doc).toContain("Two difference fields");
    expect(doc).toContain("A pair enters the curated list when");
  });

  it("does not emit unless asked", () => {
    // CI never passes --emit, so the check half has to run either way. If a bare
    // run wrote the file, a docs-only diff would appear on every CI job.
    //
    // The restore is in `finally`. An earlier version restored after the
    // assertions, so a failing expectation left the repository's tracked
    // document holding the word "sentinel", which is the exact
    // `check-token-adoption` incident this file's header cites, reproduced by
    // the test written to avoid it.
    const { args, target } = scratchProjection();
    run([...args, "--emit"]);
    writeFileSync(target, "sentinel\n");
    const { code } = run(args);
    expect(code).toBe(0);
    expect(readFileSync(target, "utf8")).toBe("sentinel\n");
  });

  it("--check fails when the projection is stale, and passes when it is fresh", () => {
    // Without this the "Do not edit by hand" banner had no mechanism behind it:
    // a hand edit to the projection is a docs-only commit, which pnpm-build's
    // code-paths filter skips, so CI never looked. decisions-index.mjs guards
    // its generated index the same way.
    const { args, target } = scratchProjection();
    run([...args, "--emit"]);
    const before = readFileSync(target, "utf8");
    expect(run([...args, "--check"]).code).toBe(0);
    writeFileSync(target, before + "\nHAND EDIT\n");
    const { code, out } = run([...args, "--check"]);
    expect(code).toBe(1);
    expect(out).toContain("is not what --emit would write");
    expect(out).toContain("--emit");
  });

  // ── the interaction: no check may silence another ──────────────────────────
  //
  // This guard ships four failing checks that landed across three tasks. Proving
  // each one in isolation is necessary and not sufficient: the failure this repo
  // has actually shipped is a guard whose later edit closed one blind spot and
  // opened another one line away, green throughout (myne#411). A NEW guard's
  // analogue is that adding check N must not stop check N-1 firing.
  //
  // So each defect is injected ALONE and again with the other three present, and
  // every message must appear in both.

  const DEFECTS = {
    missing: "have no verdict",
    // "no longer exists" alone is a SUBSTRING of the curated message
    // ("curated pair(s) name a file that no longer exists"), so the interaction
    // rows passed with the orphaned block deleted outright: the marker was
    // being satisfied by a different check's output. Anchored on the phrase
    // only the orphaned block emits.
    stale: "describe a pair that is no longer a twin",
    curated: "curated pair(s) name a file that no longer exists",
    verdict: "outside the vocabulary",
    // Untested until myne-md/myne#472's review, and its own comment called that
    // out ("Latent today; it costs one comparison to keep it that way"). It
    // fired incidentally inside this matrix, because the `verdict` defect
    // happens to push a second entry with the same pair key, so deleting the
    // check was green.
    duplicate: "duplicate roster entr(ies)",
  } as const;

  /** A scratch tree carrying exactly the named defects. */
  function withDefects(names: (keyof typeof DEFECTS)[]): { code: number; out: string } {
    const [a, b] = withTrees({ "kept.ts": "both", "extra.ts": "both" }, []);
    const roster: Entry[] = [entry(join(a, "kept.ts"), join(b, "kept.ts"))];
    const curated: { a: string; b: string; why: string }[] = [];

    // `extra.ts` is a real twin; leaving it out of the roster is the missing case.
    if (!names.includes("missing")) {
      roster.push(entry(join(a, "extra.ts"), join(b, "extra.ts")));
    }
    if (names.includes("stale")) {
      roster.push(entry(join(a, "ghost.ts"), join(b, "ghost.ts")));
    }
    if (names.includes("curated")) {
      curated.push({ a: join(a, "kept.ts"), b: join(b, "absent.ts"), why: "scratch" });
    }
    if (names.includes("verdict")) {
      roster.push(entry(join(a, "kept.ts"), join(b, "kept.ts"), "narrowed"));
    }
    // A second entry for a pair that already has one, with a VALID verdict, so
    // this case cannot be satisfied by the `verdict` defect's side effect.
    if (names.includes("duplicate") && !names.includes("verdict")) {
      roster.push(entry(join(a, "kept.ts"), join(b, "kept.ts")));
    }
    writeFileSync(join(a, "roster.json"), JSON.stringify(roster, null, 2));
    writeFileSync(join(a, "curated.json"), JSON.stringify(curated, null, 2));
    return run(["--roots", a, b]);
  }

  const ALL = Object.keys(DEFECTS) as (keyof typeof DEFECTS)[];

  // Built once. Five assertions ran it five times with byte-identical input,
  // each rebuilding and deleting its own scratch tree.
  let allFour: { code: number; out: string } | null = null;
  const withAllDefects = () => (allFour ??= withDefects(ALL));

  for (const name of ALL) {
    it(`fires on \`${name}\` alone`, () => {
      const { code, out } = withDefects([name]);
      expect(code).toBe(1);
      expect(out).toContain(DEFECTS[name]);
    });

    it(`still fires on \`${name}\` when every other defect is also present`, () => {
      const { code, out } = withAllDefects();
      expect(code).toBe(1);
      expect(out).toContain(DEFECTS[name]);
    });
  }

  it("names every defect at once rather than stopping at the first", () => {
    // A guard that exits on its first finding makes the second one cost a whole
    // extra round trip, and after two rounds people stop reading the output.
    const { out } = withAllDefects();
    for (const msg of Object.values(DEFECTS)) expect(out).toContain(msg);
  });

  // ── output discipline ──────────────────────────────────────────────────────

  it("never prints file content", () => {
    // A guard that echoes a twin's body into a public CI log has published
    // source, and any fixture-shaped constant in it. Same reasoning as
    // lefthook.yml's secret-scan masking its own matches.
    const [a, b] = withTrees({ "shared.ts": "both" }, []);
    const { out } = run(["--roots", a, b]);
    expect(out).not.toContain("export const x = 1;");
  });
});

// The normalizer, tested directly rather than through the guard, because these
// are the assertions that prove the semantic field means what it claims. The
// guard's own summary count is a consequence of them, not a substitute.
describe("check-twin-inventory: the semantic comparison", () => {
  const aliases = new Map([
    ["core", "@tauri-apps/api/core"],
    ["event", "@tauri-apps/api/event"],
  ]);
  const same = (x: string, y: string) => normalize(x, aliases) === normalize(y, aliases);

  it("calls a comment-only difference semantically identical", () => {
    // The `src/dialect/` shims are exactly this, and which side carries the
    // comment flips between the two files, so neither side is "the commented
    // one".
    expect(
      same(
        '// a header the other side does not have\nexport * from "@myne/dialect/x";\n',
        'export * from "@myne/dialect/x";\n',
      ),
    ).toBe(true);
  });

  it("calls a seam-import difference semantically identical", () => {
    // Four `src/lib/vault-*.ts` pairs differ in exactly this one line, and
    // `src/platform/core.ts` is a bare re-export of the module mobile imports.
    expect(
      same(
        'import { invoke } from "../platform/core";\nexport const f = () => invoke("x");\n',
        'import { invoke } from "@tauri-apps/api/core";\nexport const f = () => invoke("x");\n',
      ),
    ).toBe(true);
  });

  it("canonicalizes a seam import at any nesting depth", () => {
    expect(
      same(
        'import { listen } from "../../platform/event";\n',
        'import { listen } from "@tauri-apps/api/event";\n',
      ),
    ).toBe(true);
  });

  it("calls one real changed statement semantically different", () => {
    // The case that matters: myne#485 is a missing clamp inside a function whose
    // signature matches. If this passed, the field would be worthless.
    expect(
      same(
        "export function f(n) {\n  if (n > MAX) throw new Error();\n  return n;\n}\n",
        "export function f(n) {\n  return n;\n}\n",
      ),
    ).toBe(false);
  });

  it("does not treat a non-seam import difference as cosmetic", () => {
    // Only the modules `src/platform/` actually re-exports are canonicalized. A
    // different import is a different import.
    expect(same('import x from "./a";\n', 'import x from "./b";\n')).toBe(false);
  });

  it("leaves a URL inside a string alone", () => {
    // A naive comment stripper eats `https://`, which would silently equate two
    // files that point at different hosts.
    expect(
      same('const u = "https://a.example";\n', 'const u = "https://b.example";\n'),
    ).toBe(false);
  });

  it("leaves a single-quoted URL alone too", () => {
    // The twin of the test above, and the one that was missing. The Rust `'`
    // window was added to stop a lifetime desyncing the walker; applied to a
    // `.ts` file it does the opposite, because a `'`-quoted string longer than
    // the window stops being read as a string and the `//` inside `https://`
    // strips the rest of the line. These two then compare EQUAL. Testing only
    // the double-quoted form left the blind spot exactly where the coverage was
    // not.
    expect(
      same(
        "const u = 'https://a.example/path';\n",
        "const u = 'https://b.example/path';\n",
      ),
    ).toBe(false);
  });

  it("still treats a Rust lifetime as a lifetime, not a string opener", () => {
    // The direction the window was added for, asserted rather than assumed. A
    // desyncing walker swallows everything to the next tick, so the doc comment
    // between two lifetimes survives the strip and a comment-only difference
    // reads as drift. Measured on `local_inference/commands.rs`, that preserved
    // 163 lines of `///`.
    const src = (doc: string) =>
      `pub fn f<'a>(x: &'a str) -> &'a str {\n    /// ${doc}\n    x\n}\n`;
    expect(
      normalize(src("one"), aliases, "rust") === normalize(src("two"), aliases, "rust"),
    ).toBe(true);
  });

  it("reads a Rust raw string as a string, not as code", () => {
    // The third `'`-and-`"` case, and it is live rather than latent: four
    // rostered files carry raw strings today (both sides of
    // vault_repair/commands.rs and of local_inference/mod.rs).
    //
    // The body below holds an ODD number of inner quotes on purpose. With an
    // even number the naive walk pairs them up and re-syncs by accident, which
    // is why the first version of this test passed against the bug. With one,
    // the walker's string closes early, the rest of the body is read as code,
    // and the `//` in it deletes everything after it on the line, including the
    // real statement that follows. Both files then normalize to the same text.
    const src = (tail: number) =>
      `let q = r#"x " // y"#; let keep = ${tail};\n`;
    expect(
      normalize(src(1), aliases, "rust") === normalize(src(2), aliases, "rust"),
    ).toBe(false);
    // And the strip itself: nothing after the raw string may be lost.
    expect(stripComments(src(1), "rust").trim()).toBe(
      'let q = r#"x " // y"#; let keep = 1;',
    );
  });

  it("does not mistake a variable named r for a raw-string opener", () => {
    // `r` is a legal Rust binding, so the opener has to require the quote to
    // follow immediately. Without the preceding-character check, `let r = 1;`
    // plus any later quote on the line would swallow the line.
    //
    // Asserted through `normalize`, which is the function the guard actually
    // compares with: `stripComments` leaves the space that sat before the `//`,
    // and pinning that byte would be testing the whitespace rather than the
    // property. The property is that the line after it survives.
    expect(normalize('let r = 1; // gone\nlet s = "z";\n', aliases, "rust")).toBe(
      'let r = 1;\nlet s = "z";',
    );
  });

  it("keeps a Rust char literal whose contents look like a comment", () => {
    // The window's other half: `'/'` is a real char literal and must survive,
    // or the walker resyncs on the wrong tick.
    expect(stripComments("let c = '/'; // gone\n", "rust").trim()).toBe("let c = '/';");
  });

  it("strips a block comment without touching code on the same line", () => {
    expect(stripComments("const a = 1; /* note */ const b = 2;\n").trim()).toBe(
      "const a = 1;  const b = 2;",
    );
  });

  it("does not strip a comment marker inside a string literal", () => {
    expect(stripComments('const s = "// not a comment";\n').trim()).toBe(
      'const s = "// not a comment";',
    );
  });

  it("reads the seam map from the tree rather than a hardcoded list", () => {
    // A hardcoded copy is a second roster that drifts from the seam it
    // describes. This asserts the derivation actually ran, and found the module
    // every one of the four one-line pairs turns on.
    const map = seamAliases();
    expect(map.get("core")).toBe("@tauri-apps/api/core");
    expect(map.size).toBeGreaterThan(1);
  });

  it("skips a platform module that re-exports more than one specifier", () => {
    // Not a bare alias, so canonicalizing it would claim an equivalence nobody
    // established.
    const dir = mkdtempSync(join(tmpdir(), "myne-seam-"));
    writeFileSync(
      join(dir, "multi.ts"),
      'export { a } from "@tauri-apps/api/core";\nexport { b } from "@tauri-apps/api/event";\n',
    );
    writeFileSync(join(dir, "single.ts"), 'export { c } from "@tauri-apps/api/path";\n');
    const map = seamAliases(dir);
    expect(map.has("multi")).toBe(false);
    expect(map.get("single")).toBe("@tauri-apps/api/path");
    rmSync(dir, { recursive: true, force: true });
  });
});
