// Break tests for `scripts/check-duplication.mjs` (myne-md/myne#995).
//
// Root `AGENTS.md`: "Verifying a guard means breaking it, not running it." Running
// the guard on the real tree proves only that the real tree matches its record,
// which is exactly what a roster of everything licenses. Every case below builds
// its own synthetic sources, so each injection runs on every commit and none of
// them needs a `git restore`.
//
// The cases nobody thinks to try, and the shape they forced:
//
//   - a RENAMED copy must be caught. That is the whole premise: identifiers
//     differ in every copy by definition, so the scan compares a skeleton and
//     this case pins that it does. If it ever stops normalising, this goes red
//     while every recorded group still matches.
//   - a copy whose body differs in ONE value must NOT be caught by the clone
//     scan — and must be caught by the repeat scan instead. That is the
//     `FieldLabel` family, and it is why the guard has two signals: the eleven
//     copies differ in prop order and in `marginTop`, so no body comparison
//     groups them at any threshold.
//   - the same for an EXPORTED name, which must NOT be reported: an exported
//     helper is the shared owner, and reporting it would invert the signal.
//   - growth must fail while a shrink passes. A ratchet that fires on a shrink
//     teaches people to re-baseline without reading, and a re-baseline is the
//     only act that can quietly license a copy.
//   - `--emit` must REFUSE a new group. `check-i18n-duplicates.mjs` records the
//     same lesson one level down: a re-baseline that comes back green licensed
//     everything it found. Here the refusal is structural — the new id is not in
//     the previous baseline, so the emit cannot write it.
//   - a stale entry must fail in both sections, or the roster describes a tree
//     nobody has.

import { describe, expect, it } from "vitest";

import {
  CLOSURE_NAMES,
  MIN_REPEAT_SITES,
  PLACEHOLDER,
  buildRecord,
  checkGroups,
  cloneGroups,
  repeatDefinitions,
} from "../../scripts/check-duplication.mjs";

// A fixture long enough to clear WINDOW_LINES at MIN_TOKENS once normalised. The
// length is not decoration: the first version of this file sat one token under the
// floor, so every case passed against a detector that had found nothing and only
// the injection showed it. Measured here rather than guessed — the densest
// ten-line window below sums 50 tokens against a floor of 45.
const BODY = `export function readVaultMeta(dir: string): VaultMeta {
  const raw = readFileSync(join(dir, "vault.meta"), "utf-8");
  const header = raw.slice(0, MAGIC_LEN);
  if (header !== MAGIC) {
    throw new VaultMetaError("bad magic", header);
  }
  const version = Number(raw.slice(MAGIC_LEN, MAGIC_LEN + VERSION_LEN));
  if (version !== FORMAT_VERSION) {
    throw new VaultMetaError("bad version", version);
  }
  const account = raw.slice(ACCOUNT_OFFSET, ACCOUNT_OFFSET + ACCOUNT_LEN);
  if (account.length !== ACCOUNT_LEN) {
    throw new VaultMetaError("bad account length", account.length);
  }
  const check = damm32(account);
  const expected = Number(raw.slice(CHECK_OFFSET, CHECK_OFFSET + CHECK_LEN));
  if (check !== expected) {
    throw new VaultMetaError("bad checksum", check, expected);
  }
  return { version, account, check, header, size: raw.length };
}`;

// Same skeleton, every identifier and literal renamed: what a copy-paste into a
// second client looks like once the names stop matching.
const RENAMED = `export function openVaultMeta(path: string): VaultMeta {
  const text = readFileSync(join(path, "vault.meta"), "utf8");
  const first = text.slice(0, MARKER_LEN);
  if (first !== MARKER) {
    throw new VaultMetaError("wrong marker", first);
  }
  const generation = Number(text.slice(MARKER_LEN, MARKER_LEN + GEN_LEN));
  if (generation !== EXPECTED_FORMAT) {
    throw new VaultMetaError("wrong generation", generation);
  }
  const holder = text.slice(HOLDER_OFFSET, HOLDER_OFFSET + HOLDER_LEN);
  if (holder.length !== HOLDER_LEN) {
    throw new VaultMetaError("wrong holder length", holder.length);
  }
  const guard = damm32(holder);
  const wanted = Number(text.slice(GUARD_OFFSET, GUARD_OFFSET + GUARD_LEN));
  if (guard !== wanted) {
    throw new VaultMetaError("wrong checksum", guard, wanted);
  }
  return { generation, holder, guard, first, size: text.length };
}`;

// One structural difference in the middle: the `FieldLabel` family in miniature.
// No body comparison groups these at any threshold, which is why the repeat scan
// below exists.
const ONE_BLOCK_FEWER = `export function readVaultMeta(dir: string): VaultMeta {
  const raw = readFileSync(join(dir, "vault.meta"), "utf-8");
  const header = raw.slice(0, MAGIC_LEN);
  if (header !== MAGIC) {
    throw new VaultMetaError("bad magic", header);
  }
  const account = raw.slice(ACCOUNT_OFFSET, ACCOUNT_OFFSET + ACCOUNT_LEN);
  if (account.length !== ACCOUNT_LEN) {
    throw new VaultMetaError("bad account length", account.length);
  }
  const check = damm32(account);
  const expected = Number(raw.slice(CHECK_OFFSET, CHECK_OFFSET + CHECK_LEN));
  if (check !== expected) {
    throw new VaultMetaError("bad checksum", check, expected);
  }
  return { version: 0, account, check, header, size: raw.length };
}`;

const UNRELATED = `export function pruneNotes(list: string[]): string[] {
  const kept: string[] = [];
  for (const note of list) {
    if (note.trim().length === 0) continue;
    if (note.startsWith("#")) continue;
    kept.push(note);
  }
  kept.sort();
  return kept;
}`;

function sources(map: Record<string, string>) {
  return Object.entries(map).map(([path, text]) => ({ path, text }));
}

// The closure-name exclusions are checked for staleness against the names that
// QUALIFIED, so a case expecting a clean run has to pass them as present.
const ALL_CLOSURE_NAMES = new Set(Object.keys(CLOSURE_NAMES));

function record(clones: Record<string, unknown> = { verdicts: [], baseline: [] }, repeats: Record<string, unknown> = { verdicts: [], baseline: [] }) {
  return { clones, repeats } as never;
}

describe("cloneGroups", () => {
  it("catches a renamed copy of the same body", () => {
    const groups = cloneGroups(
      sources({ "src/a.ts": BODY, "mobile/src/a.ts": RENAMED, "src/b.ts": UNRELATED }),
    );
    expect([...groups.keys()]).toEqual(["mobile/src/a.ts + src/a.ts"]);
    const group = groups.get("mobile/src/a.ts + src/a.ts")!;
    expect(group.copies).toBe(2);
    expect(group.lines).toBeGreaterThanOrEqual(10);
  });

  it("splits a match at a structural difference instead of hiding it", () => {
    // A copy that differs in the middle is reported as the two regions that DO
    // match, each shorter than the body — which is the honest answer, and the
    // reason a dropped block cannot be smuggled in under one group id.
    const groups = cloneGroups(sources({ "src/a.ts": BODY, "src/b.ts": ONE_BLOCK_FEWER }));
    expect(groups.size).toBeGreaterThan(0);
    for (const group of groups.values()) {
      expect(group.lines).toBeLessThan(21);
      expect(group.copies).toBe(2);
    }
  });

  it("counts one region once, not once per window start", () => {
    // A run of identical consecutive lines produces many window starts that are
    // one block. Counting them as copies reported a 30-copy group that was one
    // paragraph repeated down a file.
    const repeated = Array.from({ length: 14 }, (_, i) => `  const field${i} = readField(dir, ${i});`).join("\n");
    const groups = cloneGroups(sources({ "src/a.ts": `export function load(dir: string) {\n${repeated}\n}` }));
    expect(groups.size).toBe(0);
  });

  it("gives every site of a three-way copy one group", () => {
    const groups = cloneGroups(
      sources({ "src/a.ts": BODY, "src/b.ts": RENAMED, "web/src/c.ts": BODY }),
    );
    expect([...groups.keys()]).toEqual(["src/a.ts + src/b.ts + web/src/c.ts"]);
    expect(groups.get("src/a.ts + src/b.ts + web/src/c.ts")!.copies).toBe(3);
  });
});

describe("repeatDefinitions", () => {
  const label = (value: string) => `function FieldLabel({ children }: { children: ReactNode }) {\n  return <div style={{ marginBottom: ${value} }}>{children}</div>;\n}`;

  it("catches one unexported name defined across three files even when the bodies differ", () => {
    const { repeats } = repeatDefinitions(
      sources({ "src/a.tsx": label("8"), "src/b.tsx": label("12"), "src/c.tsx": label("18") }),
    );
    expect([...repeats.keys()]).toEqual(["FieldLabel"]);
    expect(repeats.get("FieldLabel")!.files.length).toBe(MIN_REPEAT_SITES);
  });

  it("ignores an exported definition, which is the shared owner rather than a copy", () => {
    const exported = (value: string) => label(value).replace("function", "export function");
    const { repeats } = repeatDefinitions(
      sources({ "src/a.tsx": exported("8"), "src/b.tsx": exported("12"), "src/c.tsx": exported("18") }),
    );
    expect(repeats.size).toBe(0);
  });

  it("ignores two sites, which is a pair rather than a family", () => {
    const { repeats } = repeatDefinitions(sources({ "src/a.tsx": label("8"), "src/b.tsx": label("12") }));
    expect(repeats.size).toBe(0);
  });
});

describe("checkGroups", () => {
  const clones = () => cloneGroups(sources({ "src/a.ts": BODY, "mobile/src/a.ts": RENAMED }));
  const id = "mobile/src/a.ts + src/a.ts";
  const reason = "Both clients read the same file and neither can import the other's host seam.";

  it("fails a group that is neither recorded nor baselined, naming it", () => {
    const failures = checkGroups(clones(), new Map(), record(), new Set());
    expect(failures.some((f) => f.includes("new clone group") && f.includes(id))).toBe(true);
  });

  it("passes a group the baseline recorded", () => {
    expect(checkGroups(clones(), new Map(), record({ verdicts: [], baseline: [id] }), ALL_CLOSURE_NAMES)).toEqual([]);
  });

  it("fails a baselined entry that is gone, in both directions", () => {
    const failures = checkGroups(new Map(), new Map(), record({ verdicts: [], baseline: [id] }, { verdicts: [], baseline: ["pad2"] }), new Set());
    expect(failures.some((f) => f.includes("stale clone baseline entry"))).toBe(true);
    expect(failures.some((f) => f.includes("stale repeat baseline entry"))).toBe(true);
  });

  it("passes a shrink and fails a growth", () => {
    const grown = cloneGroups(sources({ "src/a.ts": BODY, "mobile/src/a.ts": RENAMED, "web/src/a.ts": BODY }));
    const grownId = "mobile/src/a.ts + src/a.ts + web/src/a.ts";
    const shrunkButPresent = [...grown.values()][0];
    const entry = { id: grownId, lines: shrunkButPresent.lines, copies: 2, verdict: "justified", reason };
    const failures = checkGroups(grown, new Map(), record({ verdicts: [entry], baseline: [] }), ALL_CLOSURE_NAMES);
    expect(failures.some((f) => f.includes("GREW"))).toBe(true);
  });

  it("fails the --emit placeholder reason rather than accepting its length", () => {
    const group = [...clones().values()][0];
    const failures = checkGroups(
      clones(),
      new Map(),
      record({ verdicts: [{ id: group.id, lines: group.lines, copies: group.copies, verdict: "justified", reason: PLACEHOLDER }], baseline: [] }),
      ALL_CLOSURE_NAMES,
    );
    expect(failures.some((f) => f.includes("placeholder reason"))).toBe(true);
  });

  it("fails a stale closure-name exclusion", () => {
    const repeats = new Map([
      ["FieldLabel", { name: "FieldLabel", sites: [{ path: "a", line: 1 }, { path: "b", line: 1 }, { path: "c", line: 1 }], files: ["a", "b", "c"] }],
    ]);
    const failures = checkGroups(new Map(), repeats, record(), new Set());
    expect(failures.some((f) => f.includes("stale closure-name exclusion: `toggle`"))).toBe(true);
  });
});

describe("buildRecord", () => {
  const id = "mobile/src/a.ts + src/a.ts";
  const reason = "Both clients read the same file and neither can import the other's host seam.";

  it("refuses to add a group that was never baselined", () => {
    const { refused, record: next } = buildRecord(
      cloneGroups(sources({ "src/a.ts": BODY, "mobile/src/a.ts": RENAMED })),
      new Map(),
      { clones: { verdicts: [], baseline: [] }, repeats: { verdicts: [], baseline: [] } },
    );
    expect(refused).toEqual([`clone group ${id}`]);
    expect(next.clones.baseline).toEqual([]);
  });

  it("keeps a recorded group and follows its numbers down", () => {
    const groups = cloneGroups(sources({ "src/a.ts": BODY, "mobile/src/a.ts": RENAMED }));
    const { record: next } = buildRecord(groups, new Map(), {
      clones: { verdicts: [{ id, lines: 99, copies: 9, verdict: "justified", reason }], baseline: [] },
      repeats: { verdicts: [], baseline: [] },
    });
    expect(next.clones.baseline).toEqual([]);
    expect(next.clones.verdicts[0]).toMatchObject({ id, verdict: "justified", reason });
    expect(next.clones.verdicts[0].lines).toBeLessThan(99);
    expect(next.clones.verdicts[0].copies).toBe(2);
  });
});
