// Body rewrite for the Myne vault import source (myne-md/myne#464).

import { describe, expect, it } from "vitest";
import { rewriteMyneBody } from "../../../src/notes/import/sources/myneRewrite";

const SRC = "a".repeat(64);
const TGT = "b".repeat(64);
const GONE = "c".repeat(64);

const plan = {
  attachmentIds: new Map([[SRC, TGT]]),
  renamedTitles: new Map([["beta", "Beta (Eski laptop)"]]),
};

describe("rewriteMyneBody: attachment embeds", () => {
  it("swaps the source id for the target's", () => {
    const out = rewriteMyneBody(`![[att:${SRC}|diagram.png]]`, plan);
    expect(out.markdown).toBe(`![[att:${TGT}|diagram.png]]`);
    expect(out.attachmentsRewritten).toBe(1);
  });

  it("preserves layout segments byte-for-byte, including an out-of-grammar value", () => {
    // §5.1 requires an out-of-grammar value be DROPPED at render time, never
    // clamped and never rewritten in the source. So the rewrite must carry it
    // across untouched and let the renderer make that call.
    const alias = "diagram.png|w=999999|align=sideways|alt=A wide, wide picture";
    const out = rewriteMyneBody(`![[att:${SRC}|${alias}]]`, plan);
    expect(out.markdown).toBe(`![[att:${TGT}|${alias}]]`);
  });

  it("preserves a key this client does not recognise", () => {
    // §5.1: an unrecognised key means the note is NEWER, not wrong. Dropping it
    // here would make an import a downgrade.
    const alias = "diagram.png|w=400|rotate=90|caption=hello";
    const out = rewriteMyneBody(`![[att:${SRC}|${alias}]]`, plan);
    expect(out.markdown).toBe(`![[att:${TGT}|${alias}]]`);
  });

  it("leaves a tombstoned embed pointing at the source id", () => {
    // The source catalog no longer resolves this one. §5.1 builds the tombstone
    // specifically to distinguish "deleted" from "never valid", and says the
    // note bytes are never rewritten in either case.
    const out = rewriteMyneBody(`![[att:${GONE}|old.png]]`, plan);
    expect(out.markdown).toBe(`![[att:${GONE}|old.png]]`);
    expect(out.tombstonedEmbeds).toBe(1);
    expect(out.attachmentsRewritten).toBe(0);
  });

  it("does not count a REFUSED attachment as a source-side tombstone", () => {
    // Two causes, one body. The target refusing an attachment and the source
    // having already deleted it both leave the embed pointing at a source id,
    // so the markdown is identical and only the cause differs. The report says
    // different things about them, and one of the two rows reads "already
    // deleted in the source vault", which for a refusal is false. The caller
    // counts a refusal once, as a refusal, and passes the id here so this pass
    // does not count it a second time.
    const out = rewriteMyneBody(`![[att:${GONE}|refused.png]]`, {
      ...plan,
      refusedAttachmentIds: new Set([GONE]),
    });
    expect(out.markdown).toBe(`![[att:${GONE}|refused.png]]`);
    expect(out.tombstonedEmbeds).toBe(0);
  });

  it("still counts a tombstone when the id is not in the refused set", () => {
    // The other direction, without which the test above passes for a rewrite
    // that simply stopped counting tombstones at all.
    const out = rewriteMyneBody(`![[att:${GONE}|old.png]]`, {
      ...plan,
      refusedAttachmentIds: new Set([SRC]),
    });
    expect(out.tombstonedEmbeds).toBe(1);
  });

  it("rewrites every occurrence in a note, not just the first", () => {
    const out = rewriteMyneBody(
      `![[att:${SRC}|one.png]] and ![[att:${SRC}|two.png]]`,
      plan,
    );
    expect(out.markdown).toBe(
      `![[att:${TGT}|one.png]] and ![[att:${TGT}|two.png]]`,
    );
    expect(out.attachmentsRewritten).toBe(2);
  });
});

describe("rewriteMyneBody: renamed wikilinks", () => {
  it("moves a bare link to the new title", () => {
    const out = rewriteMyneBody("see [[Beta]]", plan);
    expect(out.markdown).toBe("see [[Beta (Eski laptop)]]");
    expect(out.linksRetargeted).toBe(1);
  });

  it("keeps an alias", () => {
    const out = rewriteMyneBody("see [[Beta|the other one]]", plan);
    expect(out.markdown).toBe("see [[Beta (Eski laptop)|the other one]]");
  });

  it("keeps a heading anchor", () => {
    const out = rewriteMyneBody("see [[Beta#Findings]]", plan);
    expect(out.markdown).toBe("see [[Beta (Eski laptop)#Findings]]");
  });

  it("keeps a block reference", () => {
    const out = rewriteMyneBody("see [[Beta^abc123]]", plan);
    expect(out.markdown).toBe("see [[Beta (Eski laptop)^abc123]]");
  });

  it("rewrites the final segment of a path-form link and keeps the folder", () => {
    // §5.3: the folder segment is a disambiguator, the final segment is the key.
    //
    // The rewritten link comes out in the CANONICAL path form, `<path>.md`,
    // even though the source link had no extension. That is the shared §8.2
    // planner's behaviour, and it is the form Myne's own rename and its link
    // picker emit, so an imported link ends up spelled the way a link authored
    // here would be. An earlier hand-rolled rewrite preserved the source's
    // spelling instead, which read as more conservative and quietly produced
    // two spellings of the same link inside one vault.
    const out = rewriteMyneBody("see [[Work/Beta]]", plan);
    expect(out.markdown).toBe("see [[Work/Beta (Eski laptop).md]]");
  });

  it("does not touch a wikilink inside a fenced code block", () => {
    // The regression that motivated moving off a regular expression. A note
    // documenting the wikilink syntax is an ordinary note, and rewriting the
    // example inside its fence edits the user's content.
    const body = [
      "Before.",
      "",
      "```",
      "[[Beta]]",
      "```",
      "",
      "After [[Beta]]",
    ].join("\n");
    const out = rewriteMyneBody(body, plan);
    expect(out.markdown).toContain("```\n[[Beta]]\n```");
    expect(out.markdown).toContain("After [[Beta (Eski laptop)]]");
    expect(out.linksRetargeted).toBe(1);
  });

  it("tracks an alias that mirrors the renamed title", () => {
    // §8.2: Myne's own picker emits `[[<path>.md|<Title>]]`, so an alias that
    // MIRRORS the title is an auto-emitted display rather than a deliberate
    // label. Leaving it would point the link at the renamed note while the chip
    // kept rendering the OLD name, which is most of what the rename was for.
    const out = rewriteMyneBody("see [[Beta|Beta]]", plan);
    expect(out.markdown).toBe("see [[Beta (Eski laptop)|Beta (Eski laptop)]]");
  });

  it("keeps a .md suffix when the source link had one", () => {
    const out = rewriteMyneBody("see [[Work/Beta.md]]", plan);
    expect(out.markdown).toBe("see [[Work/Beta (Eski laptop).md]]");
  });

  it("matches the title through the resolver's fold", () => {
    const out = rewriteMyneBody("see [[BETA]]", plan);
    expect(out.markdown).toBe("see [[Beta (Eski laptop)]]");
  });

  it("rewrites a note EMBED as well as a link", () => {
    // `![[Beta]]` resolves title-keyed exactly as `[[Beta]]` does, so leaving it
    // behind would embed the target's own note.
    const out = rewriteMyneBody("![[Beta]]", plan);
    expect(out.markdown).toBe("![[Beta (Eski laptop)]]");
  });

  it("leaves a link to a note that was not renamed", () => {
    const out = rewriteMyneBody("see [[Gamma]]", plan);
    expect(out.markdown).toBe("see [[Gamma]]");
    expect(out.linksRetargeted).toBe(0);
  });
});

describe("rewriteMyneBody: whole-body properties", () => {
  it("changes nothing when the plan is empty", () => {
    const body = `# Title\n\nsee [[Beta]] and ![[att:${SRC}|x.png]]\n`;
    const out = rewriteMyneBody(body, {
      attachmentIds: new Map(),
      renamedTitles: new Map(),
    });
    // The attachment is counted as tombstoned because an empty plan resolves
    // nothing, which is the same shape as a source id the catalog lost.
    expect(out.markdown).toBe(body);
    expect(out.linksRetargeted).toBe(0);
  });

  it("is idempotent", () => {
    // The property that makes a re-import safe: a target id is not a key in
    // `attachmentIds`, and a new title is not a key in `renamedTitles`, so a
    // second pass finds nothing to do.
    const body = `see [[Beta]] and ![[att:${SRC}|x.png]]`;
    const once = rewriteMyneBody(body, plan);
    const twice = rewriteMyneBody(once.markdown, plan);
    expect(twice.markdown).toBe(once.markdown);
    expect(twice.linksRetargeted).toBe(0);
    expect(twice.attachmentsRewritten).toBe(0);
  });

  it("leaves surrounding bytes exactly as they were", () => {
    const body = [
      "---",
      "title: Alpha",
      "---",
      "",
      "Text with  odd   spacing and a `[[Beta]]`-looking code span.",
      "",
      "see [[Gamma]]",
      "",
    ].join("\n");
    const out = rewriteMyneBody(body, {
      attachmentIds: new Map(),
      renamedTitles: new Map(),
    });
    expect(out.markdown).toBe(body);
  });
});
