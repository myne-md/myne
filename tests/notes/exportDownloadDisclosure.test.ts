// The download delivery path, and the disclosure that must precede it
// (phase3-web-client tasks 48 + 97 + 98).
//
// # Why the ORDER is the assertion
//
// Every test here that matters checks a sequence, not a value. Myne states its
// plaintext egress plainly, exactly once, at the decision point — and on
// desktop that "once" is the OS save dialog's title, which is on screen while
// the user is still choosing and free to dismiss.
//
// A browser download has neither property: `deliverFile` resolves with the file
// already handed to the browser. So a disclosure delivered afterwards is not a
// disclosure, it is a notification that plaintext has already left. A test that
// only asserted "the sentence appeared somewhere" would pass on exactly the
// implementation this exists to prevent — which is why these record the call
// order and assert against it.
//
// # Why the flows are exercised through the real module graph
//
// The capability check and the delivery seam are both mocked, and nothing else
// is. `has("nativeSaveAs")` is the branch under test, and mocking the flow
// itself would test the mock. The point is that a browser build takes the
// download arm and that arm says the sentence first.

import { beforeEach, describe, expect, it, vi } from "vitest";

/** Ordered log of the two things whose sequence is the property. */
let calls: string[] = [];

const deliverFileMock = vi.fn();
const confirmEgressMock = vi.fn();
const saveMock = vi.fn();
const invokeMock = vi.fn();

vi.mock("@tauri-apps/plugin-dialog", () => ({
  save: (...a: unknown[]) => saveMock(...a),
}));
vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...a: unknown[]) => invokeMock(...a),
}));
vi.mock("@tauri-apps/plugin-opener", () => ({ revealItemInDir: vi.fn() }));

// The browser build: every capability except the one that picks the delivery
// arm. Narrow on purpose — a blanket `() => false` would also switch off
// unrelated affordances and make a green test mean less than it looks.
vi.mock("../../src/platform/capabilities", () => ({
  has: (cap: string) => cap !== "nativeSaveAs",
}));
vi.mock("../../src/platform/download", () => ({
  deliverFile: (...a: unknown[]) => {
    calls.push("deliver");
    return deliverFileMock(...a);
  },
}));

import {
  runNoteExportFlow,
  runNoteHtmlExportFlow,
  runNoteTxtExportFlow,
} from "../../src/notes/exportFlow";
import {
  EXPORT_PLAIN_HTML_SENTENCE,
  EXPORT_PLAIN_MARKDOWN_SENTENCE,
  EXPORT_PLAIN_TEXT_SENTENCE,
} from "../../src/lib/load-bearing-copy";

const NOTE_ID = "0190a5e2-1111-7000-8000-000000000001";
const BODY = "# Heading\n\nplaintext body\n";

/** A `confirmEgress` that records when it ran and answers `answer`. */
function egressHook(answer: boolean) {
  return (sentence: string) => {
    calls.push("disclose");
    confirmEgressMock(sentence);
    return Promise.resolve(answer);
  };
}

beforeEach(() => {
  calls = [];
  deliverFileMock.mockReset().mockResolvedValue(undefined);
  confirmEgressMock.mockReset();
  saveMock.mockReset();
  invokeMock.mockReset();
});

/** The three shipping single-file formats, with the sentence each one owes. */
const FORMATS = [
  {
    name: "markdown",
    run: runNoteExportFlow,
    sentence: EXPORT_PLAIN_MARKDOWN_SENTENCE,
    filename: "My note.md",
    mime: "text/markdown",
  },
  {
    name: "html",
    run: runNoteHtmlExportFlow,
    sentence: EXPORT_PLAIN_HTML_SENTENCE,
    filename: "My note.html",
    mime: "text/html",
  },
  {
    name: "txt",
    run: runNoteTxtExportFlow,
    sentence: EXPORT_PLAIN_TEXT_SENTENCE,
    filename: "My note.txt",
    mime: "text/plain",
  },
] as const;

describe.each(FORMATS)("$name export on the download path", (fmt) => {
  it("says the egress sentence BEFORE any bytes leave", async () => {
    await fmt.run({
      noteId: NOTE_ID,
      noteTitle: "My note",
      showToast: vi.fn(),
      confirmEgress: egressHook(true),
      getBody: () => Promise.resolve(BODY),
    });
    // The whole point. `["deliver", "disclose"]` — a post-download toast — is
    // the implementation this file exists to fail.
    expect(calls).toEqual(["disclose", "deliver"]);
  });

  it("renders the sanctioned sentence VERBATIM, not a paraphrase", async () => {
    await fmt.run({
      noteId: NOTE_ID,
      noteTitle: "My note",
      showToast: vi.fn(),
      confirmEgress: egressHook(true),
      getBody: () => Promise.resolve(BODY),
    });
    // Full-string equality, not `toContain`: the exact wording is the privacy
    // property, and a keyword match would pass on a reworded sentence.
    expect(confirmEgressMock).toHaveBeenCalledWith(fmt.sentence);
  });

  it("delivers nothing when the user declines — a free exit", async () => {
    const showToast = vi.fn();
    await fmt.run({
      noteId: NOTE_ID,
      noteTitle: "My note",
      showToast,
      confirmEgress: egressHook(false),
      getBody: () => Promise.resolve(BODY),
    });
    expect(deliverFileMock).not.toHaveBeenCalled();
    // Declining is a decision, not a failure. An error toast here would read as
    // "something went wrong" for a choice the user deliberately made.
    expect(showToast).not.toHaveBeenCalled();
  });

  it("REFUSES to deliver when there is no disclosure surface at all", async () => {
    // The fail-closed half. `confirmEgress` is optional on the options, like the
    // other modal hooks — but the degrade the others document ("export
    // note-only") has no analogue here. Proceeding would ship plaintext with
    // nothing said, which is worse than not exporting at all.
    const showToast = vi.fn();
    await fmt.run({
      noteId: NOTE_ID,
      noteTitle: "My note",
      showToast,
      getBody: () => Promise.resolve(BODY),
    });
    expect(deliverFileMock).not.toHaveBeenCalled();
    expect(showToast).toHaveBeenCalled(); // unlike a decline, this IS a failure
  });

  it("treats a throwing disclosure hook as consent withheld", async () => {
    await fmt.run({
      noteId: NOTE_ID,
      noteTitle: "My note",
      showToast: vi.fn(),
      confirmEgress: () => Promise.reject(new Error("modal blew up")),
      getBody: () => Promise.resolve(BODY),
    });
    expect(deliverFileMock).not.toHaveBeenCalled();
  });

  it("never opens a save dialog on this platform", async () => {
    // The regression that motivated the html/txt arms: both called
    // `saveFileDialog` unconditionally, and a browser's typed refusal fell into
    // the flow's `.catch(() => null)`, which reads as "user dismissed". The
    // command was offered, did nothing, and said nothing.
    await fmt.run({
      noteId: NOTE_ID,
      noteTitle: "My note",
      showToast: vi.fn(),
      confirmEgress: egressHook(true),
      getBody: () => Promise.resolve(BODY),
    });
    expect(saveMock).not.toHaveBeenCalled();
    expect(deliverFileMock).toHaveBeenCalledTimes(1);
  });

  it("delivers the right name and MIME type", async () => {
    await fmt.run({
      noteId: NOTE_ID,
      noteTitle: "My note",
      showToast: vi.fn(),
      confirmEgress: egressHook(true),
      getBody: () => Promise.resolve(BODY),
    });
    const [name, bytes, mime] = deliverFileMock.mock.calls[0] as [
      string,
      Uint8Array,
      string,
    ];
    expect(name).toBe(fmt.filename);
    expect(mime).toBe(fmt.mime);
    expect(bytes.byteLength).toBeGreaterThan(0);
  });
});

describe("the sentence is said once, not twice", () => {
  it("skips the confirmation when the pre-flight modal already showed it", async () => {
    // SYNC-6: said once, at the decision point. Saying it twice in one flow
    // reads as a warning escalating, which trains the user to click through
    // both — the failure mode a second telling is supposed to prevent.
    const ATT = "a".repeat(64);
    await runNoteExportFlow({
      noteId: NOTE_ID,
      noteTitle: "My note",
      showToast: vi.fn(),
      confirmAttachments: () => Promise.resolve({ includeAttachments: false }),
      confirmEgress: egressHook(true),
      getBody: () => Promise.resolve(`body ![[att:${ATT}|one.png]]`),
    });
    expect(confirmEgressMock).not.toHaveBeenCalled();
    expect(deliverFileMock).toHaveBeenCalledTimes(1);
  });

  it("still asks when the pre-flight was skipped for want of attachments", async () => {
    await runNoteExportFlow({
      noteId: NOTE_ID,
      noteTitle: "My note",
      showToast: vi.fn(),
      confirmAttachments: () => Promise.resolve(null),
      confirmEgress: egressHook(true),
      getBody: () => Promise.resolve(BODY), // no embeds → modal never opens
    });
    expect(confirmEgressMock).toHaveBeenCalledWith(EXPORT_PLAIN_MARKDOWN_SENTENCE);
  });
});
