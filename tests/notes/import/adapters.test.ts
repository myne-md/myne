// @vitest-environment jsdom
//
// The four import adapters (MYND-581 Evernote / 582 HTML / 583 Notion / 584 CSV) +
// the generated import-report note (MYND-585).
//
// jsdom is required for the three HTML-ish adapters: they go through `DOMParser` and
// DOMPurify. CSV needs neither but shares the file.

import { describe, expect, it } from "vitest";
import { importFromSource } from "../../../src/notes/import/engine";
import { createCsvSource } from "../../../src/notes/import/sources/csv";
import { createHtmlSource } from "../../../src/notes/import/sources/html";
import { createNotionSource } from "../../../src/notes/import/sources/notion";
import {
  createEnexSource,
  decodeBase64,
  enexNoteTitle,
  MAX_ENEX_BYTES,
  EnexTooLargeError,
} from "../../../src/notes/import/sources/enex";
import { parseCsv } from "../../../src/notes/import/csv/parseCsv";
import { csvToTableMarkdown, MAX_CSV_ROWS } from "../../../src/notes/import/csv/toTable";
import {
  buildResolution,
  resolveTarget,
  stripNotionId,
  stripNotionPath,
} from "../../../src/notes/import/notion/names";
import {
  liftProperties,
  propertiesToFrontmatter,
  rewriteLinks,
} from "../../../src/notes/import/notion/transform";
import { buildImportReport, formatStamp, reportTitle } from "../../../src/notes/import/report";
import type { ImportPorts, ImportSink } from "../../../src/notes/import/source";
import type { ImportedAttachment } from "../../../src/editor/attachments/insert";

const HEX = "1a2b3c4d5e6f7890abcdef1234567890";

function fakePorts(tree: Record<string, string[]>, files: Record<string, string>): ImportPorts {
  return {
    async readDir(abs) {
      const entries = tree[abs];
      if (entries === undefined) throw new Error(`no dir ${abs}`);
      return entries.map((n) => ({
        name: n.replace(/\/$/, ""),
        isDir: n.endsWith("/"),
        link: null,
      }));
    },
    async readFile(abs) {
      const f = files[abs];
      if (f === undefined) throw new Error(`no file ${abs}`);
      return f;
    },
    async createNote() {
      return "id";
    },
    async setDeliberateFolders() {},
  };
}

function recordingSink(): ImportSink & { created: string[] } {
  const created: string[] = [];
  return {
    created,
    async createNote(p) {
      created.push(p);
      return `id-${created.length}`;
    },
    async setDeliberateFolders() {},
  };
}

// ── CSV (MYND-584) ───────────────────────────────────────────────────────────

describe("CSV parser", () => {
  it("parses plain rows", () => {
    expect(parseCsv("a,b\n1,2")).toEqual([
      ["a", "b"],
      ["1", "2"],
    ]);
  });

  it("honours quoted fields with embedded commas and newlines", () => {
    expect(parseCsv('a,b\n"x,y","line1\nline2"')).toEqual([
      ["a", "b"],
      ["x,y", "line1\nline2"],
    ]);
  });

  it('unescapes the "" sequence', () => {
    expect(parseCsv('a\n"say ""hi"""')).toEqual([["a"], ['say "hi"']]);
  });

  it("handles CRLF and a trailing newline without an empty row", () => {
    expect(parseCsv("a,b\r\n1,2\r\n")).toEqual([
      ["a", "b"],
      ["1", "2"],
    ]);
  });

  it("strips a UTF-8 BOM from the first header cell", () => {
    expect(parseCsv("﻿Name,Age\nA,1")[0]).toEqual(["Name", "Age"]);
  });

  it("keeps a partial field when a quote is never closed, rather than losing it", () => {
    expect(parseCsv('a\n"unterminated')).toEqual([["a"], ["unterminated"]]);
  });
});

describe("CSV → table note", () => {
  it("promotes row 1 to the header and emits a GFM table", () => {
    const { markdown, rows } = csvToTableMarkdown("Name,Status\nAlpha,Done");
    expect(markdown).toBe("| Name | Status |\n| --- | --- |\n| Alpha | Done |");
    expect(rows).toBe(1);
  });

  it("truncates past the row cap and REPORTS it (never silently)", () => {
    const body = Array.from({ length: MAX_CSV_ROWS + 50 }, (_, i) => `r${i},v`).join("\n");
    const { lossy, rows } = csvToTableMarkdown(`h1,h2\n${body}`);
    expect(rows).toBe(MAX_CSV_ROWS);
    expect(lossy).toContain("csv-rows-truncated");
  });

  it("reports an empty file rather than emitting an empty table", () => {
    expect(csvToTableMarkdown("").lossy).toContain("empty-csv");
  });

  it("imports one CSV as exactly ONE note, not one per row", async () => {
    const ports = fakePorts({}, { "/x/data.csv": "a,b\n1,2\n3,4\n5,6" });
    const sink = recordingSink();
    const result = await importFromSource(
      createCsvSource("/x/data.csv", ports),
      sink,
      new Set(),
      "skip",
    );
    // Three data rows, one note — the vision.md no-databases commitment.
    expect(result.imported).toBe(1);
    expect(sink.created).toHaveLength(1);
    expect(sink.created[0]).toContain("| a | b |");
  });
});

// ── generic HTML (MYND-582) ──────────────────────────────────────────────────

describe("HTML adapter", () => {
  it("plans .html/.htm files and skips everything else", async () => {
    const ports = fakePorts(
      {
        "/h": ["a.html", "b.htm", "c.txt", "img.png", "sub/", ".hidden"],
        "/h/sub": ["d.html"],
      },
      {},
    );
    const plan = await createHtmlSource("/h", ports).plan();
    expect(plan.items.map((i) => i.relPath).sort()).toEqual([
      "a.md",
      "b.md",
      "sub/d.md",
    ]);
    expect(plan.ignore.nonMarkdownSkipped).toBe(2);
    expect(plan.ignore.hiddenIgnored).toBe(1);
    expect(plan.dirs).toEqual(["sub"]);
  });

  it("keeps the .html extension out of the note title (display path)", async () => {
    const ports = fakePorts({ "/h": ["report.html"] }, { "/h/report.html": "<h1>R</h1>" });
    const sink = recordingSink();
    await importFromSource(createHtmlSource("/h", ports), sink, new Set(), "skip");
    expect(sink.created[0]).toContain("title: report");
    expect(sink.created[0]).not.toContain("report.html");
  });

  it("converts the document body to markdown", async () => {
    const ports = fakePorts(
      { "/h": ["p.html"] },
      { "/h/p.html": "<h1>T</h1><p><strong>b</strong></p><ul><li>x</li></ul>" },
    );
    const sink = recordingSink();
    await importFromSource(createHtmlSource("/h", ports), sink, new Set(), "skip");
    expect(sink.created[0]).toContain("# T");
    expect(sink.created[0]).toContain("**b**");
    expect(sink.created[0]).toContain("- x");
  });

  it("survives an unreadable subtree with fewer items instead of failing", async () => {
    const ports = fakePorts({ "/h": ["ok.html", "bad/"] }, { "/h/ok.html": "<p>y</p>" });
    const plan = await createHtmlSource("/h", ports).plan();
    expect(plan.items.map((i) => i.relPath)).toEqual(["ok.md"]);
  });
});

// ── Evernote (MYND-581) ──────────────────────────────────────────────────────

const ENEX = (notes: string): string =>
  '<?xml version="1.0" encoding="UTF-8"?>' +
  '<!DOCTYPE en-export SYSTEM "http://xml.evernote.com/pub/evernote-export3.dtd">' +
  `<en-export>${notes}</en-export>`;

/** A stored-attachment payload for the bytes seam, defaulted to the
 *  no-compression shape (`original_size` absent) so a test that cares only
 *  about the rewrite says nothing about compression. */
function ingestedAttachment(over: Partial<ImportedAttachment> = {}): ImportedAttachment {
  return {
    id: "deadbeef",
    content_type: "image/png",
    filename: "pic.png",
    size: 2,
    created_at: 0,
    deduplicated: false,
    ...over,
  };
}

describe("Evernote adapter", () => {
  it("turns ONE file into N notes (the shape the walk could not express)", async () => {
    const ports = fakePorts(
      {},
      {
        "/e/x.enex": ENEX(
          "<note><title>First</title><content><![CDATA[<en-note><div>one</div></en-note>]]></content></note>" +
            "<note><title>Second</title><content><![CDATA[<en-note><div>two</div></en-note>]]></content></note>",
        ),
      },
    );
    const sink = recordingSink();
    const result = await importFromSource(
      createEnexSource("/e/x.enex", ports),
      sink,
      new Set(),
      "skip",
    );
    expect(result.total).toBe(2);
    expect(result.imported).toBe(2);
    expect(sink.created[0]).toContain("title: First");
    expect(sink.created[1]).toContain("two");
  });

  it("refuses an oversize export instead of risking an OOM mid-migration", async () => {
    const huge = "x".repeat(MAX_ENEX_BYTES + 1);
    const ports = fakePorts({}, { "/e/big.enex": huge });
    await expect(createEnexSource("/e/big.enex", ports).plan()).rejects.toBeInstanceOf(
      EnexTooLargeError,
    );
  });

  it("PRESERVES an <en-crypt> block verbatim and reports it", async () => {
    const cipher = "QzNCTVFRPT0=";
    const ports = fakePorts(
      {},
      {
        "/e/c.enex": ENEX(
          "<note><title>Secret</title><content><![CDATA[<en-note>" +
            `<div>before</div><en-crypt cipher="AES" hint="my hint">${cipher}</en-crypt>` +
            "</en-note>]]></content></note>",
        ),
      },
    );
    const src = createEnexSource("/e/c.enex", ports);
    await src.plan();
    const loaded = await src.load({ relPath: "Secret.md", handle: 0 });
    // The ciphertext must still be there — never destroy bytes you cannot interpret.
    expect(loaded.markdown).toContain(cipher);
    expect(loaded.markdown).toContain("my hint");
    expect(loaded.lossy).toContain("evernote-encrypted-block");
  });

  it("ingests a base64 resource through the bytes seam when one is wired", async () => {
    const ports = fakePorts(
      {},
      {
        "/e/m.enex": ENEX(
          "<note><title>WithMedia</title>" +
            '<content><![CDATA[<en-note><en-media type="image/png" hash="abc"/></en-note>]]></content>' +
            '<resource><data encoding="base64" hash="abc">aGk=</data>' +
            "<resource-attributes><file-name>pic.png</file-name></resource-attributes></resource>" +
            "</note>",
        ),
      },
    );
    const src = createEnexSource("/e/m.enex", ports, {
      ingestBytes: async (bytes, filename) => {
        expect(new TextDecoder().decode(bytes)).toBe("hi");
        expect(filename).toBe("pic.png");
        return ingestedAttachment({ id: "deadbeef", filename });
      },
    });
    await src.plan();
    const loaded = await src.load({ relPath: "WithMedia.md", handle: 0 });
    expect(loaded.markdown).toContain("att:deadbeef");
    expect(loaded.lossy).not.toContain("evernote-attachment");
  });

  // `decisions.md` 2026-07-30 makes disclosure at import the thing that stands
  // in for a consent gate, and a bulk route is where discarded pixels would be
  // LEAST noticed. Evernote is the one source that ingests through the bytes
  // seam instead of the engine's media port, so its tally has to travel out of
  // `load()` or the import summary reports nothing at all.
  it("reports what ingest-time compression did to its resources", async () => {
    const ports = fakePorts(
      {},
      {
        "/e/c.enex": ENEX(
          "<note><title>Shrunk</title>" +
            '<content><![CDATA[<en-note><en-media type="image/png" hash="abc"/></en-note>]]></content>' +
            '<resource><data encoding="base64" hash="abc">aGk=</data>' +
            "<resource-attributes><file-name>pic.png</file-name></resource-attributes></resource>" +
            "</note>",
        ),
      },
    );
    const src = createEnexSource("/e/c.enex", ports, {
      ingestBytes: async (_bytes, filename) =>
        ingestedAttachment({
          id: "deadbeef",
          filename,
          size: 40_000,
          original_size: 150_000,
          container_changed: true,
        }),
    });
    const sink = recordingSink();
    const result = await importFromSource(src, sink, new Set(), "skip");
    expect(result.compression).toEqual({
      count: 1,
      originalBytes: 150_000,
      finalBytes: 40_000,
    });
  });

  it("reports a zero tally when its resources were stored untouched", async () => {
    const ports = fakePorts(
      {},
      {
        "/e/u.enex": ENEX(
          "<note><title>Untouched</title>" +
            '<content><![CDATA[<en-note><en-media type="image/png" hash="abc"/></en-note>]]></content>' +
            '<resource><data encoding="base64" hash="abc">aGk=</data>' +
            "<resource-attributes><file-name>pic.png</file-name></resource-attributes></resource>" +
            "</note>",
        ),
      },
    );
    const src = createEnexSource("/e/u.enex", ports, {
      ingestBytes: async (_bytes, filename) => ingestedAttachment({ id: "deadbeef", filename }),
    });
    const result = await importFromSource(src, recordingSink(), new Set(), "skip");
    expect(result.compression).toEqual({ count: 0, originalBytes: 0, finalBytes: 0 });
  });

  it("falls back to a reported placeholder when no ingestor is wired", async () => {
    const ports = fakePorts(
      {},
      {
        "/e/m.enex": ENEX(
          "<note><title>NoIngest</title>" +
            '<content><![CDATA[<en-note><en-media type="image/png" hash="abc"/></en-note>]]></content>' +
            '<resource><data encoding="base64" hash="abc">aGk=</data>' +
            "<resource-attributes><file-name>pic.png</file-name></resource-attributes></resource>" +
            "</note>",
        ),
      },
    );
    const src = createEnexSource("/e/m.enex", ports);
    await src.plan();
    const loaded = await src.load({ relPath: "NoIngest.md", handle: 0 });
    expect(loaded.markdown).toContain("omitted attachment: pic.png");
    expect(loaded.lossy).toContain("evernote-attachment");
  });

  it("names an untitled note deterministically", () => {
    expect(enexNoteTitle(null, 0)).toBe("Untitled note 1");
    expect(enexNoteTitle("  ", 4)).toBe("Untitled note 5");
  });

  it("strips path separators from a title so it cannot forge folders", () => {
    expect(enexNoteTitle("a/b\\c", 0)).toBe("a-b-c");
  });

  it("decodes base64 and tolerates the newlines Evernote wraps data with", () => {
    expect(new TextDecoder().decode(decodeBase64("aGk=")!)).toBe("hi");
    expect(new TextDecoder().decode(decodeBase64("aG\nki\nRz")!)).toBeTruthy();
    expect(decodeBase64("   ")).toBeNull();
  });
});

// ── Notion (MYND-583) ────────────────────────────────────────────────────────

describe("Notion naming", () => {
  it("strips the 32-hex suffix from a segment", () => {
    expect(stripNotionId(`Page Title ${HEX}.md`)).toBe("Page Title.md");
  });

  it("strips it from every path segment", () => {
    expect(stripNotionPath(`Parent ${HEX}/Child ${HEX}.md`)).toBe("Parent/Child.md");
  });

  it("leaves a non-Notion name alone", () => {
    expect(stripNotionId("ordinary name.md")).toBe("ordinary name.md");
  });

  it("resolves a URL-encoded sibling link to its de-suffixed title", () => {
    const res = buildResolution([`Notes ${HEX}/Child Page ${HEX}.md`]);
    const target = encodeURIComponent(`Child Page ${HEX}.md`);
    expect(resolveTarget(res, `Notes ${HEX}`, target)).toBe("Child Page");
  });

  it("returns null for an absolute URL or a bare anchor", () => {
    const res = buildResolution([]);
    expect(resolveTarget(res, "", "https://x.test")).toBeNull();
    expect(resolveTarget(res, "", "#frag")).toBeNull();
  });
});

describe("Notion transforms", () => {
  it("lifts the plain-text property block into frontmatter fields", () => {
    const { properties } = liftProperties("# Page\n\nStatus: Done\nTags: work\n\nReal body.");
    expect(properties).toEqual({ Status: "Done", Tags: "work" });
  });

  it("stops at the blank line Notion puts before the body", () => {
    const { properties } = liftProperties("# P\n\nStatus: Done\n\nThis is prose: really.");
    expect(properties).toEqual({ Status: "Done" });
  });

  it("rejects a prose-shaped key (sentence punctuation, too many words)", () => {
    // The documented heuristic: property keys are short labels, not sentences.
    const { properties } = liftProperties(
      "# P\n\nOne caveat, however: it is a heuristic\n",
    );
    expect(properties).toEqual({});
    const long = liftProperties("# P\n\nthis key has far too many words in it: v\n");
    expect(long.properties).toEqual({});
  });

  it("LEAVES the plain-text block in the body (no rewrite beyond the allowlist)", () => {
    const body = "# P\n\nStatus: Done\n\nBody.";
    expect(liftProperties(body).body).toBe(body);
  });

  it("refuses to let imported properties forge a Myne-managed field", () => {
    const { lines, rejected } = propertiesToFrontmatter({ title: "evil", folder: "x", Ok: "1" });
    expect(rejected).toEqual(expect.arrayContaining(["title", "folder"]));
    // A numeric-looking value is quoted so YAML keeps it a STRING — a bare `1`
    // would coerce to a number and change the field's type on round trip.
    expect(lines.join("\n")).toBe('Ok: "1"');
  });

  it("rewrites a relative link to a wikilink", () => {
    const res = buildResolution([`Child ${HEX}.md`]);
    const { body } = rewriteLinks(`See [Child](Child%20${HEX}.md).`, res, "");
    expect(body).toBe("See [[Child]].");
  });

  it("keeps an image ref as markdown, not a wikilink", () => {
    const res = buildResolution([`Child ${HEX}.md`]);
    const { body } = rewriteLinks("![alt](img/a.png)", res, "");
    expect(body).toBe("![alt](img/a.png)");
  });

  it("leaves an unresolvable target alone and counts it", () => {
    const res = buildResolution([]);
    const { body, unresolved } = rewriteLinks("[X](Missing%20Page.md)", res, "");
    expect(body).toBe("[X](Missing%20Page.md)");
    expect(unresolved).toBe(1);
  });
});

describe("Notion adapter", () => {
  const tree = {
    "/n": [`Home ${HEX}.md`, `DB ${HEX}.csv`, `DB ${HEX}/`, "cover.png"],
    [`/n/DB ${HEX}`]: [`Row One ${HEX}.md`],
  };
  const files = {
    [`/n/Home ${HEX}.md`]: `# Home\n\nStatus: Live\n\nSee [Row One](DB%20${HEX}/Row%20One%20${HEX}.md).`,
    [`/n/DB ${HEX}.csv`]: "Name,Status\nRow One,Done",
    [`/n/DB ${HEX}/Row One ${HEX}.md`]: "# Row One\n\nbody",
  };

  it("plans pages + the database table, de-suffixed, and skips media", async () => {
    const plan = await createNotionSource("/n", fakePorts(tree, files)).plan();
    expect(plan.items.map((i) => i.relPath).sort()).toEqual([
      "DB (table).md",
      "DB/Row One.md",
      "Home.md",
    ]);
    expect(plan.ignore.nonMarkdownSkipped).toBe(1);
  });

  it("emits the Database.csv as an INDEX whose title column links to the row notes", async () => {
    const src = createNotionSource("/n", fakePorts(tree, files));
    const plan = await src.plan();
    const csvItem = plan.items.find((i) => i.relPath === "DB (table).md")!;
    const loaded = await src.load(csvItem);
    // The row's title cell links out; the header row is untouched.
    expect(loaded.markdown).toContain("[[Row One]]");
    expect(loaded.markdown).toContain("| Name | Status |");
  });

  it("lifts properties to frontmatter and rewrites internal links", async () => {
    const src = createNotionSource("/n", fakePorts(tree, files));
    const plan = await src.plan();
    const home = plan.items.find((i) => i.relPath === "Home.md")!;
    const loaded = await src.load(home);
    expect(loaded.markdown).toMatch(/^---\nStatus: Live\n---/);
    expect(loaded.markdown).toContain("[[Row One]]");
  });
});

// ── import-report note (MYND-585) ────────────────────────────────────────────

describe("import-report note", () => {
  const base = {
    imported: 3,
    skippedExisting: 0,
    illegalFlags: [],
    preexistingFolders: [],
    ignore: { canvasSkipped: 0, nonMarkdownSkipped: 0, hiddenIgnored: 0 },
    media: {
      ingested: { image: 0, pdf: 0, audio: 0, video: 0, other: 0 },
      omitted: { image: 0, pdf: 0, audio: 0, video: 0, other: 0 },
    },
    emptyFoldersPreserved: 0,
    cancelled: null,
    total: 3,
  };

  it("returns null on a clean import — an always-present report trains people to ignore it", () => {
    expect(buildImportReport("notion", { ...base, lossyNotes: [] }, "2026-07-25 12.00")).toBeNull();
  });

  it("lists each affected note with its folder, since wikilinks resolve by title", () => {
    const md = buildImportReport(
      "evernote",
      {
        ...base,
        lossyNotes: [
          { relPath: "A.md", folder: "Work/", title: "A", dropped: ["evernote-encrypted-block"] },
          { relPath: "B.md", folder: null, title: "B", dropped: ["underline"] },
        ],
      },
      "2026-07-25 12.00",
    )!;
    expect(md).toContain("[[A]]");
    expect(md).toContain("Work/");
    expect(md).toContain("vault root");
    // Construct names are translated, not leaked raw.
    expect(md).toContain("Evernote-encrypted block was preserved");
    expect(md).not.toContain("evernote-encrypted-block\n");
  });

  it("uses a unique, path-legal title so a re-import cannot collide with it", () => {
    const t = reportTitle("csv", formatStamp(new Date(2026, 6, 25, 9, 5)));
    expect(t).toBe("Import report (CSV) 2026-07-25 09.05");
    expect(t).not.toContain(":");
  });
});
