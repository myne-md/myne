// HTML projection emitter — frontmatter projection (MYND-255 task 1).
//
// Spec: myne-agents/docs/spec/markdown-dialect.md §3.6 + PRD story 13 — `title:` projects
// as the document heading and every other FM field is dropped, with the FM
// block itself never rendering. Plus the round-trip byte-stability guard.
//
// **`cover:` is the second projecting field** (myne-md/myne#410): a valid one
// emits a leading `<img src="attachment://<id>">` above the title, so the
// exported document opens the way the note does. It is a narrow, deliberate
// exception to "only title projects" and not a general relaxation: the field
// must pass the §3.6.1 grammar, and every other field still drops.

import { describe, expect, it } from "vitest";
import { emitNoteHtml } from "../../../src/dialect/html/emitNoteHtml";
import { enc, bytesEqual } from "../_helpers";

describe("frontmatter projection", () => {
  it("projects title: as the document heading", async () => {
    const { html, title } = await emitNoteHtml(
      "---\ntitle: My Note\n---\n\nBody text.\n",
    );
    expect(title).toBe("My Note");
    expect(html).toContain('<h1 class="note-title">My Note</h1>');
    expect(html).toContain("<p>Body text.</p>");
  });

  it("drops updated:, folder:, and custom fields from the output", async () => {
    const { html, title } = await emitNoteHtml(
      "---\ntitle: T\nupdated: 2026-06-11T00:00:00Z\nfolder: Projects/Myne/\ncustom_field: secret-value\ntags: [a, b]\n---\n\nBody.\n",
    );
    expect(title).toBe("T");
    expect(html).not.toContain("updated");
    expect(html).not.toContain("Projects/Myne");
    expect(html).not.toContain("secret-value");
    expect(html).not.toContain("custom_field");
    expect(html).not.toContain("tags");
  });

  it("never renders the frontmatter block itself", async () => {
    const { html } = await emitNoteHtml("---\ntitle: T\n---\n\nBody.\n");
    expect(html).not.toContain("---");
    expect(html).not.toContain("title:");
  });

  it("returns null title and renders the body when there is no frontmatter", async () => {
    const { html, title } = await emitNoteHtml("# Heading\n\nBody.\n");
    expect(title).toBeNull();
    expect(html).not.toContain("note-title");
    expect(html).toContain("<h1>Heading</h1>");
  });

  it("treats an opener without a closer as body (§3.6)", async () => {
    const { html, title } = await emitNoteHtml("---\ntitle: X\nno closer\n");
    expect(title).toBeNull();
    expect(html).toContain("title: X");
  });

  it("escapes HTML-significant characters in the title", async () => {
    const { html, title } = await emitNoteHtml(
      '---\ntitle: "<script>a & b</script>"\n---\n\nBody.\n',
    );
    expect(title).toBe("<script>a & b</script>");
    expect(html).toContain(
      '<h1 class="note-title">&lt;script&gt;a &amp; b&lt;/script&gt;</h1>',
    );
    expect(html).not.toContain("<script>");
  });

  it("emits an empty body for a frontmatter-only note", async () => {
    const { html, title } = await emitNoteHtml("---\ntitle: Only\n---\n");
    expect(title).toBe("Only");
    expect(html).toBe('<h1 class="note-title">Only</h1>');
  });

  it("never mutates the input (round-trip byte guard)", async () => {
    const input =
      "---\ntitle: Stable\nupdated: 2026-06-11T00:00:00Z\n---\n\n# H\n\n- [ ] task\n\n```ts\nconst x = 1;\n```\n\n$$\nE=mc^2\n$$\n";
    const before = enc.encode(input);
    await emitNoteHtml(input);
    expect(bytesEqual(before, enc.encode(input))).toBe(true);
  });
});

describe("cover projection (myne-md/myne#410)", () => {
  const ID = "a".repeat(64);

  it("emits the cover above the title, as a canonical attachment ref", async () => {
    const { html } = await emitNoteHtml(
      `---\ntitle: Roadmap\ncover: "![[att:${ID}|photo.png]]"\n---\n\nBody.\n`,
    );
    // `attachment://<id>` is the shape the HTML-with-attachments export's
    // sidecar rewriter scans for, so the cover needs no rewrite logic of its own.
    expect(html).toContain(`<img class="note-cover" src="attachment://${ID}" alt="">`);
    // Order is the point: cover, then title, then body — the same stack the
    // editor draws.
    expect(html.indexOf("note-cover")).toBeLessThan(html.indexOf("note-title"));
  });

  it("emits nothing for a note with no cover", async () => {
    const { html } = await emitNoteHtml("---\ntitle: Roadmap\n---\n\nBody.\n");
    expect(html).not.toContain("note-cover");
  });

  it("emits nothing for a cover value the grammar rejects", async () => {
    // The §3.6.1 grammar is the only gate. This file must not form a second
    // opinion about what counts as a cover.
    for (const value of ["true", "photo.png", ID, `"![[att:${ID}]]"`]) {
      const { html } = await emitNoteHtml(
        `---\ntitle: T\ncover: ${value}\n---\n\nBody.\n`,
      );
      expect(html).not.toContain("note-cover");
    }
  });

  it("still drops the cover LINE itself from the output", async () => {
    // Projecting the image is not the same as leaking the field. The raw
    // `![[att:` bytes must not reach the document.
    const { html } = await emitNoteHtml(
      `---\ntitle: T\ncover: "![[att:${ID}|photo.png]]"\n---\n\nBody.\n`,
    );
    expect(html).not.toContain("![[");
    expect(html).not.toContain("photo.png");
  });

  it("emits the cover for an untitled note too", async () => {
    const { html, title } = await emitNoteHtml(
      `---\ncover: "![[att:${ID}|photo.png]]"\n---\n\nBody.\n`,
    );
    expect(title).toBeNull();
    expect(html).toContain("note-cover");
  });
});
