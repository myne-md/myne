// Conflict rules for the Myne vault import source (myne-md/myne#464).
//
// The guarantee under test, stated once: an imported wikilink never resolves to
// a note that was not imported with it. Every case below is either that
// guarantee holding or the one residual the design accepted.

import { describe, expect, it } from "vitest";
import {
  addUntitledIdentities,
  bodyForIdentity,
  buildExistingIdentitySet,
  decideMyneImport,
  hashBodyForIdentity,
  noteIdentityKey,
  renamedTitleFor,
  untitledIdentityKey,
  type MyneConflictContext,
} from "../../../src/notes/import/conflict";

const LABEL = "Eski laptop";

function ctx(
  existingTitles: readonly { folder: string | null; title: string }[],
  links: Record<string, string[]> = {},
  extra: { untitled?: readonly { folder: string | null; bodyHash: string }[] } = {},
): MyneConflictContext {
  const base = buildExistingIdentitySet(
    existingTitles.map((n) => ({
      folder: n.folder,
      title: n.title,
      trashed: null,
      template: false,
    })),
  );
  const existing =
    extra.untitled === undefined
      ? base
      : addUntitledIdentities(base, extra.untitled);
  return {
    existing,
    inboundLinks: new Map(
      Object.entries(links).map(([k, v]) => [k, new Set(v)]),
    ),
    importLabel: LABEL,
  };
}

describe("Myne source conflict rules", () => {
  it("creates a source note whose title the target does not have", () => {
    const out = decideMyneImport(ctx([]), {
      folder: null,
      title: "Project",
      bodyHash: "h1",
    });
    expect(out).toEqual({ kind: "create", renamedTitle: null });
  });

  it("skips a colliding note that nothing imported links to", () => {
    // The target already has a note by this name and no imported link cares
    // which one it is, so the old behaviour is still the right one.
    const out = decideMyneImport(ctx([{ folder: null, title: "Beta" }]), {
      folder: null,
      title: "Beta",
      bodyHash: "h1",
    });
    expect(out).toEqual({ kind: "skip" });
  });

  it("renames a colliding note that an imported note DOES link to", () => {
    // The hazard the whole rule exists for: under the old skip behaviour the
    // imported `[[Beta]]` would resolve to the TARGET's Beta, silently and with
    // no ambiguity to warn about.
    const out = decideMyneImport(
      ctx([{ folder: null, title: "Beta" }], { beta: ["note-a"] }),
      { folder: null, title: "Beta", bodyHash: "h1" },
    );
    expect(out).toEqual({ kind: "create", renamedTitle: `Beta (${LABEL})` });
  });

  it("uses the folded title to look up inbound links", () => {
    // The graph is keyed with the SAME fold the resolver uses, so a link
    // written `[[BETA]]` still finds the note titled "Beta".
    const out = decideMyneImport(
      ctx([{ folder: null, title: "Beta" }], { beta: ["note-a"] }),
      { folder: null, title: "BETA", bodyHash: "h1" },
    );
    expect(out.kind).toBe("create");
  });

  it("is idempotent: a second run with the same label skips what it renamed", () => {
    // Run one renamed "Beta" to "Beta (Eski laptop)". Run two sees BOTH in the
    // target. Without the second identity check, or with a counter instead of a
    // stable label, this would create "Beta (Eski laptop)" again on every run.
    const afterFirstRun = ctx(
      [
        { folder: null, title: "Beta" },
        { folder: null, title: `Beta (${LABEL})` },
      ],
      { beta: ["note-a"] },
    );
    const out = decideMyneImport(afterFirstRun, {
      folder: null,
      title: "Beta",
      bodyHash: "h1",
    });
    expect(out).toEqual({ kind: "skip" });
  });

  it("a different label is NOT idempotent with the previous run", () => {
    // Stated as a test rather than left implicit, because it is the cost the
    // setup step has to disclose: the label is what makes a repeat safe.
    const afterFirstRun: MyneConflictContext = {
      ...ctx(
        [
          { folder: null, title: "Beta" },
          { folder: null, title: `Beta (${LABEL})` },
        ],
        { beta: ["note-a"] },
      ),
      importLabel: "Different",
    };
    const out = decideMyneImport(afterFirstRun, {
      folder: null,
      title: "Beta",
      bodyHash: "h1",
    });
    expect(out).toEqual({ kind: "create", renamedTitle: "Beta (Different)" });
  });

  it("treats the folder as part of the identity", () => {
    // A "Beta" in Work does not collide with a "Beta" at the root.
    const out = decideMyneImport(ctx([{ folder: "Work", title: "Beta" }]), {
      folder: null,
      title: "Beta",
      bodyHash: "h1",
    });
    expect(out).toEqual({ kind: "create", renamedTitle: null });
  });

  describe("untitled notes", () => {
    it("creates an untitled note the target does not already hold", () => {
      const out = decideMyneImport(ctx([]), {
        folder: null,
        title: null,
        bodyHash: "body-1",
      });
      expect(out).toEqual({ kind: "create", renamedTitle: null });
    });

    it("dedups an untitled note by its body on a re-import", () => {
      // The whole reason the body hash exists: without it these accumulate,
      // one fresh pile per run, with nothing to stop it.
      const out = decideMyneImport(
        ctx([], {}, { untitled: [{ folder: null, bodyHash: "body-1" }] }),
        { folder: null, title: null, bodyHash: "body-1" },
      );
      expect(out).toEqual({ kind: "skip" });
    });

    it("does not dedup two untitled notes with different bodies", () => {
      const out = decideMyneImport(
        ctx([], {}, { untitled: [{ folder: null, bodyHash: "body-1" }] }),
        { folder: null, title: null, bodyHash: "body-2" },
      );
      expect(out).toEqual({ kind: "create", renamedTitle: null });
    });

    it("keys an untitled note where no titled note can reach", () => {
      // The namespace claim, asserted rather than assumed: a titled note can
      // never produce the untitled key, whatever its title.
      const untitled = untitledIdentityKey(null, "body-1");
      expect(noteIdentityKey(null, `untitled:body-1`)).not.toBe(untitled);
      expect(noteIdentityKey(null, " untitled:body-1")).not.toBe(untitled);
    });
  });

  describe("renamedTitleFor", () => {
    it("is deterministic in both arguments", () => {
      expect(renamedTitleFor("Beta", LABEL)).toBe(renamedTitleFor("Beta", LABEL));
      expect(renamedTitleFor("Beta", LABEL)).toBe(`Beta (${LABEL})`);
    });

    it("leaves the title alone when the label is empty or blank", () => {
      // "Beta ()" would be worse than the collision it disambiguates.
      expect(renamedTitleFor("Beta", "")).toBe("Beta");
      expect(renamedTitleFor("Beta", "   ")).toBe("Beta");
    });
  });
});

describe("untitled body identity", () => {
  it("ignores frontmatter, because the two sides do not see the same frontmatter", () => {
    // The candidate side hashes the MAPPED plaintext, which may have had a
    // `folder:` line injected; the target side hashes what a previous run
    // stored. Hashing the whole note would make those differ for the same note
    // and the dedup would silently never fire.
    const stored = "---\ntitle: null\nfolder: Work/\n---\n\nThe body.\n";
    const mapped = "---\nfolder: Work/\n---\n\nThe body.\n";
    expect(bodyForIdentity(stored)).toBe(bodyForIdentity(mapped));
    expect(hashBodyForIdentity(stored)).toBe(hashBodyForIdentity(mapped));
  });

  it("still separates two different bodies", () => {
    expect(hashBodyForIdentity("---\na: 1\n---\n\nOne.\n")).not.toBe(
      hashBodyForIdentity("---\na: 1\n---\n\nTwo.\n"),
    );
  });

  it("handles a note with no frontmatter at all", () => {
    expect(bodyForIdentity("Just a body.\n")).toBe("Just a body.\n");
  });
});
