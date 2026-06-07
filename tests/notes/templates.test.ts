// Unit tests for `src/notes/templates.ts` — template CRUD orchestrators over
// the existing note IPC (MYND-187). createTemplate mints via note_create;
// convert* toggle the `template:` flag via note_update (no `updated:` bump);
// deleteTemplate delegates to soft-trash; listTemplates filters note_list +
// loadNoteBatch by the value-strict `template:` flag. Mirrors trashNote.test.ts.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const invokeMock = vi.fn();

vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => invokeMock(...args),
}));

import {
  createTemplate,
  convertNoteToTemplate,
  convertTemplateToNote,
  deleteTemplate,
  listTemplates,
} from "../../src/notes/templates";

beforeEach(() => invokeMock.mockReset());
afterEach(() => invokeMock.mockReset());

function routeReadThenUpdate(read: string): void {
  invokeMock.mockImplementation((cmd: string) => {
    if (cmd === "plugin:notes|note_read") return Promise.resolve(read);
    if (cmd === "plugin:notes|note_update") return Promise.resolve(undefined);
    return Promise.reject(new Error(`unexpected command ${cmd}`));
  });
}

function lastBody(cmd: string): string {
  const call = [...invokeMock.mock.calls].reverse().find(([c]) => c === cmd);
  return (call?.[1] as { plaintext: string }).plaintext;
}

describe("createTemplate", () => {
  it("mints a note with title + template: true + verbatim body via note_create", async () => {
    invokeMock.mockResolvedValueOnce("00000000-0000-7000-8000-000000000001");
    const id = await createTemplate("Meeting", "# Agenda\n\n- {{date}}\n");
    expect(id).toBe("00000000-0000-7000-8000-000000000001");
    const body = lastBody("plugin:notes|note_create");
    expect(body).toBe(
      "---\ntitle: Meeting\ntemplate: true\n---\n\n# Agenda\n\n- {{date}}\n",
    );
  });

  it("stores the body raw — no {{...}} substitution at create time", async () => {
    invokeMock.mockResolvedValueOnce("id-x");
    await createTemplate("Daily", "{{date}} {{weekday}} {{unknown}}");
    expect(lastBody("plugin:notes|note_create")).toContain(
      "{{date}} {{weekday}} {{unknown}}",
    );
  });

  it("quotes a YAML-unsafe name via the title patcher", async () => {
    invokeMock.mockResolvedValueOnce("id-y");
    await createTemplate("Re: notes", "body");
    expect(lastBody("plugin:notes|note_create")).toContain('title: "Re: notes"');
  });

  it("rejects with the underlying note_create error", async () => {
    invokeMock.mockRejectedValueOnce({ kind: "Io" });
    await expect(createTemplate("X", "y")).rejects.toMatchObject({ kind: "Io" });
  });
});

describe("convertNoteToTemplate", () => {
  it("sets template: true on a normal note", async () => {
    routeReadThenUpdate("---\ntitle: Foo\n---\n\nbody");
    await convertNoteToTemplate("id-1");
    expect(lastBody("plugin:notes|note_update")).toBe(
      "---\ntitle: Foo\ntemplate: true\n---\n\nbody",
    );
  });

  it("does NOT add or bump updated: (flag toggle, not a content edit)", async () => {
    routeReadThenUpdate("# Hello\nbody\n");
    await convertNoteToTemplate("id-1");
    expect(lastBody("plugin:notes|note_update")).not.toContain("updated:");
  });

  it("is idempotent on an already-template note (single template line)", async () => {
    routeReadThenUpdate("---\ntemplate: true\n---\n\nbody");
    await convertNoteToTemplate("id-2");
    const body = lastBody("plugin:notes|note_update");
    const lines = body.split("\n").filter((l) => /^template:/.test(l));
    expect(lines).toHaveLength(1);
    expect(body).toBe("---\ntemplate: true\n---\n\nbody");
  });

  it("rejects when note_read rejects", async () => {
    invokeMock.mockImplementation((cmd: string) =>
      cmd === "plugin:notes|note_read"
        ? Promise.reject({ kind: "NoteNotFound" })
        : Promise.resolve(undefined),
    );
    await expect(convertNoteToTemplate("id-x")).rejects.toMatchObject({
      kind: "NoteNotFound",
    });
  });
});

describe("convertTemplateToNote", () => {
  it("removes the template field, returning a single-field note to bare body", async () => {
    routeReadThenUpdate("---\ntemplate: true\n---\n\n# Body");
    await convertTemplateToNote("id-1");
    expect(lastBody("plugin:notes|note_update")).toBe("# Body");
  });

  it("preserves title + body when demoting", async () => {
    routeReadThenUpdate("---\ntitle: Meeting\ntemplate: true\n---\n\n# Body");
    await convertTemplateToNote("id-2");
    const body = lastBody("plugin:notes|note_update");
    expect(body).toBe("---\ntitle: Meeting\n---\n\n# Body");
  });

  it("convert→convert-back round-trips to the original bytes", async () => {
    routeReadThenUpdate("---\ntitle: Meeting\n---\n\n# Note");
    await convertNoteToTemplate("id-3");
    const marked = lastBody("plugin:notes|note_update");

    invokeMock.mockReset();
    routeReadThenUpdate(marked);
    await convertTemplateToNote("id-3");
    expect(lastBody("plugin:notes|note_update")).toBe(
      "---\ntitle: Meeting\n---\n\n# Note",
    );
  });
});

describe("deleteTemplate — delegates to soft-trash (distinct from unflag)", () => {
  it("writes a recoverable trashed: marker, leaving template: true intact", async () => {
    routeReadThenUpdate("---\ntemplate: true\n---\n\nbody");
    await deleteTemplate("id-1");
    const body = lastBody("plugin:notes|note_update");
    expect(body).toMatch(/trashed: \d{4}-\d{2}-\d{2}T/);
    // delete (soft-trash) keeps the template flag — distinct from convert-to-note
    expect(body).toContain("template: true");
  });

  it("rejects with the underlying trash error", async () => {
    invokeMock.mockImplementation((cmd: string) =>
      cmd === "plugin:notes|note_read"
        ? Promise.reject({ kind: "Io" })
        : Promise.resolve(undefined),
    );
    await expect(deleteTemplate("id-x")).rejects.toMatchObject({ kind: "Io" });
  });
});

describe("listTemplates — value-strict template filter, trashed excluded", () => {
  function okSlice(uuid: string, fmBody: string) {
    return {
      Ok: { note_uuid: uuid, frontmatter_bytes: fmBody, first_h1_line: null },
    };
  }

  it("returns only template: true notes, excluding ordinary + trashed templates", async () => {
    invokeMock.mockImplementation((cmd: string) => {
      if (cmd === "plugin:notes|note_list")
        return Promise.resolve(["tmpl", "note", "trashTmpl", "fakeTmpl"]);
      if (cmd === "plugin:notes|note_titles_batch")
        return Promise.resolve([
          okSlice("tmpl", "title: Real\ntemplate: true\n"),
          okSlice("note", "title: Ordinary\n"),
          okSlice(
            "trashTmpl",
            "template: true\ntrashed: 2026-06-03T11:00:00Z\n",
          ),
          okSlice("fakeTmpl", "template: yes\n"), // non-canonical → not a template
        ]);
      return Promise.reject(new Error(`unexpected ${cmd}`));
    });
    const result = await listTemplates();
    expect(result.map((r) => r.noteUuid)).toEqual(["tmpl"]);
    expect(result[0]?.title).toBe("Real");
  });

  it("returns an empty list for a vault with no templates (start-empty)", async () => {
    invokeMock.mockImplementation((cmd: string) => {
      if (cmd === "plugin:notes|note_list") return Promise.resolve(["a", "b"]);
      if (cmd === "plugin:notes|note_titles_batch")
        return Promise.resolve([
          okSlice("a", "title: A\n"),
          okSlice("b", "title: B\n"),
        ]);
      return Promise.reject(new Error(`unexpected ${cmd}`));
    });
    expect(await listTemplates()).toEqual([]);
  });
});
