// Unit tests for src/notes/newNoteFromTemplate.ts (MYND-190) — the
// render-then-create instantiation seam. Pure parts (buildRenderContext,
// extractTemplateBody) are tested directly; createNoteFromTemplate is tested
// over mocked note_read / note_create with an injected fixed `now`.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const invokeMock = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => invokeMock(...args),
}));

import {
  buildRenderContext,
  extractTemplateBody,
  createNoteFromTemplate,
} from "../../src/notes/newNoteFromTemplate";

beforeEach(() => invokeMock.mockReset());
afterEach(() => invokeMock.mockReset());

function routeReadThenCreate(read: string, newId = "new-note-id"): void {
  invokeMock.mockImplementation((cmd: string) => {
    if (cmd === "plugin:notes|note_read") return Promise.resolve(read);
    if (cmd === "plugin:notes|note_create") return Promise.resolve(newId);
    return Promise.reject(new Error(`unexpected command ${cmd}`));
  });
}

function lastCreateBody(): string {
  const call = [...invokeMock.mock.calls]
    .reverse()
    .find(([c]) => c === "plugin:notes|note_create");
  return (call?.[1] as { plaintext: string }).plaintext;
}

// Fixed local instant: 01:00 on 2026-06-07 (a Sunday).
const NOW = new Date(2026, 5, 7, 1, 0, 0);

describe("buildRenderContext — host-side local formatting", () => {
  it("formats date / time / datetime in local time", () => {
    const ctx = buildRenderContext(NOW, "My Note");
    expect(ctx.date).toBe("2026-06-07");
    expect(ctx.time).toBe("01:00");
    expect(ctx.datetime).toBe("2026-06-07 01:00");
    expect(ctx.title).toBe("My Note");
  });
  it("keeps the local calendar day for an early-morning instant (no UTC off-by-one)", () => {
    // 01:00 local — in a positive UTC offset this is the previous UTC day, but
    // the local-formatted date must remain 2026-06-07.
    expect(buildRenderContext(NOW, "x").date).toBe("2026-06-07");
  });
});

describe("extractTemplateBody", () => {
  it("strips the frontmatter block and its separator blank line", () => {
    expect(
      extractTemplateBody("---\ntitle: T\ntemplate: true\n---\n\n# Body\ntext"),
    ).toBe("# Body\ntext");
  });
  it("returns the whole input when there is no frontmatter", () => {
    expect(extractTemplateBody("# Just a body")).toBe("# Just a body");
  });
});

describe("createNoteFromTemplate", () => {
  const TEMPLATE =
    "---\ntitle: Meeting template\ntemplate: true\n---\n\n# {{title}} — {{date}}\n\nAttendees: {{project}}\n";

  it("renders {{title}} + {{date}} once and writes the supplied name as title:", async () => {
    routeReadThenCreate(TEMPLATE);
    const id = await createNoteFromTemplate("tmpl-1", "Standup", null, NOW);
    expect(id).toBe("new-note-id");
    const body = lastCreateBody();
    expect(body).toContain("title: Standup");
    expect(body).toContain("# Standup — 2026-06-07");
  });

  it("leaves an unknown token verbatim", async () => {
    routeReadThenCreate(TEMPLATE);
    await createNoteFromTemplate("tmpl-1", "Standup", null, NOW);
    expect(lastCreateBody()).toContain("Attendees: {{project}}");
  });

  it("does NOT carry over the template flag or the template's own title", async () => {
    routeReadThenCreate(TEMPLATE);
    await createNoteFromTemplate("tmpl-1", "Standup", null, NOW);
    const body = lastCreateBody();
    expect(body).not.toContain("template: true");
    expect(body).not.toContain("Meeting template");
  });

  it("threads the folder so the note lands in the active create context", async () => {
    routeReadThenCreate(TEMPLATE);
    await createNoteFromTemplate("tmpl-1", "Standup", "Journal/", NOW);
    expect(lastCreateBody()).toContain("folder: Journal/");
  });

  it("creates at the root (no folder field) when folder is null", async () => {
    routeReadThenCreate(TEMPLATE);
    await createNoteFromTemplate("tmpl-1", "Standup", null, NOW);
    expect(lastCreateBody()).not.toContain("folder:");
  });

  it("goes through note_create only — never note_update", async () => {
    routeReadThenCreate(TEMPLATE);
    await createNoteFromTemplate("tmpl-1", "Standup", null, NOW);
    const cmds = invokeMock.mock.calls.map(([c]) => c);
    expect(cmds).toContain("plugin:notes|note_create");
    expect(cmds).not.toContain("plugin:notes|note_update");
  });

  it("rejects with the underlying note_read error", async () => {
    invokeMock.mockImplementation((cmd: string) =>
      cmd === "plugin:notes|note_read"
        ? Promise.reject({ kind: "NoteNotFound" })
        : Promise.resolve("id"),
    );
    await expect(
      createNoteFromTemplate("missing", "X", null, NOW),
    ).rejects.toMatchObject({ kind: "NoteNotFound" });
  });
});
