// Importer read-seam suite (MYND-579/580, importer-breadth epic).
//
// Pins the `importer:` read-seam through the PRODUCTION binary — the narrow,
// within-root-validated pair (`import_read_dir` / `import_read_file`) that is the
// ONLY path by which the WebView reads an external directory (SYNC-1, ratified
// 2026-06-08; no general `fs:allow-read-text-file` is granted). Every import
// adapter in the epic rests on exactly these two commands, so their real-IPC
// behaviour — and their refusals — are the boundary worth pinning.
//
// WHY THIS SUITE AND NOT AN IMPORT-FLOW SUITE (the asserted-vs-deferred split):
// the import flow itself is not E2E-reachable through the current harness, for two
// independent reasons that both predate this epic —
//   1. `ObsidianImportModal.tsx` carries ZERO `data-testid` attributes, so the
//      modal is invisible to the driver (`src/AGENTS.md`: "a screen without
//      testids is invisible to E2E"). Adding that testid pass belongs with the
//      entry-point generalization (MYND-586), which rewrites those surfaces.
//   2. The import ENGINE is WebView-side TypeScript reached only through a native
//      folder dialog, which WebDriver cannot drive (the `vault-export` suite's
//      documented constraint) — and unlike export, there is no Tauri command to
//      invoke from the page seat, because the engine is not on the Rust side.
// So the engine + converter stay Vitest-pinned (`tests/notes/import-source.test.ts`,
// `tests/notes/import/*`), and what this suite adds is the one layer those cannot
// reach: the real Rust seam over a real on-disk fixture, through production IPC.
//
// The security assertions here are the load-bearing half. `validate_within_root`
// is Rust-unit-tested, but never before at the IPC boundary the WebView actually
// calls — and a note body is UNTRUSTED imported content, so a crafted path
// escaping the picked root is the threat this seam exists to refuse.

import { expect, it } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { describeE2E, scenario } from "./support/scenario";
import { seedVault } from "./support/fixtures";
import { dismissImporterOffer, pageSeatInvoke, unlockToEditor } from "./support/flows";

interface DirEntry {
  name: string;
  is_dir: boolean;
  link: { status: string; target_key?: string } | null;
}

/** Build a small Obsidian-shaped source tree; returns its absolute root. */
function writeSourceTree(base: string): string {
  const root = path.join(base, "importer-seam-fixture");
  fs.mkdirSync(path.join(root, "Projects"), { recursive: true });
  fs.mkdirSync(path.join(root, ".obsidian"), { recursive: true });
  fs.writeFileSync(path.join(root, "Top.md"), "# Top\n\nbody\n", "utf8");
  fs.writeFileSync(path.join(root, "Projects", "Nested.md"), "# Nested\n", "utf8");
  fs.writeFileSync(path.join(root, "sketch.canvas"), "{}", "utf8");
  fs.writeFileSync(path.join(root, ".obsidian", "app.json"), "{}", "utf8");
  // A non-UTF-8 file: the seam must refuse it rather than hand back mojibake.
  fs.writeFileSync(path.join(root, "binary.md"), Buffer.from([0xff, 0xfe, 0x00, 0x41]));
  return root;
}

describeE2E("irs1 importer read-seam over a real tree (MYND-579)", () => {
  // Vault-count precondition: 1 (weak KDF).
  it("lists entries, reads UTF-8 bytes, and refuses every escape", async () => {
    let password = "";
    await scenario(
      "irs1-read-seam",
      { seed: (dir) => void (password = seedVault(dir).password) },
      async (app) => {
        const s = app.session;
        await unlockToEditor(s, password);
        await dismissImporterOffer(s);

        const root = writeSourceTree(app.dataHome);

        // ---- read_dir: entries only, name + is_dir, no content ----
        const listed = await pageSeatInvoke(
          s,
          "plugin:importer|import_read_dir",
          { root, path: root },
          30_000,
        );
        if (listed.err !== undefined) {
          throw new Error("read_dir failed: " + JSON.stringify(listed.err));
        }
        const entries = listed.ok as DirEntry[];
        const byName = new Map(entries.map((e) => [e.name, e.is_dir]));
        expect(byName.get("Top.md")).toBe(false);
        expect(byName.get("Projects")).toBe(true);
        expect(byName.get("sketch.canvas")).toBe(false);
        // Dot-entries are returned by the seam; classification (skipping them) is
        // the TS predicate's job, not the host's — pin that division of labour.
        expect(byName.get(".obsidian")).toBe(true);

        // Recursion works through a subdirectory, still within root.
        const sub = await pageSeatInvoke(
          s,
          "plugin:importer|import_read_dir",
          { root, path: path.join(root, "Projects") },
          30_000,
        );
        expect((sub.ok as DirEntry[]).map((e) => e.name)).toEqual(["Nested.md"]);

        // ---- read_file: exact UTF-8 bytes, no rewriting ----
        const read = await pageSeatInvoke(
          s,
          "plugin:importer|import_read_file",
          { root, path: path.join(root, "Top.md") },
          30_000,
        );
        expect(read.ok).toBe("# Top\n\nbody\n");

        // Non-UTF-8 is a typed refusal, never lossy decoding.
        const notUtf8 = await pageSeatInvoke(
          s,
          "plugin:importer|import_read_file",
          { root, path: path.join(root, "binary.md") },
          30_000,
        );
        expect(notUtf8.err).toBeDefined();

        // ---- the refusals: this is why the seam exists (SYNC-1 / TB6) ----

        // A `..` traversal out of the picked root.
        const traversal = await pageSeatInvoke(
          s,
          "plugin:importer|import_read_file",
          { root, path: path.join(root, "..", "escaped.md") },
          30_000,
        );
        expect(traversal.err).toBeDefined();

        // An absolute path outside the root entirely.
        const outside = await pageSeatInvoke(
          s,
          "plugin:importer|import_read_dir",
          { root, path: app.dataHome },
          30_000,
        );
        expect(outside.err).toBeDefined();

        // A sibling whose name merely PREFIXES the root must not pass as a child
        // (component-wise containment, not string prefix).
        const lookalike = `${root}-evil`;
        fs.mkdirSync(lookalike, { recursive: true });
        fs.writeFileSync(path.join(lookalike, "x.md"), "x", "utf8");
        const sibling = await pageSeatInvoke(
          s,
          "plugin:importer|import_read_file",
          { root, path: path.join(lookalike, "x.md") },
          30_000,
        );
        expect(sibling.err).toBeDefined();

        // A relative path is rejected outright (both args must be absolute).
        const relative = await pageSeatInvoke(
          s,
          "plugin:importer|import_read_file",
          { root, path: "Top.md" },
          30_000,
        );
        expect(relative.err).toBeDefined();

        // A symlink inside the root whose target escapes it canonicalizes outside
        // and is refused — the reason the seam canonicalizes before comparing.
        const secret = path.join(app.dataHome, "outside-secret.md");
        fs.writeFileSync(secret, "secret\n", "utf8");
        const link = path.join(root, "link.md");
        try {
          fs.symlinkSync(secret, link);
          const viaLink = await pageSeatSafeRead(s, root, link);
          expect(viaLink.err).toBeDefined();
        } catch (e) {
          // Symlink creation can be unavailable (permissions); the other refusals
          // already cover the boundary, so skip rather than fail on the platform.
          if ((e as NodeJS.ErrnoException).code !== "EPERM") throw e;
        }
      },
    );
  });
});

/** Read through the seam, named so the symlink assertion above reads clearly. */
async function pageSeatSafeRead(
  s: Parameters<typeof pageSeatInvoke>[0],
  root: string,
  target: string,
): Promise<{ ok?: unknown; err?: unknown }> {
  return pageSeatInvoke(
    s,
    "plugin:importer|import_read_file",
    { root, path: target },
    30_000,
  );
}

// myne-md/myne#223 defect 1. `DirEntry::file_type()` does not follow symlinks,
// so a symlinked FOLDER reported `is_dir: false`, the TS walk classified it by
// NAME, and its whole subtree was silently absent from the import behind a
// muted "other files skipped 1". The host now resolves the link and says what
// it is; a Rust unit test pins the classifier, and this pins that the verdict
// actually crosses production IPC in that shape.
describeE2E("irs2 importer read-seam resolves symlinks (myne-md/myne#223)", () => {
  // Vault-count precondition: 1 (weak KDF).
  it("reports a symlinked folder as a folder and names each refusal", async () => {
    let password = "";
    await scenario(
      "irs2-symlink-seam",
      { seed: (dir) => void (password = seedVault(dir).password) },
      async (app) => {
        const s = app.session;
        await unlockToEditor(s, password);
        await dismissImporterOffer(s);

        const root = path.join(app.dataHome, "importer-symlink-fixture");
        const real = path.join(root, "Real");
        const outside = path.join(app.dataHome, "outside-tree");
        fs.mkdirSync(real, { recursive: true });
        fs.mkdirSync(outside, { recursive: true });
        fs.writeFileSync(path.join(real, "Nested.md"), "# Nested\n", "utf8");
        fs.writeFileSync(path.join(root, "target.md"), "# Target\n", "utf8");

        try {
          fs.symlinkSync(real, path.join(root, "External"));
          fs.symlinkSync(outside, path.join(root, "Elsewhere"));
          fs.symlinkSync(root, path.join(real, "BackToRoot"));
          fs.symlinkSync(path.join(root, "target.md"), path.join(root, "alias.md"));
          fs.symlinkSync(path.join(app.dataHome, "gone-forever"), path.join(root, "dangling"));
        } catch (e) {
          // Symlink creation can be unavailable (permissions). Skip rather than
          // fail on the platform — irs1 already covers the seam's refusals.
          if ((e as NodeJS.ErrnoException).code !== "EPERM") throw e;
          return;
        }

        const listed = await pageSeatInvoke(
          s,
          "plugin:importer|import_read_dir",
          { root, path: root },
          30_000,
        );
        if (listed.err !== undefined) {
          throw new Error("read_dir failed: " + JSON.stringify(listed.err));
        }
        const byName = new Map((listed.ok as DirEntry[]).map((e) => [e.name, e]));

        // The headline: a symlinked folder walks as a folder.
        expect(byName.get("External")?.is_dir).toBe(true);
        expect(byName.get("External")?.link?.status).toBe("followable");
        // The identity the walk's cycle guard keys on — opaque, never a path.
        const key = byName.get("External")?.link?.target_key ?? "";
        expect(key).toHaveLength(32);
        expect(key.includes("/")).toBe(false);

        // A symlinked FILE resolves too, and is not a directory.
        expect(byName.get("alias.md")?.is_dir).toBe(false);
        expect(byName.get("alias.md")?.link?.status).toBe("followable");

        // The refusals are each NAMED rather than folded into a skip bucket.
        expect(byName.get("Elsewhere")?.link?.status).toBe("outside");
        expect(byName.get("Elsewhere")?.is_dir).toBe(false);
        expect(byName.get("dangling")?.link?.status).toBe("broken");

        // A link back to an ancestor is a loop — decided against the directory
        // being listed, so it only shows up one level down.
        const nested = await pageSeatInvoke(
          s,
          "plugin:importer|import_read_dir",
          { root, path: real },
          30_000,
        );
        const nestedByName = new Map((nested.ok as DirEntry[]).map((e) => [e.name, e]));
        expect(nestedByName.get("BackToRoot")?.link?.status).toBe("loop");
        expect(nestedByName.get("BackToRoot")?.is_dir).toBe(false);

        // An ordinary entry carries no link at all — the common path is untouched.
        expect(byName.get("target.md")?.link).toBeNull();
        expect(nestedByName.get("Nested.md")?.link).toBeNull();
      },
    );
  });
});
