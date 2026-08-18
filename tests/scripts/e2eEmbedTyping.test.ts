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

import { EMBED_ARRIVAL_NEEDLE, typeEmbedIntoEditor } from "../../e2e/support/flows";
import { Session } from "../../e2e/support/webdriver";

const EMBED = "![[att:0123456789abcdef0123456789abcdef|diagram.png]]";
const BACKSPACE = String.fromCharCode(0xe003);

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
      if (opts.payloadLands === "intact") widget = true;
      else if (opts.payloadLands === "garbled") rec.doc += text.slice(1);
    },
    textContent: async () => rec.doc,
  };

  const session = new Session("http://127.0.0.1:0", "fake");
  Object.assign(session, {
    waitForElement: async () => content,
    findElements: async () => [content],
    // The helper's arrival probe, MODELLED rather than run: the real one is a
    // JavaScript string evaluated in the WebView, and nothing here has a DOM.
    // That is a real limit of this file and the reason for the assertion on
    // `EMBED_ARRIVAL_NEEDLE` below: without it, weakening the needle weakens
    // this model with it and every case here stays green.
    execute: async () => rec.doc.includes(EMBED_ARRIVAL_NEEDLE) || widget,
    send: async () => undefined,
  });
  return { session: session as unknown as Session, rec };
}

describe("typeEmbedIntoEditor", () => {
  it("requires the whole embed prefix, not just the `att:` inside it", () => {
    // The threshold, asserted directly, because the fake above MODELS the check
    // rather than running it: the real one is a string evaluated in the WebView.
    // Injected the weaker `att:` needle into `flows.ts` and watched all five
    // behavioural cases stay green, which is exactly the non-evidence the repo
    // rule warns about. This assertion is what fails on that edit.
    expect(
      EMBED_ARRIVAL_NEEDLE.startsWith("![["),
      "a payload that lost its leading `!` still contains `att:`, and `[[att:…]]` " +
        "is an ordinary wikilink that never builds an embed decoration — so the " +
        "needle has to carry the `![[` that distinguishes them",
    ).toBe(true);
    expect(EMBED_ARRIVAL_NEEDLE).toBe("![[att:");
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

  it("deletes a payload that lost its leading character before retyping", { timeout: 25_000 }, async () => {
    // The failure CI reported twice. `![[att:...]]` arriving as `[[att:...]]` is
    // an ordinary wikilink, so the embed decoration never builds and the raw
    // text stays in the buffer forever. An `att:` check passes this; the `![[att:`
    // check is what catches it, and this case is the reason the check is that
    // shape rather than the shorter one.
    const { session, rec } = fakeSession({ probeLandsAfter: 1, payloadLands: "garbled" });
    await expect(typeEmbedIntoEditor(session, EMBED)).rejects.toThrow(
      /embed source landed in the document \(after re-send\)/,
    );

    const backspaces = rec.sent.filter((k) => k === BACKSPACE).length;
    expect(
      backspaces,
      "one Backspace for the probe, then one per character of the garbled attempt: " +
        "appending a second embed instead would leave a stray fragment in a note " +
        "whose bytes are what the caller is testing",
    ).toBe(1 + (EMBED.length - 1));
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
      /embed source landed in the document \(after re-send\)/,
    );
    expect(
      rec.sent.filter((k) => k === EMBED),
      "one send, one re-send, and no more: a helper that re-sent per poll would " +
        "type the embed into the note a dozen times",
    ).toHaveLength(2);
  });
});
