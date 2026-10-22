// The agent IPC payload carries documents as `{ name, text }` and nothing else
// (myne-md/myne#913).
//
// `RunAttachment` also carries `id`/`contentType` so the transcript can draw the
// file a message sent. Those are the UI's own metadata: the host receives text
// and a name and ignores the rest, and a payload that grew fields the Rust side
// does not read is a contract nobody can audit. Asserted at the BINDING, because
// that is the only layer where the distinction between "what the app knows" and
// "what crosses the wire" exists.

import { describe, expect, it } from "vitest";
import { makeAgentRun } from "../../src/lib/agent-run-core";

describe("makeAgentRun.agentStart", () => {
  it("sends only the name and the text of each attachment", async () => {
    // The calls are captured rather than read back off `vi.fn().mock`, because
    // the binding's own signature is generic (`<T>(cmd) => Promise<T>`) and a
    // mock that infers a concrete payload type is not assignable to it. The
    // alternative, a cast on `mock.calls`, moves the untyped edge into the
    // assertion and reports the wrong thing when the payload shape changes.
    const calls: Array<[string, Record<string, unknown> | undefined]> = [];
    const invoke = (async (cmd: string, args?: Record<string, unknown>) => {
      calls.push([cmd, args]);
      return {
        view: { runId: "r", scopeTotal: 1, userGrants: 1, modelGrants: 0, cancelled: false },
        proposal: { edits: [], newNotes: [], summary: "" },
        end: { kind: "finished" },
        iterations: 0,
        notesRead: 0,
        charsOffDevice: null,
        excludedCount: 0,
      };
    }) as <T>(cmd: string, args?: Record<string, unknown>) => Promise<T>;
    class Channel<T> {
      onmessage: ((v: T) => void) | null = null;
    }
    const { agentStart } = makeAgentRun({ invoke, Channel: Channel as never });
    await agentStart(
      "summarise",
      { kind: "vault" },
      null,
      [],
      [],
      [
        {
          id: "aa11",
          contentType: "application/pdf",
          name: "lecture.pdf",
          text: "the lecture",
        },
      ],
    );
    const payload = calls[0]![1] as {
      attachments: Record<string, unknown>[];
    };
    expect(payload.attachments).toEqual([
      { name: "lecture.pdf", text: "the lecture" },
    ]);
    // The ids stay in the app: neither the attachment id nor its MIME hint has
    // any meaning to the host.
    expect(JSON.stringify(payload.attachments)).not.toContain("aa11");
    expect(JSON.stringify(payload.attachments)).not.toContain("application/pdf");
  });
});
