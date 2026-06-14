// HTML projection emitter — form-C attachment embeds (MYND-255 task 2).
//
// `![[att:<64hex>|filename]]` (src/notes/attachmentRef.ts): image extensions
// (png/jpg/jpeg/gif/webp/svg — filename allowlist; the capture path's
// `attachment://` protocol re-sniffs the true type) inline as <img>; `.pdf`
// projects the muted exclusion line; every other extension projects a
// filename placeholder line. Non-image embeds join `excludedAttachments`.

import { describe, expect, it } from "vitest";
import { emitNoteHtml } from "../../../src/dialect/html/emitNoteHtml";
import { scanExcludedAttachments } from "../../../src/dialect/html/attachment-classification";

const ID_A = "a".repeat(64);
const ID_B = "b".repeat(64);

function embed(id: string, filename: string): string {
  return `![[att:${id}|${filename}]]`;
}

describe("image attachment embeds", () => {
  it("renders an <img> over the attachment protocol at position", async () => {
    const { html, excludedAttachments } = await emitNoteHtml(
      `before\n\n${embed(ID_A, "pic.png")}\n\nafter\n`,
    );
    expect(html).toContain(
      `<img class="att-image" src="attachment://${ID_A}" alt="pic.png">`,
    );
    const idx = html.indexOf("<img");
    expect(html.indexOf("<p>before</p>")).toBeLessThan(idx);
    expect(html.indexOf("<p>after</p>")).toBeGreaterThan(idx);
    expect(excludedAttachments).toHaveLength(0);
  });

  it("accepts the full image-extension allowlist, case-insensitively", async () => {
    for (const name of ["a.png", "b.JPG", "c.jpeg", "d.gif", "e.webp", "f.svg"]) {
      const { html, excludedAttachments } = await emitNoteHtml(
        `${embed(ID_A, name)}\n`,
      );
      expect(html).toContain('<img class="att-image"');
      expect(excludedAttachments).toHaveLength(0);
    }
  });

  it("escapes the filename in the alt attribute", async () => {
    const { html } = await emitNoteHtml(`${embed(ID_A, 'we"ird.png')}\n`);
    expect(html).toContain('alt="we&quot;ird.png"');
  });
});

describe("PDF attachment embeds", () => {
  it("projects the muted exclusion line and collects the attachment", async () => {
    const { html, excludedAttachments } = await emitNoteHtml(
      `${embed(ID_A, "report.pdf")}\n`,
    );
    expect(html).toContain(
      '<p class="att-excluded">PDF attachment "report.pdf" not included</p>',
    );
    expect(html).not.toContain("<img");
    expect(excludedAttachments).toEqual([{ id: ID_A, filename: "report.pdf" }]);
  });

  it("uses an inline span when the embed sits among text", async () => {
    const { html, excludedAttachments } = await emitNoteHtml(
      `see ${embed(ID_A, "doc.pdf")} here\n`,
    );
    expect(html).toContain(
      '<span class="att-excluded">PDF attachment "doc.pdf" not included</span>',
    );
    expect(excludedAttachments).toHaveLength(1);
  });
});

describe("other attachment embeds", () => {
  it("projects a filename placeholder line and collects the attachment", async () => {
    const { html, excludedAttachments } = await emitNoteHtml(
      `${embed(ID_A, "data.zip")}\n`,
    );
    expect(html).toContain(
      '<p class="att-placeholder">Attachment "data.zip" not included</p>',
    );
    expect(excludedAttachments).toEqual([{ id: ID_A, filename: "data.zip" }]);
  });

  it("handles an extension-less filename as non-image", async () => {
    const { html, excludedAttachments } = await emitNoteHtml(
      `${embed(ID_A, "README")}\n`,
    );
    expect(html).toContain('Attachment "README" not included');
    expect(excludedAttachments).toHaveLength(1);
  });
});

describe("collection semantics", () => {
  it("deduplicates repeated embeds of the same attachment", async () => {
    const { excludedAttachments } = await emitNoteHtml(
      `${embed(ID_A, "x.pdf")}\n\n${embed(ID_A, "x.pdf")}\n`,
    );
    expect(excludedAttachments).toHaveLength(1);
  });

  it("collects distinct attachments in document order", async () => {
    const { excludedAttachments } = await emitNoteHtml(
      `${embed(ID_A, "one.pdf")}\n\n${embed(ID_B, "two.zip")}\n`,
    );
    expect(excludedAttachments).toEqual([
      { id: ID_A, filename: "one.pdf" },
      { id: ID_B, filename: "two.zip" },
    ]);
  });

  it("treats a malformed att: target as an ordinary embed placeholder", async () => {
    const { html, excludedAttachments } = await emitNoteHtml(
      "![[att:deadbeef|x.pdf]]\n",
    );
    expect(html).toContain('<span class="embed-placeholder">x.pdf</span>');
    expect(html).not.toContain("att-excluded");
    expect(excludedAttachments).toHaveLength(0);
  });
});

describe("scanExcludedAttachments lockstep (cheap pre-flight scan)", () => {
  it("matches the emitter's excludedAttachments for a mixed body (images inlined, non-images excluded, dedup, alias-less fallback, malformed id ignored)", async () => {
    const body = [
      `${embed(ID_A, "pic.png")}`, // image — inlined, never excluded
      "",
      `${embed(ID_B, "report.pdf")} and ${embed(ID_B, "report.pdf")}`, // dedup
      "",
      `![[att:${"c".repeat(64)}]]`, // alias-less → "attachment" fallback
      "",
      "![[att:deadbeef|x.pdf]]", // malformed id — not an attachment ref
      "",
    ].join("\n");
    const { excludedAttachments } = await emitNoteHtml(body);
    expect(scanExcludedAttachments(body)).toEqual(excludedAttachments);
    expect(excludedAttachments).toEqual([
      { id: ID_B, filename: "report.pdf" },
      { id: "c".repeat(64), filename: "attachment" },
    ]);
  });
});
