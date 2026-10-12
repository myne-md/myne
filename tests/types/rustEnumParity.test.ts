import { existsSync, readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

// Drift lock for every TypeScript mirror of a Rust enum (myne-md/myne#475).
//
// **The defect this closes.** Fifteen modules under `src/types/` and
// `mobile/src/types/` are hand-written mirrors of Rust enums the backend
// returns across IPC, and NOTHING compared them. Seven of the fifteen had
// drifted. A missing variant does not fail to compile and does not throw: the
// client falls through to a generic branch and shows a worse message, or shows
// nothing, for a failure the backend named precisely. On the phone it was worse
// still, because the Rust enum had the variant, the desktop mirror had it, and
// mobile's did not, so the three could only be compared by a person who thought
// to look at all three.
//
// **Why a test and not `ts-rs`.** Every one of these files opens with a
// `TODO(Phase-1-end)` proposing `ts-rs` codegen plus a `git diff --exit-code`
// drift check. That is a bigger change than the defect warrants, a proc-macro
// dependency in the crypto-adjacent crates, a generated-artefact convention, and
// a build step in a repo whose guards are deliberately zero-dependency Node. The
// property those TODOs actually want is "the two agree", and a parser gets it
// today. `tests/lib/engineErrorTaxonomy.test.ts` already does exactly this for
// the `EngineError` taxonomy and is the shape copied here.
//
// **Paths are constants, and a missing one FAILS rather than skips.** That is
// not a formality: twelve of the eighteen Rust paths cited in these files'
// header comments were already stale when this test was written, pointing into
// `src-tauri/src/plugins/` for enums the `myne-core` extraction moved to
// `core/src/plugins/`. A glob would have found some other `error.rs` and
// compared a TS union against the wrong enum, silently. The precedent's own
// comment says it best: an `ENOENT` on a path that no longer exists is the right
// failure.

const at = (p: string): string => fileURLToPath(new URL(`../../${p}`, import.meta.url));

/**
 * One mirror: a TypeScript type and the Rust enum it claims to mirror.
 *
 * A NAMED roster rather than a sweep. A sweep over `client-core/src/types/`
 * could not say which enum a file mirrors, and guessing from the filename is how
 * `vault-repair-error.ts` would have been compared against the wrong one: its
 * two client copies mirror two DIFFERENT Rust types today (see its entry).
 */
type Mirror = {
  /** Repo-relative path of the TypeScript file. */
  ts: string;
  /** The exported type name inside it. */
  tsType: string;
  /** Repo-relative path of the Rust file. */
  rs: string;
  /** The `pub enum` name inside it. */
  rsEnum: string;
};

// No "deliberately omitted variant" field, and its absence is the finding
// rather than an oversight: the first draft carried a `tsOmits` map with its
// own filter and its own stale-entry loop, and NONE of the 22 rows used it.
// Speculative machinery in a drift lock is worse than none, because it reads as
// a documented escape hatch. If a mirror ever does need to omit a variant, the
// right shape is a row that says so, and it can be added when there is one.

const MIRRORS: Mirror[] = [
  // ---- the fifteen twins (present on both clients) ----------------------
  {
    ts: "client-core/src/types/vault-unlock-error.ts",
    tsType: "VaultUnlockError",
    rs: "core/src/plugins/vault_unlock/error.rs",
    rsEnum: "VaultUnlockError",
  },
  {
    ts: "client-core/src/types/vault-unlock-error.ts",
    tsType: "IoFailureKind",
    rs: "format/src/io_failure_kind.rs",
    rsEnum: "IoFailureKind",
  },
  {
    ts: "client-core/src/types/vault-status.ts",
    tsType: "VaultStatus",
    rs: "core/src/plugins/vault_unlock/commands.rs",
    rsEnum: "VaultStatus",
  },
  {
    ts: "client-core/src/types/vault-status.ts",
    tsType: "VaultStatusError",
    rs: "core/src/plugins/vault_unlock/error.rs",
    rsEnum: "VaultStatusError",
  },
  {
    ts: "client-core/src/types/vault-summary.ts",
    tsType: "VaultSummaryStatus",
    rs: "core/src/plugins/vault_unlock/commands.rs",
    rsEnum: "VaultSummaryStatus",
  },
  {
    ts: "client-core/src/types/slot-kind.ts",
    tsType: "SlotKind",
    rs: "core/src/plugins/vault_unlock/state.rs",
    rsEnum: "SlotKind",
  },
  {
    ts: "client-core/src/types/quick-unlock-error.ts",
    tsType: "QuickUnlockError",
    rs: "core/src/plugins/quick_unlock/error.rs",
    rsEnum: "QuickUnlockError",
  },
  {
    ts: "client-core/src/types/vault-change-password-error.ts",
    tsType: "VaultChangePasswordError",
    rs: "core/src/plugins/vault_change_password/error.rs",
    rsEnum: "VaultChangePasswordError",
  },
  {
    ts: "client-core/src/types/vault-recovery-error.ts",
    tsType: "VaultRecoveryError",
    rs: "core/src/plugins/vault_recover/error.rs",
    rsEnum: "VaultRecoveryError",
  },
  {
    ts: "client-core/src/types/vault-delete-error.ts",
    tsType: "VaultDeleteError",
    rs: "core/src/plugins/vault_delete/error.rs",
    rsEnum: "VaultDeleteError",
  },
  {
    ts: "client-core/src/types/protocol-error.ts",
    tsType: "AppError",
    rs: "core/src/plugins/vault_creation/error.rs",
    rsEnum: "AppError",
  },
  {
    ts: "client-core/src/types/protocol-error.ts",
    tsType: "IoErrorKind",
    rs: "core/src/plugins/vault_creation/error.rs",
    rsEnum: "IoErrorKind",
  },
  {
    ts: "client-core/src/types/protocol-error.ts",
    tsType: "ProtocolError",
    rs: "protocol/src/error.rs",
    rsEnum: "ProtocolError",
  },
  {
    ts: "client-core/src/types/note-create-error.ts",
    tsType: "NoteCreateError",
    rs: "core/src/plugins/notes/error.rs",
    rsEnum: "NoteCreateError",
  },
  {
    ts: "client-core/src/types/note-read-error.ts",
    tsType: "NoteReadError",
    rs: "core/src/plugins/notes/error.rs",
    rsEnum: "NoteReadError",
  },
  {
    ts: "client-core/src/types/note-update-error.ts",
    tsType: "NoteUpdateError",
    rs: "core/src/plugins/notes/error.rs",
    rsEnum: "NoteUpdateError",
  },
  {
    ts: "client-core/src/types/live-session-error.ts",
    tsType: "LiveSessionCommandError",
    rs: "core/src/plugins/live/commands.rs",
    rsEnum: "LiveSessionCommandError",
  },
  {
    ts: "client-core/src/types/note-delete-error.ts",
    tsType: "NoteDeleteError",
    rs: "core/src/plugins/notes/error.rs",
    rsEnum: "NoteDeleteError",
  },
  {
    ts: "client-core/src/types/note-list-error.ts",
    tsType: "NoteListError",
    rs: "core/src/plugins/notes/error.rs",
    rsEnum: "NoteListError",
  },

  // ---- desktop-only mirrors ---------------------------------------------
  // Not twins, so outside myne-md/myne#475's stated scope, and included anyway:
  // they are the same file family with the same defect, and a parity test that
  // covers half the mirrors has a blind spot in the half nobody is looking at.
  {
    ts: "src/types/vault-repair-error.ts",
    tsType: "VaultRepairError",
    rs: "src-tauri/src/plugins/vault_repair/error.rs",
    rsEnum: "VaultRepairError",
  },
  {
    ts: "src/types/resolved-identity.ts",
    tsType: "ResolvedIdentity",
    rs: "core/src/plugins/sync/identity_resolver.rs",
    rsEnum: "ResolvedIdentity",
  },
  {
    // The one mirror with TWO copies, because its Rust source is still a twin
    // across the two client crates rather than one file in `core/`, which is
    // exactly why `vault-repair-error.ts` did not move into `@myne/client-core`
    // with its fourteen siblings. Both copies are covered: package membership
    // and parity coverage are independent decisions, and the mobile side was
    // covered by nothing until this row.
    ts: "mobile/src/types/vault-repair-error.ts",
    tsType: "VaultRepairError",
    rs: "mobile/src-tauri/src/plugins/vault_repair/error.rs",
    rsEnum: "VaultRepairError",
  },
  {
    ts: "src/types/note-batch-error.ts",
    tsType: "NoteBatchError",
    rs: "core/src/plugins/notes/error.rs",
    rsEnum: "NoteBatchError",
  },
  {
    ts: "src/types/note-title-error.ts",
    tsType: "NoteTitleError",
    rs: "core/src/plugins/notes/error.rs",
    rsEnum: "NoteTitleError",
  },
  {
    ts: "src/types/note-export-error.ts",
    tsType: "NoteExportError",
    rs: "core/src/plugins/notes/error.rs",
    rsEnum: "NoteExportError",
  },

  // The six desktop-only mirrors. They stayed out of `@myne/client-core` because
  // mobile has no counterpart for any of them, which is a placement decision and
  // not a reason to leave them uncompared: the drift this test locks is between
  // a TypeScript union and a Rust enum, and that exists wherever the mirror
  // does. They were missed on the first pass and found by the both-ways
  // denominator below, which is the case for having one.
  {
    ts: "src/types/backup-export-error.ts",
    tsType: "BackupExportError",
    rs: "src-tauri/src/plugins/backup/error.rs",
    rsEnum: "BackupExportError",
  },
  {
    ts: "src/types/backup-export-error.ts",
    tsType: "BackupRestoreError",
    rs: "src-tauri/src/plugins/backup/error.rs",
    rsEnum: "BackupRestoreError",
  },
  {
    ts: "src/types/import-read-error.ts",
    tsType: "ImportReadError",
    rs: "src-tauri/src/plugins/importer/error.rs",
    rsEnum: "ImportReadError",
  },
  {
    ts: "src/types/pdf-export-error.ts",
    tsType: "PdfExportError",
    rs: "src-tauri/src/plugins/pdf_export/error.rs",
    rsEnum: "PdfExportError",
  },
  {
    // Named differently on the two sides, which is why the roster carries both
    // names rather than deriving one from the other.
    ts: "src/types/pdf-export-error.ts",
    tsType: "PdfCaptureFailureKind",
    rs: "src-tauri/src/plugins/pdf_export/error.rs",
    rsEnum: "CaptureFailureKind",
  },
  {
    ts: "src/types/snapshot-error.ts",
    tsType: "SnapshotError",
    rs: "core/src/plugins/snapshots/error.rs",
    rsEnum: "SnapshotError",
  },
  {
    ts: "src/types/vault-export-error.ts",
    tsType: "VaultExportError",
    rs: "format/src/export_error.rs",
    rsEnum: "VaultExportError",
  },
];

/**
 * The floor under the roster, measured rather than chosen.
 *
 * A named roster with no floor is a roster that can be emptied: delete rows
 * until the failing one is gone and every remaining case passes, which reads in
 * the diff as a test that got shorter. `check-manual-test-roster.mjs` and
 * `check-twin-drift-ratchet.mjs` both carry the same idea and both keep the
 * number in the code rather than in the data it bounds, for the same reason.
 */
const MIRROR_FLOOR = 30;

/**
 * Trees that may hold a mirror, walked by the both-ways denominator.
 *
 * `mobile/src/types/` is here even though almost all of it is now re-export
 * shims: a shim carries no header, so it does not enter the denominator, and the
 * one file that is NOT a shim (`vault-repair-error.ts`, whose two client copies
 * mirror two different Rust types) must keep being seen.
 */
const MIRROR_DIRS = ["client-core/src/types", "src/types", "mobile/src/types"];

/**
 * A file declares itself a mirror by carrying this marker, which every one of
 * them opens with. Keying on the file's own declaration rather than on a
 * filename pattern is what makes the denominator honest: `note-search-result.ts`
 * is a `src/types/` file that mirrors no enum and says so by not carrying it.
 */
const MIRROR_MARKER = "TODO(Phase-1-end)";

/** Strip `//`-comments and `#[…]`/`#![…]` attributes from Rust source. */
function stripRust(src: string): string {
  return src
    .split("\n")
    .filter((l) => {
      const t = l.trim();
      return !t.startsWith("//") && !t.startsWith("#[") && !t.startsWith("#![");
    })
    .join("\n");
}

/** Strip `//`-line and `/* … *​/`-block comments from TypeScript source. */
function stripTs(src: string): string {
  const noBlock = src.replace(/\/\*[\s\S]*?\*\//g, "");
  return noBlock
    .split("\n")
    .filter((l) => !l.trim().startsWith("//"))
    .join("\n");
}

/** The `{ … }` body that follows `needle`, brace-matched. */
function bodyAfter(src: string, needle: RegExp): string | null {
  const m = needle.exec(src);
  if (!m) return null;
  const open = src.indexOf("{", m.index + m[0].length - 1);
  if (open === -1) return null;
  let depth = 0;
  for (let i = open; i < src.length; i += 1) {
    if (src[i] === "{") depth += 1;
    else if (src[i] === "}") {
      depth -= 1;
      if (depth === 0) return src.slice(open + 1, i);
    }
  }
  return null;
}

/** Variant names of `pub enum <name>`, in declaration order. */
export function rustVariants(src: string, name: string): string[] {
  // `\b` after the name so `VaultStatus` does not match `VaultStatusError`, and
  // an optional generic parameter list so `Foo<E>` is found by `Foo`.
  const body = bodyAfter(stripRust(src), new RegExp(`pub enum ${name}\\b(?:<[^>]*>)?\\s*\\{`));
  if (body === null) return [];
  const out: string[] = [];
  let depth = 0;
  for (const raw of body.split("\n")) {
    const line = raw.trim();
    if (depth === 0) {
      const m = /^([A-Z]\w*)\s*(?:[,({]|$)/.exec(line);
      if (m) out.push(m[1]);
    }
    for (const ch of line) {
      if (ch === "{" || ch === "(") depth += 1;
      else if (ch === "}" || ch === ")") depth -= 1;
    }
  }
  return out;
}

/**
 * Variant names of an exported TypeScript mirror.
 *
 * Two shapes, and the discriminator is whether the body mentions `kind:`. A
 * serde-tagged Rust enum mirrors as `| { kind: "X" }`; a bare unit-only enum
 * (`IoFailureKind`, `SlotKind`) serializes as a plain string and mirrors as a
 * string-literal union `| "X"`.
 */
export function tsVariants(src: string, name: string): string[] {
  const stripped = stripTs(src);
  const start = new RegExp(`export type ${name}\\s*=`).exec(stripped);
  if (!start) return [];
  const rest = stripped.slice(start.index + start[0].length);
  // The declaration ends at the first `;` outside any brace.
  let depth = 0;
  let end = rest.length;
  for (let i = 0; i < rest.length; i += 1) {
    const ch = rest[i];
    if (ch === "{") depth += 1;
    else if (ch === "}") depth -= 1;
    else if (ch === ";" && depth === 0) {
      end = i;
      break;
    }
  }
  const body = rest.slice(0, end);
  const tagged = [...body.matchAll(/\bkind:\s*"(\w+)"/g)].map((m) => m[1]);
  if (tagged.length > 0) return tagged;
  return [...body.matchAll(/"(\w+)"/g)].map((m) => m[1]);
}

describe("Rust enum ↔ TypeScript mirror parity", () => {
  it("keeps at least as many mirrors as were measured", () => {
    expect(
      MIRRORS.length,
      "the roster shrank; a mirror was removed rather than fixed, or the floor is stale",
    ).toBeGreaterThanOrEqual(MIRROR_FLOOR);
  });

  it("has a row for every file that declares itself a mirror", () => {
    // The both-ways half. Every case above is driven BY the roster, so a mirror
    // file with no row is invisible to all of them: it type-checks, it ships,
    // and nothing compares it to its Rust enum. That is not hypothetical. The
    // first version of this file had no such check and left SIX unclaimed
    // (`backup-export-error` twice, `import-read-error`, `pdf-export-error`
    // twice and `snapshot-error`, plus `vault-export-error`), and correcting it
    // turned up five more stale Rust paths in their headers on the way.
    const claimed = new Set(MIRRORS.map((m) => m.ts));
    const unclaimed: string[] = [];
    for (const dir of MIRROR_DIRS) {
      const abs = at(dir);
      // A tree named here but absent from the checkout is a failure, not a
      // smaller walk: silently skipping one is how a denominator goes blind to
      // a whole client.
      expect(existsSync(abs), `mirror tree missing from the checkout: ${dir}`).toBe(true);
      for (const name of readdirSync(abs)) {
        if (!name.endsWith(".ts") || name.endsWith(".d.ts")) continue;
        const rel = `${dir}/${name}`;
        if (claimed.has(rel)) continue;
        if (!readFileSync(at(rel), "utf8").includes(MIRROR_MARKER)) continue;
        unclaimed.push(rel);
      }
    }
    expect(unclaimed, "these files declare themselves mirrors and have no roster row").toEqual(
      [],
    );
  });

  it("has no roster row whose TypeScript file is gone", () => {
    // The other direction, so a deleted mirror cannot leave a row behind that
    // then fails with `ENOENT` inside a per-mirror case and reads like a parser
    // bug rather than a stale roster.
    const stale = [...new Set(MIRRORS.map((m) => m.ts))].filter((p) => !existsSync(at(p)));
    expect(stale, "roster rows naming TypeScript files that no longer exist").toEqual([]);
  });

  it("has a roster whose every Rust path exists", () => {
    // Checked as its own case, before any comparison, because the failure mode
    // this test exists to prevent is a mirror compared against nothing. A path
    // that has moved must fail BY NAME here rather than produce an empty
    // variant list that then "matches" an empty TS side.
    const missing = MIRRORS.filter((m) => !existsSync(at(m.rs))).map(
      (m) => `${m.tsType}: ${m.rs}`,
    );
    expect(missing).toEqual([]);
  });

  it.each(MIRRORS)("$tsType mirrors $rsEnum", (m: Mirror) => {
    const rs = rustVariants(readFileSync(at(m.rs), "utf8"), m.rsEnum);
    const ts = tsVariants(readFileSync(at(m.ts), "utf8"), m.tsType);

    // A parser that finds nothing must fail, not pass vacuously. Both sides:
    // an empty Rust list means the enum was renamed, an empty TS list means the
    // type was.
    expect(rs.length, `no variants parsed from ${m.rsEnum} in ${m.rs}`).toBeGreaterThan(0);
    expect(ts.length, `no variants parsed from ${m.tsType} in ${m.ts}`).toBeGreaterThan(0);

    // Set equality is both directions at once: a variant the mirror is MISSING
    // is a failure the client falls through on, and a variant the Rust enum
    // dropped is a branch the client will never take while reading as live code.
    expect(new Set(ts), `${m.tsType} and ${m.rsEnum} name different variants`).toEqual(
      new Set(rs),
    );
  });

  it("parses a tagged union, a string-literal union and a generic enum", () => {
    // The parsers themselves, against fixtures rather than against the tree, so
    // a tree-wide rename cannot make this vacuous.
    const rs = `
      #[derive(Serialize)]
      pub enum Sample {
          /// doc
          Unit,
          #[error("io")]
          WithFields { a: u8, b: u8 },
          Tuple(String),
      }
      pub enum Generic<E> { OnlyOne }
      pub enum SampleError { NotSample }
    `;
    expect(rustVariants(rs, "Sample")).toEqual(["Unit", "WithFields", "Tuple"]);
    expect(rustVariants(rs, "Generic")).toEqual(["OnlyOne"]);
    // `\b` guards the prefix collision that `VaultStatus` / `VaultStatusError`
    // has in the real tree.
    expect(rustVariants(rs, "SampleError")).toEqual(["NotSample"]);

    const ts = `
      export type Tagged =
        // a comment naming "NotAVariant"
        | { kind: "Unit" }
        /** a docblock naming "AlsoNot" */
        | { kind: "WithFields"; detail: { a: number } };
      export type Literal = "One" | "Two";
    `;
    expect(tsVariants(ts, "Tagged")).toEqual(["Unit", "WithFields"]);
    expect(tsVariants(ts, "Literal")).toEqual(["One", "Two"]);
  });
});
