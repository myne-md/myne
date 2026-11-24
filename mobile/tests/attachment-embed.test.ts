import { describe, it, expect, afterEach, vi } from "vitest";
import { emitAttachmentEmbed, parseAttachmentTarget, isAttachmentId, extractAttachmentIds, attachmentSrc } from "../src/lib/attachmentRef";
import { parseBlocks } from "../src/lib/markdown";
import { isAudioLabel } from "../src/components/MarkdownView";

const ID = "a".repeat(64);
const ID2 = "b".repeat(64);

describe("attachmentRef", () => {
  it("emits canonical form-C with the filename alias", () => {
    expect(emitAttachmentEmbed(ID, "cat.png")).toBe(`![[att:${ID}|cat.png]]`);
  });

  it("parses a valid att: target, rejects note links + bad ids", () => {
    expect(parseAttachmentTarget(`att:${ID}`)).toBe(ID);
    expect(parseAttachmentTarget("att:not-hex")).toBeNull();
    expect(parseAttachmentTarget("Some Note")).toBeNull();
  });

  it("validates ids (64 lowercase hex)", () => {
    expect(isAttachmentId(ID)).toBe(true);
    expect(isAttachmentId("A".repeat(64))).toBe(false); // uppercase
    expect(isAttachmentId("a".repeat(63))).toBe(false);
  });

  it("extracts embedded ids deduped in first-seen order", () => {
    const body = `intro ![[att:${ID}|a.png]] mid ![[att:${ID2}|b.pdf]] again ![[att:${ID}|a.png]]`;
    expect(extractAttachmentIds(body)).toEqual([ID, ID2]);
  });

  it("reads the canonical embed, alias newline and all (T6.13 item 3)", () => {
    // The removed local copy used `[^\]\n]` for the alias, so this body
    // extracted NOTHING on mobile while the canonical reader (desktop, and now
    // mobile) extracts the id. Proving the two clients agree is the point.
    const body = `![[att:${ID}|line one\nline two]]`;
    expect(extractAttachmentIds(body)).toEqual([ID]);
  });
});

describe("attachmentSrc (platform-aware, MYND-519)", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("falls back to the literal attachment:// form outside Tauri", () => {
    expect(attachmentSrc(ID)).toBe(`attachment://${ID}`);
  });

  it("delegates to convertFileSrc inside Tauri (Android http-mapped form)", () => {
    // Android WebView cannot intercept custom schemes — the runtime form
    // there is `http://attachment.localhost/<id>`; convertFileSrc reads the
    // Tauri global at CALL time, so stubbing it here exercises the branch.
    vi.stubGlobal("window", {
      __TAURI_INTERNALS__: {
        convertFileSrc: (path: string, protocol: string) =>
          `http://${protocol}.localhost/${path}`,
      },
    });
    expect(attachmentSrc(ID)).toBe(`http://attachment.localhost/${ID}`);
  });
});

describe("markdown attachment token", () => {
  it("parses ![[att:id|name]] as an attachment inline (not text + wikilink)", () => {
    const blocks = parseBlocks(`![[att:${ID}|cat.png]]`);
    const para = blocks.find((b) => b.kind === "paragraph");
    expect(para?.kind).toBe("paragraph");
    const inline = para && para.kind === "paragraph" ? para.content : [];
    // `toMatchObject`, not `toEqual`: the token also carries `layout`
    // (myne-md/myne#518) and those have their own assertions below. An exact
    // match here would make every future field an edit to a test about labels.
    expect(inline).toHaveLength(1);
    expect(inline[0]).toMatchObject({ kind: "attachment", id: ID, label: "cat.png" });
  });

  // A note laid out on desktop syncs here. Reading the whole alias as the label
  // showed the raw segments as the caption and as `alt`, and broke the
  // extension test `isAudioLabel` runs, so an audio embed whose alias had
  // picked up an importer-carried `alt=` silently lost its inline player.
  it.each([
    ["a width", `cat.png|w=300`, "cat.png"],
    ["a width and alignment", `cat.png|w=300|align=center`, "cat.png"],
    ["alt text containing a pipe", `cat.png|alt=A cat | 2026`, "cat.png"],
    ["a key this version does not know", `cat.png|future=x`, "cat.png"],
    ["a pipe-bearing filename", `re|port.png`, "re|port.png"],
    ["an audio file carrying an alt", `memo.wav|alt=A memo`, "memo.wav"],
  ])("labels an embed carrying %s by its filename", (_l, alias, want) => {
    const blocks = parseBlocks(`![[att:${ID}|${alias}]]`);
    const para = blocks.find((b) => b.kind === "paragraph");
    const inline = para && para.kind === "paragraph" ? para.content : [];
    expect(inline).toHaveLength(1);
    expect(inline[0]).toMatchObject({ kind: "attachment", id: ID, label: want });
  });

  // myne-md/myne#518. The alias was parsed and then thrown away: the token kept
  // only `label`, so `AttachmentInline` passed `alt={label}` and an authored alt
  // was not the accessible name on a phone. `docs/spec/wikilink.md` §5.1 is
  // normative on both halves of this.
  it.each([
    ["an authored alt", "cat.png|alt=A cat asleep", "A cat asleep"],
    ["an authored alt containing a pipe", "cat.png|alt=A cat | 2026", "A cat | 2026"],
    ["an authored EMPTY alt, the decorative marker", "cat.png|alt=", ""],
    ["no alt at all", "cat.png", null],
  ])("carries %s through to the token", (_l, alias, want) => {
    const blocks = parseBlocks(`![[att:${ID}|${alias}]]`);
    const para = blocks.find((b) => b.kind === "paragraph");
    const inline = para && para.kind === "paragraph" ? para.content : [];
    const token = inline[0];
    expect(token.kind).toBe("attachment");
    expect(token.kind === "attachment" ? token.layout.alt : undefined).toBe(want);
  });

  it("keeps `` distinct from no alt at all, which is the decorative signal", () => {
    // The two cases above stated as the one comparison that matters: a fix that
    // collapsed them (`?? ""`, or a trim) would satisfy each case read alone.
    const decorative = parseBlocks(`![[att:${ID}|cat.png|alt=]]`);
    const none = parseBlocks(`![[att:${ID}|cat.png]]`);
    const altOf = (bs: ReturnType<typeof parseBlocks>) => {
      const para = bs.find((b) => b.kind === "paragraph");
      const t = para && para.kind === "paragraph" ? para.content[0] : undefined;
      return t !== undefined && t.kind === "attachment" ? t.layout.alt : undefined;
    };
    expect(altOf(decorative)).toBe("");
    expect(altOf(none)).toBeNull();
    expect(altOf(decorative)).not.toBe(altOf(none));
  });

  it("carries the layout through, so a note laid out on desktop is not flattened", () => {
    const blocks = parseBlocks(`![[att:${ID}|cat.png|w=300|align=right]]`);
    const para = blocks.find((b) => b.kind === "paragraph");
    const token = para && para.kind === "paragraph" ? para.content[0] : undefined;
    expect(token !== undefined && token.kind === "attachment" ? token.layout : null).toMatchObject(
      { widthPx: 300, align: "right" },
    );
  });

  it("keeps an audio embed recognisable once its alias carries segments", () => {
    const blocks = parseBlocks(`![[att:${ID}|memo.wav|w=300|alt=A memo]]`);
    const para = blocks.find((b) => b.kind === "paragraph");
    const inline = para && para.kind === "paragraph" ? para.content : [];
    const token = inline[0];
    expect(token.kind).toBe("attachment");
    expect(token.kind === "attachment" && isAudioLabel(token.label)).toBe(true);
  });

  it("leaves an ordinary [[wikilink]] as a wikilink", () => {
    const blocks = parseBlocks(`see [[Other Note]]`);
    const para = blocks.find((b) => b.kind === "paragraph");
    const inline = para && para.kind === "paragraph" ? para.content : [];
    expect(inline.some((t) => t.kind === "wikilink" && t.target === "Other Note")).toBe(true);
  });
});

describe("isAudioLabel (voice-note / audio embeds render as <audio>)", () => {
  it("recognizes audio filename extensions (case-insensitive)", () => {
    expect(isAudioLabel("Voice note 2026-07-12 09-05-03.wav")).toBe(true);
    expect(isAudioLabel("memo.M4A")).toBe(true);
    expect(isAudioLabel("clip.ogg")).toBe(true);
    expect(isAudioLabel("track.mp3")).toBe(true);
  });

  it("rejects image / document / empty labels", () => {
    expect(isAudioLabel("cat.png")).toBe(false);
    expect(isAudioLabel("report.pdf")).toBe(false);
    expect(isAudioLabel("waveform.txt")).toBe(false); // not a real audio ext
    expect(isAudioLabel("")).toBe(false);
  });
});
