// Injection tests for `check-crypto-registries.mjs` rule 5 (magic-generation
// parity), added with myne-md/myne#638.
//
// Root `AGENTS.md`: "Verifying a guard means breaking it, not running it."
// Every case below builds a synthetic tree, runs the real guard over it with
// `--root`, and asserts on what it says. Hand-mutating the checkout proves the
// same thing once and then expires, and the two guard fixes that motivated this
// rule were both "verified" that way by their authors.
//
// What rule 5 catches: a file that names a blob family's BASE magic constant
// and never mentions a later generation of it. On a migrated vault every blob
// of that family carries the later magic, and a reader taught only the base one
// does not fail: it returns `None`, which reads as "not this family".
// myne-md/myne#638 is that shape: `core/src/attachment_nonce.rs` accepted only
// `MYA1`, so attachment sync pushed and pulled nothing on any migrated vault,
// with every compiler, lint and gate green.

import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

const GUARD = fileURLToPath(new URL("../../scripts/check-crypto-registries.mjs", import.meta.url));

const roots: string[] = [];

afterEach(() => {
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
});

/**
 * The declarations every fixture needs.
 *
 * The note family is in here because `EXTRA_MAGIC_PAIRS` names it: a tree
 * missing `MY01` or `NC05` is a tree where that named pair has lost its
 * subject, and the guard is supposed to say so rather than fall silent. Case
 * "a named pair whose magic is gone" removes it deliberately.
 */
const REGISTRY: Record<string, string> = {
  "protocol/src/attachment_blob.rs": `
pub const ATTACHMENT_BLOB_MAGIC: &[u8; 4] = b"MYA1";
pub const ATTACHMENT_BLOB_V0_2_MAGIC: &[u8; 4] = b"MYA5";
`,
  "protocol/src/blob.rs": `pub const MAGIC: &[u8; 4] = b"MY01";\n`,
  "protocol/src/crdt_note_blob.rs": `pub const NC05_MAGIC: &[u8; 4] = b"NC05";\n`,
};

/** A fixture tree: the registry above, plus whatever `files` adds. */
function fixture(files: Record<string, string>, registry = REGISTRY): string {
  const root = mkdtempSync(join(tmpdir(), "myne-magic-parity-"));
  roots.push(root);
  for (const [rel, body] of Object.entries({ ...registry, ...files })) {
    const abs = join(root, rel);
    mkdirSync(join(abs, ".."), { recursive: true });
    writeFileSync(abs, body, "utf8");
  }
  return root;
}

/** Run the guard over `root`; returns its exit code and combined output. */
function run(root: string): { code: number; out: string } {
  try {
    const out = execFileSync("node", [GUARD, "--root", root], { encoding: "utf8" });
    return { code: 0, out };
  } catch (e) {
    const err = e as { status?: number; stdout?: string; stderr?: string };
    return { code: err.status ?? 1, out: `${err.stdout ?? ""}${err.stderr ?? ""}` };
  }
}

describe("check-crypto-registries rule 5: magic-generation parity", () => {
  it("names the file that reads only the v0.1 magic", () => {
    const root = fixture({
      "core/src/reader.rs": `
use protocol::attachment_blob::ATTACHMENT_BLOB_MAGIC;
pub fn nonce(header: &[u8]) -> Option<()> {
    if header[0..4] != *ATTACHMENT_BLOB_MAGIC {
        return None;
    }
    Some(())
}
`,
    });
    const { code, out } = run(root);
    expect(code).toBe(1);
    expect(out).toContain("core/src/reader.rs");
    expect(out).toContain("magic-parity");
    expect(out).toContain("ATTACHMENT_BLOB_V0_2_MAGIC");
  });

  it("passes once the same file names both generations", () => {
    const root = fixture({
      "core/src/reader.rs": `
use protocol::attachment_blob::{ATTACHMENT_BLOB_MAGIC, ATTACHMENT_BLOB_V0_2_MAGIC};
pub fn nonce(header: &[u8]) -> Option<()> {
    if header[0..4] != *ATTACHMENT_BLOB_MAGIC && header[0..4] != *ATTACHMENT_BLOB_V0_2_MAGIC {
        return None;
    }
    Some(())
}
`,
    });
    expect(run(root).code).toBe(0);
  });

  it("fires even when the file carries no byte-string literal", () => {
    // The prefilter (`CANDIDATE`) is the reason this case exists. It was
    // written for four rules whose subjects are all literals or calls, so a
    // file that merely IMPORTS a magic constant was skipped before rule 5 could
    // look at it, so the guard would have reported ok on input it never read.
    const root = fixture({
      "core/src/quiet.rs": `
use protocol::attachment_blob::ATTACHMENT_BLOB_MAGIC;
pub fn is_family(header: &[u8]) -> bool {
    header.starts_with(ATTACHMENT_BLOB_MAGIC)
}
`,
    });
    const { code, out } = run(root);
    expect(code).toBe(1);
    expect(out).toContain("core/src/quiet.rs");
  });

  it("ignores a v0.1-only mention inside a #[cfg(test)] region", () => {
    // A golden test that pins the v0.1 bytes is legitimate and says nothing
    // about what the production reader accepts.
    const root = fixture({
      "core/src/tested.rs": `
pub fn nothing() {}

#[cfg(test)]
mod tests {
    use protocol::attachment_blob::ATTACHMENT_BLOB_MAGIC;
    #[test]
    fn v0_1_bytes_are_pinned() {
        assert_eq!(ATTACHMENT_BLOB_MAGIC, b"MYA1");
    }
}
`,
    });
    expect(run(root).code).toBe(0);
  });

  it("covers a THIRD generation without being edited", () => {
    // The rule is derived from a `_V<n>_<m>_MAGIC` pattern rather than from the
    // literal `_V0_2_MAGIC`, because a rule written because one generation was
    // missed must not itself be keyed to one named generation. A file that
    // knows v0.1 and v0.2 and not v0.3 is the same defect one generation later.
    const root = fixture(
      {
        "core/src/reader.rs": `
use protocol::attachment_blob::{ATTACHMENT_BLOB_MAGIC, ATTACHMENT_BLOB_V0_2_MAGIC};
pub fn nonce(header: &[u8]) -> Option<()> {
    if header[0..4] != *ATTACHMENT_BLOB_MAGIC && header[0..4] != *ATTACHMENT_BLOB_V0_2_MAGIC {
        return None;
    }
    Some(())
}
`,
      },
      {
        ...REGISTRY,
        "protocol/src/attachment_blob.rs": `
pub const ATTACHMENT_BLOB_MAGIC: &[u8; 4] = b"MYA1";
pub const ATTACHMENT_BLOB_V0_2_MAGIC: &[u8; 4] = b"MYA5";
pub const ATTACHMENT_BLOB_V0_3_MAGIC: &[u8; 4] = b"MYA9";
`,
      },
    );
    const { code, out } = run(root);
    expect(code).toBe(1);
    expect(out).toContain("ATTACHMENT_BLOB_V0_3_MAGIC");
    expect(out).toContain("v0.3");
    // The generation it DOES know must not be reported as missing.
    expect(out).not.toContain("ATTACHMENT_BLOB_V0_2_MAGIC (MYA5");
  });

  it("does NOT exempt a codec when a later generation lands in a sibling module", () => {
    // The case the exemption used to swallow, and the one moment it matters.
    // `attachment_blob.rs` declares MYA1 and MYA5, so exempting every
    // declaration site excused it forever; when a third generation arrives in a
    // sibling file (this repo's own precedent, `vault_meta_v0_2.rs`), its
    // magic-detecting dispatch still handles two of three and nothing says so.
    const root = fixture(
      {},
      {
        ...REGISTRY,
        "protocol/src/attachment_blob.rs": `
pub const ATTACHMENT_BLOB_MAGIC: &[u8; 4] = b"MYA1";
pub const ATTACHMENT_BLOB_V0_2_MAGIC: &[u8; 4] = b"MYA5";
pub fn decode(blob: &[u8]) -> bool {
    blob.starts_with(ATTACHMENT_BLOB_MAGIC) || blob.starts_with(ATTACHMENT_BLOB_V0_2_MAGIC)
}
`,
        "protocol/src/attachment_blob_v0_3.rs": `pub const ATTACHMENT_BLOB_V0_3_MAGIC: &[u8; 4] = b"MYA9";\n`,
      },
    );
    const { code, out } = run(root);
    expect(code).toBe(1);
    expect(out).toContain("protocol/src/attachment_blob.rs");
    expect(out).toContain("ATTACHMENT_BLOB_V0_3_MAGIC");
  });

  it("still exempts a split family's declaration sites", () => {
    // `vault_meta.rs` declares MYV1 and nothing else; NTV5 is a sibling module.
    // Requiring both names there would fail a declaration, which accepts nothing.
    const root = fixture(
      {},
      {
        ...REGISTRY,
        "protocol/src/vault_meta.rs": `pub const VAULT_META_MAGIC: [u8; 4] = *b"MYV1";\n`,
        "protocol/src/vault_meta_v0_2.rs": `pub const VAULT_META_V0_2_MAGIC: [u8; 4] = *b"NTV5";\n`,
      },
    );
    expect(run(root).code).toBe(0);
  });

  it("FIRES for the hand-named note family: blob::MAGIC alone is a violation", () => {
    // The stale-roster case below proves the pair is still connected to the
    // tree. It does not prove the pair FIRES, and those are different claims:
    // this family's base token is the hand-typed string "blob::MAGIC" at
    // scripts/check-crypto-registries.mjs. If that spelling were ever wrong, or
    // the source spelling moved, `fam.base.re` would match nothing, the loop
    // would `continue`, and the note family's parity check would silently stop
    // existing while the guard printed ok. That is the same silent-pass shape
    // the whole rule exists to remove, so it gets the injection root AGENTS.md
    // asks for: put the defect in, watch it named, take it out.
    const root = fixture({
      "core/src/note_reader.rs":
        "use protocol::blob;\n" +
        "pub fn is_note(b: &[u8]) -> bool {\n" +
        "    b.len() >= 4 && &b[0..4] == blob::MAGIC\n" +
        "}\n",
    });
    const { code, out } = run(root);
    expect(code).toBe(1);
    expect(out).toContain("core/src/note_reader.rs");
    expect(out).toContain("NC05_MAGIC");
  });

  it("and clears once the same file names NC05_MAGIC too", () => {
    // The paired direction. Without it the case above would also pass against a
    // guard that failed every file unconditionally.
    const root = fixture({
      "core/src/note_reader.rs":
        "use protocol::blob;\n" +
        "use protocol::NC05_MAGIC;\n" +
        "pub fn is_note(b: &[u8]) -> bool {\n" +
        "    b.len() >= 4 && (&b[0..4] == blob::MAGIC || &b[0..4] == NC05_MAGIC)\n" +
        "}\n",
    });
    expect(run(root).code).toBe(0);
  });

  it("fails when a NAMED pair's magic is gone from the registry", () => {
    // The note family is paired by hand because `blob::MAGIC` / `NC05_MAGIC`
    // fit no naming pattern. A hand-written pair that outlives its subject
    // checks nothing, so the guard compares the roster against the tree in
    // both directions.
    const withoutNc05 = { ...REGISTRY };
    delete withoutNc05["protocol/src/crdt_note_blob.rs"];
    const root = fixture({}, withoutNc05);
    const { code, out } = run(root);
    expect(code).toBe(1);
    expect(out).toContain("EXTRA_MAGIC_PAIRS");
    expect(out).toContain("NC05");
  });
});
