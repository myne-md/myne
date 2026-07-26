// Notion export import source (importer-breadth epic, MYND-583).
//
// UNZIP-FIRST: this adapter reads an ALREADY-EXTRACTED export directory. No zip
// capability is added. The vetted in-tree `zip` usage reads one fixed member by name
// and never enumerates entries; a Notion import needs the inverse, which would make
// slip-guarding, entry-count caps, and inflation caps load-bearing for the first time
// in this codebase — new security code to save one double-click. In-app extraction is
// a tracked follow-up whose evidence trigger is Windows `MAX_PATH` failures on deep
// unzipped trees. (Grill 2026-07-25 Q6.)
//
// EXPORT LAYOUT (Export all → Markdown & CSV):
//
//   Export-<uuid>/
//   ├── Page Title <32hex>.md          ← a page → 1 note
//   ├── Page Title <32hex>/            ← its children + assets
//   │   ├── Child Page <32hex>.md      ← → 1 note
//   │   └── image.png
//   ├── My Database <32hex>.csv        ← the property TABLE (1 file)
//   └── My Database <32hex>/           ← one .md per database ROW
//       ├── Row One <32hex>.md         ← → 1 note
//       └── Row Two <32hex>.md         ← → 1 note
//
// A database ROW IS ALREADY ITS OWN `.md` PAGE FILE, so rows import through the
// ordinary markdown path — there is no per-row CSV parsing anywhere in this adapter.
// The `.csv` is one ADDITIONAL file, and it becomes one table note whose title column
// links out, i.e. a navigable index over the row-notes rather than a duplicate of
// them. One extra note per database, not per row. (Grill N1/Q11.)

import { csvToTableMarkdown } from "../csv/toTable";
import { htmlToMarkdown } from "../html";
import {
  buildResolution,
  stripNotionId,
  stripNotionPath,
  type NotionResolution,
} from "../notion/names";
import {
  liftProperties,
  propertiesToFrontmatter,
  rewriteLinks,
} from "../notion/transform";
import { emptyIgnoreCounts } from "../skipPredicate";
import {
  joinPath,
  type ImportDirEntry,
  type ImportItemRef,
  type ImportPlan,
  type ImportPorts,
  type ImportSource,
  type LoadedItem,
} from "../source";

type Kind = "md" | "html" | "csv";

interface Handle {
  /** The real on-disk relative path. */
  real: string;
  kind: Kind;
  /** Directory the file sits in, for relative-link resolution. */
  dir: string;
}

/** Classify a Notion export entry. Everything else is media or noise. */
function classify(name: string): Kind | null {
  if (/\.md$/i.test(name)) return "md";
  if (/\.html?$/i.test(name)) return "html";
  if (/\.csv$/i.test(name)) return "csv";
  return null;
}

/** `Title.md` display path with every segment de-suffixed. */
function displayPath(rel: string, kind: Kind): string {
  const stripped = stripNotionPath(rel).replace(/\.[^.]+$/, "");
  // A database's table note is a sibling of its row folder; name it distinctly so it
  // cannot collide with a same-named page.
  return kind === "csv" ? `${stripped} (table).md` : `${stripped}.md`;
}

/** An `ImportSource` over an unzipped Notion export rooted at `root`. */
export function createNotionSource(root: string, ports: ImportPorts): ImportSource {
  let resolution: NotionResolution = { byPath: new Map(), byBasename: new Map() };

  return {
    id: "notion",

    async plan(): Promise<ImportPlan> {
      const items: ImportItemRef[] = [];
      const dirs: string[] = [];
      const ignore = emptyIgnoreCounts();
      const pagePaths: string[] = [];

      const walk = async (relDir: string): Promise<void> => {
        let entries: ImportDirEntry[];
        try {
          entries = await ports.readDir(joinPath(root, relDir));
        } catch {
          return;
        }
        for (const entry of entries) {
          const rel = relDir.length === 0 ? entry.name : `${relDir}/${entry.name}`;
          if (entry.name.startsWith(".")) {
            ignore.hiddenIgnored++;
            continue;
          }
          if (entry.isDir) {
            dirs.push(stripNotionPath(rel));
            await walk(rel);
            continue;
          }
          const kind = classify(entry.name);
          if (kind === null) {
            ignore.nonMarkdownSkipped++; // media: referenced by a page, not a note
            continue;
          }
          // Only PAGE files participate in link resolution — a `.csv` is not a
          // link target, and registering it would shadow its row folder.
          if (kind !== "csv") pagePaths.push(rel);
          const handle: Handle = { real: rel, kind, dir: relDir };
          items.push({ relPath: displayPath(rel, kind), handle });
        }
      };
      await walk("");

      resolution = buildResolution(pagePaths);
      return { items, dirs, ignore };
    },

    async load(ref: ImportItemRef): Promise<LoadedItem> {
      const handle = ref.handle as Handle;
      const raw = await ports.readFile(joinPath(root, handle.real));
      const lossy = new Set<string>();

      if (handle.kind === "csv") {
        // The title column (column 0) links out to the row-note of the same name,
        // which is what turns a duplicate table into an index over the rows.
        const { markdown, lossy: csvLossy } = csvToTableMarkdown(raw, (cell, col, row) => {
          if (col !== 0 || row === 0 || cell.length === 0) return cell;
          return `[[${stripNotionId(cell)}]]`;
        });
        for (const l of csvLossy) lossy.add(l);
        return { markdown, lossy: [...lossy].sort() };
      }

      let body = raw;
      if (handle.kind === "html") {
        const converted = await htmlToMarkdown(raw, "html");
        body = converted.markdown;
        for (const l of converted.lossy) lossy.add(l);
      }

      // Properties → frontmatter. The plain-text block stays in the body verbatim.
      const { properties } = liftProperties(body);
      const { lines, rejected } = propertiesToFrontmatter(properties);
      if (rejected.length > 0) lossy.add("notion-property-name-illegal");

      const { body: linked, unresolved } = rewriteLinks(
        body,
        resolution,
        stripNotionPath(handle.dir),
      );
      if (unresolved > 0) lossy.add("notion-unresolved-link");

      // Frontmatter is prepended as a block the shared mapping seam then extends
      // with its own Myne-managed `folder:` / `title:` fields.
      const markdown =
        lines.length > 0 ? `---\n${lines.join("\n")}\n---\n\n${linked}` : linked;

      return { markdown, lossy: [...lossy].sort() };
    },
  };
}
