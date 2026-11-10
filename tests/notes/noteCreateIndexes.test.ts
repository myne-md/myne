// A note that is created reaches the index, because it was created
// (myne-md/myne#1037).
//
// The failure this pins is not a wrong answer, it is a missing one. `note_create`
// upserts the SEARCH index only, so a note nobody opens carried no property row
// until some later reconcile, and the note nobody opens is exactly what the
// calendar writes on a cell click. The note existed, the sidebar listed it, and
// the grid stayed empty until the app was restarted and the rebuild-on-unlock
// sweep indexed it.
//
// So the assertion is on the CHOKEPOINT rather than on a caller: `createEvent`
// is only this file's witness. Anything that creates a note, a template, a
// daily note, an `.ics` import, a duplicate, crosses `noteCreate`, and a fix at
// a call site is precisely how the calendar's path came to be left out.

import { beforeEach, describe, expect, it, vi } from "vitest";

const applied: string[] = [];
const created: string[] = [];

vi.mock("../../src/platform/core", () => ({
  invoke: async (command: string, args?: Record<string, unknown>) => {
    switch (command) {
      case "plugin:notes|note_create": {
        created.push(String(args?.["plaintext"] ?? ""));
        return "0199a000-0000-7000-8000-000000000001";
      }
      case "plugin:vault-indices|vault_indices_apply": {
        applied.push(JSON.stringify(args));
        return undefined;
      }
      default:
        return undefined;
    }
  },
}));

vi.mock("../../src/lib/prefs", () => ({
  mutateDeliberateFolders: async () => undefined,
}));

const { createEvent } = await import("../../src/notes/createEvent");
const { parseEventInstant } = await import("../../src/dialect/event");

describe("noteCreate registers the note in the index", () => {
  beforeEach(() => {
    applied.length = 0;
    created.length = 0;
  });

  it("applies the property rows a calendar row is read from", async () => {
    const start = parseEventInstant("2026-11-05 09:00");
    expect(start).not.toBeNull();
    if (start === null) return;

    await createEvent({ title: "Standup", start });
    // The apply is fire-and-forget, so let its microtasks land.
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    expect(created).toHaveLength(1);
    expect(applied).toHaveLength(1);
    const payload = JSON.parse(applied[0] ?? "{}") as {
      noteId?: string;
      properties?: { key: string; value: string | null }[];
    };
    expect(payload.noteId).toBe("0199a000-0000-7000-8000-000000000001");
    // The two properties `core/src/plugins/vault_indices/calendar.rs` reads to
    // answer "what happens between these two instants", asserted by value: an
    // apply that carries the note id and none of its vocabulary would satisfy a
    // call count and leave the grid empty all the same.
    const byKey = new Map(
      (payload.properties ?? []).map((p) => [p.key, p.value] as const),
    );
    expect(byKey.get("kind")).toBe("event");
    expect(byKey.get("start")).toBe("2026-11-05 09:00");
  });

  it("files the event at the vault root, not in a folder nobody asked for", async () => {
    const start = parseEventInstant("2026-11-05 09:00");
    if (start === null) throw new Error("fixture");
    await createEvent({ title: "Standup", start });
    expect(created[0]).not.toMatch(/folder:/);
  });
});
