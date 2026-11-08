// HTML projection emitter — form-C attachment embeds (MYND-255 task 2).
//
// `![[att:<64hex>|filename]]` (src/notes/attachmentRef.ts): image extensions
// (png/jpg/jpeg/gif/webp/svg — filename allowlist; the capture path's
// `attachment://` protocol re-sniffs the true type) inline as <img>; `.pdf`
// projects the muted exclusion line; every other extension projects a
// filename placeholder line. Non-image embeds join `excludedAttachments`.

import { afterEach, describe, expect, it, vi } from "vitest";
import { setEditorHost, getHost } from "@myne/editor/host";
import { emitNoteHtml } from "../../../src/dialect/html/emitNoteHtml";
import { scanExcludedAttachments } from "../../../src/dialect/html/attachment-classification";

const ID_A = "a".repeat(64);
const ID_B = "b".repeat(64);

function embed(id: string, filename: string): string {
  return `![[att:${id}|${filename}]]`;
}

/** The globally-installed test host, captured so a per-test override restores
 *  cleanly (the host registry is module-global). */
const baseHost = getHost();

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

describe("attachment src form (MYND-519 / phase3-web-client task 76)", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    setEditorHost(baseHost);
  });

  it("the default builder asks the HOST, so each client emits its own servable form", async () => {
    // Display surfaces (reading mode, the PDF hidden print window) call
    // emitNoteHtml without an attachmentUrl override, so the default builder is
    // what decides the src. It used to feature-detect `window.__TAURI_INTERNALS__`
    // and call `convertFileSrc` itself; task 76 moved that to the host, because
    // this package is compiled by a client that is not Tauri and a module-scope
    // `@tauri-apps/*` import lands in the bundle whether or not the call fires.
    //
    // Asserted with the form a WebView that cannot intercept a custom scheme
    // needs (Android, Windows WebView2) — the exact case MYND-519 existed for.
    setEditorHost({
      ...baseHost,
      attachments: {
        ...baseHost.attachments,
        resolveRef: (id: string) => `http://attachment.localhost/${id}`,
      },
    });
    const { html } = await emitNoteHtml(`${embed(ID_A, "pic.png")}\n`);
    expect(html).toContain(`src="http://attachment.localhost/${ID_A}"`);
  });

  it("emits a browser object URL just as readily — no scheme is baked in here", async () => {
    setEditorHost({
      ...baseHost,
      attachments: {
        ...baseHost.attachments,
        resolveRef: () => "blob:http://localhost:1421/9f2c",
      },
    });
    const { html } = await emitNoteHtml(`${embed(ID_A, "pic.png")}\n`);
    expect(html).toContain('src="blob:http://localhost:1421/9f2c"');
  });

  it("an explicit attachmentUrl option overrides the default builder", async () => {
    const { html } = await emitNoteHtml(`${embed(ID_A, "pic.png")}\n`, {
      attachmentUrl: (id) => `attachment://${id}`,
    });
    expect(html).toContain(`src="attachment://${ID_A}"`);
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

// --- layout segments must not reclassify an image (pr-review, myne#409) -----
//
// `IMAGE_EXT_RE` is anchored at the end, so it is tested against the FILENAME,
// never the raw alias. When form-C gained layout segments, `renderAttachmentEmbed`
// was still passing the whole alias: `photo.png|w=300` failed the extension
// test, so a sized image was reclassified non-image and replaced by an
// "Attachment … not included" placeholder carrying the raw segment text, while
// `scanExcludedAttachments` (already on the parser) still counted it as an
// included image. The two halves of this projection disagreed, which inverts
// the file's own invariant: the notice may name a file the projection keeps,
// never the reverse.

describe("an image carrying layout segments stays an image", () => {
  it.each([
    ["a width", "pic.png|w=300"],
    ["a width and alignment", "pic.png|w=300|align=center"],
    ["a percentage width", "pic.png|w=100%"],
    ["alt text containing a pipe", "pic.png|alt=A sunset | 2026"],
    ["an unknown key from a newer client", "pic.png|future=x"],
  ])("still renders an <img> with %s", async (_label, alias) => {
    const { html, excludedAttachments } = await emitNoteHtml(`${embed(ID_A, alias)}\n`);
    // `att-image` is present, not the whole attribute: an authored alignment
    // adds `att-align-*` beside it (myne-md/myne#518), so an exact-attribute
    // match would pin the ABSENCE of the layout this now carries.
    expect(html).toMatch(/class="att-image(?: att-align-\w+)?"/);
    expect(html).not.toContain("att-placeholder");
    // The raw segment text must never be printed into the document.
    expect(html).not.toContain("w=300");
    expect(html).not.toContain("future=x");
    expect(excludedAttachments).toEqual([]);
  });

  // myne-md/myne#518. `agent-tooling/docs/spec/wikilink.md` §5.1 is normative: "An authored
  // alt replaces the filename on the rendered media and on the embed's
  // accessible name. An authored EMPTY alt marks the media decorative." HTML is
  // the one output format where both are native and free, and it emitted the
  // filename for the first and lost the second entirely.
  it("uses an authored alt as the accessible name, not the filename", async () => {
    const { html } = await emitNoteHtml(`${embed(ID_A, "pic.png|alt=A sunset")}\n`);
    expect(html).toContain('alt="A sunset"');
    expect(html).not.toContain('alt="pic.png"');
  });

  it("keeps an authored EMPTY alt empty, because that is the decorative marker", async () => {
    // The half that `??` protects and `||` would destroy. `alt=""` is the author
    // saying "skip this"; falling back to the filename makes a screen reader
    // announce `pic.png` on an image chosen to be silent.
    const { html } = await emitNoteHtml(`${embed(ID_A, "pic.png|alt=")}\n`);
    expect(html).toContain('alt=""');
    expect(html).not.toContain('alt="pic.png"');
  });

  it("falls back to the filename when the author wrote no alt at all", async () => {
    // The other direction. `null` (no alt segment) is NOT `""` (decorative), and
    // a fix that collapsed the two would satisfy the case above on its own.
    const { html } = await emitNoteHtml(`${embed(ID_A, "pic.png")}\n`);
    expect(html).toContain('alt="pic.png"');
  });

  it("applies an authored width and alignment, without leaking the segments", async () => {
    const { html } = await emitNoteHtml(`${embed(ID_A, "pic.png|w=300|align=right")}\n`);
    expect(html).toContain("width:300px");
    expect(html).toContain("max-width:100%");
    expect(html).toContain("att-align-right");
    expect(html).not.toContain("w=300");
    expect(html).not.toContain("align=right");
  });

  it("applies a percentage width as a percentage", async () => {
    const { html } = await emitNoteHtml(`${embed(ID_A, "pic.png|w=50%")}\n`);
    expect(html).toContain("width:50%");
    expect(html).not.toContain("width:50px");
  });

  it("writes no style attribute at all when the author chose no layout", async () => {
    // A projection that always carried a style attribute would be harder to
    // read and would imply a choice the author did not make.
    const { html } = await emitNoteHtml(`${embed(ID_A, "pic.png")}\n`);
    expect(html).toContain('class="att-image"');
    expect(html).not.toContain("style=");
  });

  it("keeps the two halves of the projection agreeing", async () => {
    // The pre-flight scan and the emitter must reach the same verdict, or the
    // notice offers to include a sidecar the projection never references.
    const body = `${embed(ID_A, "pic.png|w=300|align=center")}\n`;
    const { excludedAttachments } = await emitNoteHtml(body);
    expect(excludedAttachments).toEqual(scanExcludedAttachments(body));
  });

  it("labels a non-image by its filename, not its segments", async () => {
    const { html, excludedAttachments } = await emitNoteHtml(
      `${embed(ID_B, "notes.zip|w=300")}\n`,
    );
    expect(html).toContain('Attachment "notes.zip" not included');
    expect(excludedAttachments.map((a) => a.filename)).toEqual(["notes.zip"]);
  });
});
