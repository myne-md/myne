// The embed-typing helper must balance its probe and prove its payload landed.
//
// Four spec files grew a private `typeRaw` that typed an attachment embed into
// CodeMirror. Each carried the same two defects, and each is a permanent state
// no budget reaches, which is the class `e2e/CLAUDE.md` names:
//
//   1. The pipeline probe types "q" on EVERY poll of its `waitUntil`, and all
//      four copies then sent exactly ONE Backspace. Under load the poll runs
//      more than once, so surplus "q"s stay in the document ahead of the
//      payload. Harmless for an `includes` assertion, not harmless for a
//      position-sensitive one, and it is the recorded `slash-datetime` trap:
//      a leading "q" stops `/date` being a slash command at all.
//   2. The payload was sent and never verified. `sendKeys` resolving means the
//      driver accepted the keys, not that CodeMirror applied them. Under load
//      the LEADING character is dropped during the focus settle, and
//      `![[att:...]]` arriving as `[[att:...]]` is an ordinary wikilink rather
//      than an embed, so no decoration is ever built and the raw text sits in
//      the buffer forever. CI pipelines 653 and 657 reported exactly that state
//      for `eo1`, three attempts each.
//
//      The first fix checked for `att:`, which the garbled payload still
//      satisfies, so it passed the broken document straight through to
//      `waitForInlineImage`. That is why the dropped-leading-character case has
//      a test of its own below: the weaker check is green without it.
//
// These run against a `Session` whose WIRE calls are stubbed and whose
// `waitUntil` is the real one, so the loop under test is the shipped loop rather
// than a re-implementation of it. That matters most for defect 1, whose whole
// mechanism is "the poll ran more than once".

import { describe, expect, it } from "vitest";

import {
  EMBED_ARRIVAL_NEEDLE,
  EMBED_BROKEN_CHIP_CLASS,
  EMBED_WIDGET_CLASS_PREFIX,
  embedArrived,
  typeEmbedIntoEditor,
} from "../../e2e/support/flows";
import { Session } from "../../e2e/support/webdriver";

const EMBED = "![[att:0123456789abcdef0123456789abcdef|diagram.png]]";
const BACKSPACE = String.fromCharCode(0xe003);
const SHIFT = String.fromCharCode(0xe008);
const HOME = String.fromCharCode(0xe011);

interface Recorder {
  sent: string[];
  /** The document, as the probe and the payload actually left it. */
  doc: string;
}

/**
 * A `Session` over a one-string document model.
 *
 * `probeLandsAfter` is the injected load: the probe's keystroke is dropped until
 * that many sends have happened, which is precisely the focus-settle drop the
 * probe exists to absorb and the only way the imbalance in defect 1 becomes
 * visible. `payloadLands` injects defect 2's three outcomes.
 */
function fakeSession(opts: {
  probeLandsAfter: number;
  payloadLands: "intact" | "garbled" | "never";
}): {
  session: Session;
  rec: Recorder;
} {
  const rec: Recorder = { sent: [], doc: "" };
  let probeSends = 0;
  let widget = false;
  let broken = false;

  const content = {
    click: async () => undefined,
    sendKeys: async (text: string) => {
      rec.sent.push(text);
      if (text === "q") {
        probeSends += 1;
        if (probeSends >= opts.probeLandsAfter) rec.doc += "q";
        return;
      }
      if (text === BACKSPACE) {
        rec.doc = rec.doc.slice(0, -1);
        return;
      }
      // The payload. `payloadLands` is the full three-way the driver can
      // produce: intact (the editor decorates it, so the raw source leaves the
      // DOM and a widget replaces it), garbled (the leading "!" is dropped, so
      // the text is in the document and nothing decorates it), or absent.
      if (opts.payloadLands === "intact") {
        // The widget replaces the source, so the document the DOM reports keeps
        // only what the probe left, which is nothing. That is what lets the two
        // probe-balance cases assert emptiness.
        widget = true;
      } else if (opts.payloadLands === "garbled") {
        // What CI measured: the text is in the document, `att:` and all, and the
        // editor has rendered a BROKEN chip over it because the target did not
        // parse. Nothing about the raw text distinguishes this from a good
        // payload, which is the whole reason the chip is consulted.
        rec.doc += text.slice(1);
        broken = true;
      }
    },
    textContent: async () => rec.doc,
  };

  const session = new Session("http://127.0.0.1:0", "fake");
  Object.assign(session, {
    waitForElement: async () => content,
    findElements: async () => [content],
    // Two scripts reach `execute`, and both are MODELLED rather than run: the
    // real ones are JavaScript strings evaluated in the WebView and nothing here
    // has a DOM. What the model supplies is FACTS, not a verdict — the verdict
    // is `embedArrived`, which is ordinary TypeScript and is tested directly
    // below. That split is deliberate: while the verdict lived inside the
    // browser string, deleting the broken-chip veto from it left all seven cases
    // green, because this fake was quietly re-implementing the rule it was
    // supposed to be checking.
    //
    // The second script is the failure-shape probe. It is answered with a
    // structurally valid reading rather than a real one, because what this file
    // tests is the helper's control flow; the probe's own accuracy is a claim
    // about the DOM and only a container run can carry it.
    execute: async (script: string) =>
      // Keyed on a token ONLY the shape probe carries. Keying on `cm-content`
      // instead matched the arrival script too, which then returned this object
      // — truthy — so every case reported arrival and the two failure tests
      // resolved instead of rejecting.
      script.includes("handleIsFirst")
        ? {
            contents: 1,
            handleIsFirst: true,
            queriedChars: rec.doc.length,
            bang: rec.doc.includes("![["),
            openers: (rec.doc.match(/\[\[/g) || []).length,
            att: rec.doc.includes("att:"),
            closers: (rec.doc.match(/\]\]/g) || []).length,
            decorations: [],
          }
        : {
            raw: rec.doc.includes(EMBED_ARRIVAL_NEEDLE),
            widget,
            broken,
          },
    send: async () => undefined,
  });
  return { session: session as unknown as Session, rec };
}

describe("typeEmbedIntoEditor", () => {
  it("treats a broken chip as a veto over everything else", () => {
    // The verdict itself, not a model of it. A broken chip means the target did
    // not parse, so the attachment embed decoration never builds and no budget
    // recovers — even though the source text still reads `att:`, which is the
    // exact state CI pipeline 661 measured while the check called it arrival.
    expect(embedArrived({ raw: true, widget: false, broken: true })).toBe(false);
    expect(embedArrived({ raw: true, widget: true, broken: true })).toBe(false);
    // And the other direction, so a veto that swallowed the healthy cases would
    // fail here rather than turning every scenario into a timeout.
    expect(embedArrived({ raw: true, widget: false, broken: false })).toBe(true);
    expect(embedArrived({ raw: false, widget: true, broken: false })).toBe(true);
    expect(embedArrived({ raw: false, widget: false, broken: false })).toBe(false);
  });

  it("asks the editor whether the payload parsed, not the source text", () => {
    // The thresholds, asserted directly, because the fake above MODELS the check
    // rather than running it: the real one is a string evaluated in the WebView.
    //
    // The needle deliberately does NOT carry `![[`. A wikilink chip is an atomic
    // Decoration.replace that hides the markers, so once any chip renders they
    // are absent whether the payload was right or wrong. CI pipeline 661
    // measured exactly that on a document this check was rejecting: `![[` false,
    // `[[` x0, `att:` true, with a chip up. The question `![[att:` was reaching
    // for — is this payload well formed — is answered by the broken-chip class,
    // which is the editor's own verdict and survives the decoration.
    expect(EMBED_ARRIVAL_NEEDLE).toBe("att:");
    expect(
      EMBED_ARRIVAL_NEEDLE.includes("["),
      "a needle carrying a wikilink marker can never match once a chip renders",
    ).toBe(false);
    expect(EMBED_BROKEN_CHIP_CLASS).toBe("cm-wikilink-chip-broken");
  });

  it("recognises any attachment widget by prefix, not a list of three", () => {
    // `tp1` is the reason. Its `.txt` embed renders the text-preview card, which
    // the first version of this check did not name, so the helper saw neither
    // the raw source (an atomic widget had replaced it) nor a known widget and
    // failed on a document that was perfectly correct. Every widget in
    // `editor/src/attachments/widgets.ts` carries this prefix, so matching it
    // covers the embed types nobody has written yet.
    expect(EMBED_WIDGET_CLASS_PREFIX).toBe("cm-attachment-");
    for (const cls of [
      "cm-attachment-img",
      "cm-attachment-tombstone",
      "cm-attachment-file-card",
      "cm-attachment-pdf",
      "cm-attachment-audio",
    ]) {
      expect(
        cls.startsWith(EMBED_WIDGET_CLASS_PREFIX),
        `${cls} is a real widget class and the prefix has to reach it`,
      ).toBe(true);
    }
  });

  it("sends one Backspace per probe, so a looping probe leaves no stray character", async () => {
    // Three sends before the keystroke pipeline is live, which is the whole
    // reason the probe is a loop rather than a single send.
    const { session, rec } = fakeSession({ probeLandsAfter: 3, payloadLands: "intact" });
    await typeEmbedIntoEditor(session, EMBED);

    const probes = rec.sent.filter((k) => k === "q").length;
    const backspaces = rec.sent.filter((k) => k === BACKSPACE).length;
    expect(probes, "the probe must have actually looped, or this asserts nothing").toBe(3);
    expect(backspaces, "one Backspace per probe").toBe(probes);
    expect(
      rec.doc,
      "a surplus probe character ahead of the payload is what breaks a " +
        "position-sensitive caller, and nothing else reports it",
    ).toBe("");
  });

  it("still balances when the probe lands on its first send", async () => {
    // The other direction. An over-correction that always sent a fixed number of
    // Backspaces would eat real document content here, and no assertion on the
    // looping case above would see it.
    const { session, rec } = fakeSession({ probeLandsAfter: 1, payloadLands: "intact" });
    await typeEmbedIntoEditor(session, EMBED);

    expect(rec.sent.filter((k) => k === "q")).toHaveLength(1);
    expect(rec.sent.filter((k) => k === BACKSPACE)).toHaveLength(1);
    expect(rec.doc).toBe("");
  });

  it("sends the payload exactly once when it lands", async () => {
    const { session, rec } = fakeSession({ probeLandsAfter: 1, payloadLands: "intact" });
    await typeEmbedIntoEditor(session, EMBED);
    expect(rec.sent.filter((k) => k === EMBED)).toHaveLength(1);
  });

  it("clears the line and retypes when the editor marks the payload broken", { timeout: 25_000 }, async () => {
    // The failure CI reported twice. `![[att:...]]` arriving as `[[att:...]]` is
    // an ordinary wikilink, so the embed decoration never builds and the raw
    // text stays in the buffer forever. An `att:` check passes this; the `![[att:`
    // check is what catches it, and this case is the reason the check is that
    // shape rather than the shorter one.
    const { session, rec } = fakeSession({ probeLandsAfter: 1, payloadLands: "garbled" });
    await expect(typeEmbedIntoEditor(session, EMBED)).rejects.toThrow(
      /embed source landed in the document \(after re-send; /,
    );

    expect(
      rec.sent,
      "the repair must CLEAR THE LINE before retyping: appending a second embed " +
        "would leave the broken one in a note whose bytes are what the caller " +
        "is testing, and counting characters to delete cannot work once a chip " +
        "renders, because the rendered text and the document differ in length",
    ).toContain(`${SHIFT}${HOME}${SHIFT}`);
    expect(rec.sent.filter((k) => k === EMBED)).toHaveLength(2);
  });

  // 5 s for the first arrival wait plus 10 s for the one after the re-send, which
  // are the helper's own budgets: a test bounded tighter than the code it drives
  // measures the bound rather than the behaviour.
  it("re-sends the payload once when the document never shows it", { timeout: 25_000 }, async () => {
    // Defect 2. Without the arrival check the helper returns happily here and
    // the failure surfaces 20 s later inside `waitForInlineImage`, wearing the
    // name of an attachment problem rather than a typing one.
    const { session, rec } = fakeSession({ probeLandsAfter: 1, payloadLands: "never" });
    await expect(typeEmbedIntoEditor(session, EMBED)).rejects.toThrow(
      /embed source landed in the document \(after re-send; /,
    );
    expect(
      rec.sent.filter((k) => k === EMBED),
      "one send, one re-send, and no more: a helper that re-sent per poll would " +
        "type the embed into the note a dozen times",
    ).toHaveLength(2);
  });
});
