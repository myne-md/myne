// MYND-116 tasks 1+3+4: the shared per-note "Export as Markdown…" flow
// (`src/notes/exportFlow.ts`) + the closed-enum → copy mappings
// (`src/lib/note-export-errors.ts`; backup-ui.test.ts is the precedent).
//
// Both trigger surfaces (sidebar context menu + palette action) call
// `runNoteExportFlow` — these tests pin the flow's contract once:
// pre-flight gating (no attachments → straight to the dialog; N > 0 →
// the `confirmAttachments` hook is asked with the count; cancel = free
// exit, no export IPC); dialog dismissed → silent no-op (nothing
// invoked, nothing shown); success → "Exported to <basename>" (never
// the full path in the TEXT — the full path rides `revealPath` for the
// "Show in folder" action); failure → mapped plain-English copy via the
// same toast sink.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const saveMock = vi.fn();
const invokeMock = vi.fn();
const revealMock = vi.fn();

vi.mock("@tauri-apps/plugin-dialog", () => ({
  save: (...args: unknown[]) => saveMock(...args),
}));
vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => invokeMock(...args),
}));
vi.mock("@tauri-apps/plugin-opener", () => ({
  revealItemInDir: (...args: unknown[]) => revealMock(...args),
}));

import {
  defaultExportFilename,
  exportedBasename,
  exportToastAction,
  runNoteExportFlow,
  splitExportPath,
} from "../../src/notes/exportFlow";
import {
  noteExportAttachmentsErrorMessage,
  noteExportErrorMessage,
} from "../../src/lib/note-export-errors";
import { EXPORT_PLAIN_MARKDOWN_SENTENCE } from "../../src/lib/load-bearing-copy";
import type {
  NoteExportAttachmentsError,
  NoteExportError,
} from "../../src/types/note-export-error";

beforeEach(() => {
  saveMock.mockReset();
  invokeMock.mockReset();
  revealMock.mockReset();
});
afterEach(() => {
  saveMock.mockReset();
  invokeMock.mockReset();
  revealMock.mockReset();
});

const NOTE_ID = "0190a5e2-1111-7000-8000-000000000001";
const ATT_A = "a".repeat(64);
const ATT_B = "b".repeat(64);
/** Two distinct form-C embeds (the second repeated — the scan de-dups). */
const BODY_WITH_ATTACHMENTS = [
  `intro ![[att:${ATT_A}|one.png]]`,
  `again ![[att:${ATT_B}|two.pdf]] and ![[att:${ATT_B}|two.pdf]]`,
].join("\n");

describe("defaultExportFilename", () => {
  it("derives <title>.md from the note title", () => {
    expect(defaultExportFilename("Weekly review")).toBe("Weekly review.md");
  });

  it("falls back to Untitled.md for null / empty / whitespace titles", () => {
    expect(defaultExportFilename(null)).toBe("Untitled.md");
    expect(defaultExportFilename(undefined)).toBe("Untitled.md");
    expect(defaultExportFilename("")).toBe("Untitled.md");
    expect(defaultExportFilename("   ")).toBe("Untitled.md");
  });

  it("replaces path separators with _ and nothing else (OS dialog owns the rest)", () => {
    expect(defaultExportFilename("a/b\\c")).toBe("a_b_c.md");
    expect(defaultExportFilename("notes: a*b?")).toBe("notes: a*b?.md");
  });
});

describe("runNoteExportFlow", () => {
  it("opens the save dialog with the derived default filename + Markdown filter + the egress sentence as the dialog title (no-modal path)", async () => {
    saveMock.mockResolvedValue(null);
    await runNoteExportFlow({
      noteId: NOTE_ID,
      noteTitle: "My note",
      showToast: vi.fn(),
    });
    // Full-literal args: on the common no-modal path the load-bearing
    // egress sentence rides the dialog title (SYNC-6 — said once at the
    // decision point; 116-M1).
    expect(saveMock).toHaveBeenCalledWith({
      title: EXPORT_PLAIN_MARKDOWN_SENTENCE,
      defaultPath: "My note.md",
      filters: [{ name: "Markdown", extensions: ["md"] }],
    });
  });

  it("null IPC rejection → generic fallback copy, never a throw (never-throws contract)", async () => {
    saveMock.mockResolvedValue("/home/u/Desktop/x.md");
    invokeMock.mockRejectedValue(null);
    const showToast = vi.fn();
    await expect(
      runNoteExportFlow({ noteId: NOTE_ID, noteTitle: "x", showToast }),
    ).resolves.toBeUndefined();
    expect(showToast).toHaveBeenCalledWith({
      message: "Export failed unexpectedly. Try again.",
    });
  });

  it("dialog dismissed → silent no-op: no IPC, no toast", async () => {
    saveMock.mockResolvedValue(null);
    const showToast = vi.fn();
    await runNoteExportFlow({ noteId: NOTE_ID, noteTitle: "x", showToast });
    expect(invokeMock).not.toHaveBeenCalled();
    expect(showToast).not.toHaveBeenCalled();
  });

  it("dialog rejection is treated as dismissal (silent no-op)", async () => {
    saveMock.mockRejectedValue(new Error("dialog unavailable"));
    const showToast = vi.fn();
    await runNoteExportFlow({ noteId: NOTE_ID, noteTitle: "x", showToast });
    expect(invokeMock).not.toHaveBeenCalled();
    expect(showToast).not.toHaveBeenCalled();
  });

  it("path chosen → invokes note_export_as_markdown with overwrite=true and toasts the basename only", async () => {
    saveMock.mockResolvedValue("/home/u/Desktop/My note.md");
    invokeMock.mockResolvedValue(undefined);
    const showToast = vi.fn();
    await runNoteExportFlow({
      noteId: NOTE_ID,
      noteTitle: "My note",
      showToast,
    });
    expect(invokeMock).toHaveBeenCalledWith(
      "plugin:notes|note_export_as_markdown",
      { noteId: NOTE_ID, targetPath: "/home/u/Desktop/My note.md", overwrite: true },
    );
    expect(showToast).toHaveBeenCalledTimes(1);
    // Basename in the TEXT; the full path rides revealPath only (task 4).
    expect(showToast).toHaveBeenCalledWith({
      message: "Exported to My note.md",
      revealPath: "/home/u/Desktop/My note.md",
    });
  });

  it("backend rejection → toasts the mapped copy for the variant", async () => {
    saveMock.mockResolvedValue("/home/u/Desktop/Gone.md");
    invokeMock.mockRejectedValue({ kind: "NoteNotFound" });
    const showToast = vi.fn();
    await runNoteExportFlow({ noteId: NOTE_ID, noteTitle: "Gone", showToast });
    expect(showToast).toHaveBeenCalledWith({
      message: noteExportErrorMessage({ kind: "NoteNotFound" }),
    });
  });

  it("out-of-contract rejection shape → generic fallback copy", async () => {
    saveMock.mockResolvedValue("/home/u/Desktop/x.md");
    invokeMock.mockRejectedValue("something opaque");
    const showToast = vi.fn();
    await runNoteExportFlow({ noteId: NOTE_ID, noteTitle: "x", showToast });
    expect(showToast).toHaveBeenCalledWith({
      message: "Export failed unexpectedly. Try again.",
    });
  });
});

describe("splitExportPath", () => {
  it("splits a unix path into dir + bare filename", () => {
    expect(splitExportPath("/home/u/Desktop/Note.md")).toEqual({
      dir: "/home/u/Desktop",
      filename: "Note.md",
    });
  });

  it("splits a windows path into dir + bare filename", () => {
    expect(splitExportPath("C:\\Users\\u\\Note.md")).toEqual({
      dir: "C:\\Users\\u",
      filename: "Note.md",
    });
  });

  it("keeps the separator when the parent is a filesystem root", () => {
    expect(splitExportPath("/Note.md")).toEqual({
      dir: "/",
      filename: "Note.md",
    });
    expect(splitExportPath("C:\\Note.md")).toEqual({
      dir: "C:\\",
      filename: "Note.md",
    });
  });

  it("bare filename → empty dir (backend rejects InvalidDestination)", () => {
    expect(splitExportPath("Note.md")).toEqual({ dir: "", filename: "Note.md" });
  });

  it("exportedBasename is the filename half (one separator scanner)", () => {
    expect(exportedBasename("/home/u/Desktop/Note.md")).toBe("Note.md");
    expect(exportedBasename("C:\\Users\\u\\Note.md")).toBe("Note.md");
    expect(exportedBasename("Note.md")).toBe("Note.md");
  });
});

describe("runNoteExportFlow — pre-flight attachments gating (task 3)", () => {
  it("note without attachments → hook never asked, straight to the dialog", async () => {
    saveMock.mockResolvedValue(null);
    const confirmAttachments = vi.fn();
    await runNoteExportFlow({
      noteId: NOTE_ID,
      noteTitle: "Plain",
      showToast: vi.fn(),
      confirmAttachments,
      getBody: async () => "no embeds here",
    });
    expect(confirmAttachments).not.toHaveBeenCalled();
    expect(saveMock).toHaveBeenCalledTimes(1);
  });

  it("attachments referenced → hook asked with the de-duplicated count", async () => {
    saveMock.mockResolvedValue(null);
    const confirmAttachments = vi.fn().mockResolvedValue({
      includeAttachments: false,
    });
    await runNoteExportFlow({
      noteId: NOTE_ID,
      noteTitle: "Atts",
      showToast: vi.fn(),
      confirmAttachments,
      getBody: async () => BODY_WITH_ATTACHMENTS,
    });
    expect(confirmAttachments).toHaveBeenCalledWith(2);
  });

  it("modal shown → dialog title omitted (the sentence was already said once at the decision point)", async () => {
    saveMock.mockResolvedValue(null);
    await runNoteExportFlow({
      noteId: NOTE_ID,
      noteTitle: "Atts",
      showToast: vi.fn(),
      confirmAttachments: vi.fn().mockResolvedValue({
        includeAttachments: false,
      }),
      getBody: async () => BODY_WITH_ATTACHMENTS,
    });
    // Full-literal args: NO `title` key — the pre-flight modal rendered
    // the egress sentence, so the dialog must not say it twice.
    expect(saveMock).toHaveBeenCalledWith({
      defaultPath: "Atts.md",
      filters: [{ name: "Markdown", extensions: ["md"] }],
    });
  });

  it("default body provider is the note_read IPC", async () => {
    saveMock.mockResolvedValue(null);
    invokeMock.mockImplementation((cmd: unknown) =>
      cmd === "plugin:notes|note_read"
        ? Promise.resolve(BODY_WITH_ATTACHMENTS)
        : Promise.resolve(undefined),
    );
    const confirmAttachments = vi.fn().mockResolvedValue(null);
    await runNoteExportFlow({
      noteId: NOTE_ID,
      noteTitle: "Atts",
      showToast: vi.fn(),
      confirmAttachments,
    });
    expect(invokeMock).toHaveBeenCalledWith("plugin:notes|note_read", {
      noteId: NOTE_ID,
    });
    expect(confirmAttachments).toHaveBeenCalledWith(2);
  });

  it("modal cancel = free exit: no dialog, no export IPC, no toast", async () => {
    const showToast = vi.fn();
    await runNoteExportFlow({
      noteId: NOTE_ID,
      noteTitle: "Atts",
      showToast,
      confirmAttachments: vi.fn().mockResolvedValue(null),
      getBody: async () => BODY_WITH_ATTACHMENTS,
    });
    expect(saveMock).not.toHaveBeenCalled();
    expect(invokeMock).not.toHaveBeenCalled();
    expect(showToast).not.toHaveBeenCalled();
  });

  it("no confirmAttachments hook → no body read at all (legacy direct-dialog path)", async () => {
    saveMock.mockResolvedValue(null);
    await runNoteExportFlow({
      noteId: NOTE_ID,
      noteTitle: "x",
      showToast: vi.fn(),
    });
    expect(invokeMock).not.toHaveBeenCalled();
  });

  it("body read failure degrades to a note-only export (no modal)", async () => {
    saveMock.mockResolvedValue(null);
    const confirmAttachments = vi.fn();
    await runNoteExportFlow({
      noteId: NOTE_ID,
      noteTitle: "x",
      showToast: vi.fn(),
      confirmAttachments,
      getBody: async () => Promise.reject({ kind: "VaultNotUnlocked" }),
    });
    expect(confirmAttachments).not.toHaveBeenCalled();
    expect(saveMock).toHaveBeenCalledTimes(1);
  });

  it("toggle OFF → note-only export via note_export_as_markdown", async () => {
    saveMock.mockResolvedValue("/home/u/Desktop/Atts.md");
    invokeMock.mockResolvedValue(undefined);
    const showToast = vi.fn();
    await runNoteExportFlow({
      noteId: NOTE_ID,
      noteTitle: "Atts",
      showToast,
      confirmAttachments: vi.fn().mockResolvedValue({
        includeAttachments: false,
      }),
      getBody: async () => BODY_WITH_ATTACHMENTS,
    });
    expect(invokeMock).toHaveBeenCalledWith(
      "plugin:notes|note_export_as_markdown",
      { noteId: NOTE_ID, targetPath: "/home/u/Desktop/Atts.md", overwrite: true },
    );
    expect(showToast).toHaveBeenCalledWith({
      message: "Exported to Atts.md",
      revealPath: "/home/u/Desktop/Atts.md",
    });
  });

  it("toggle ON → note_export_attachments with split dir/filename; toast carries the written count + revealPath", async () => {
    saveMock.mockResolvedValue("/home/u/Desktop/Atts.md");
    invokeMock.mockResolvedValue(2);
    const showToast = vi.fn();
    await runNoteExportFlow({
      noteId: NOTE_ID,
      noteTitle: "Atts",
      showToast,
      confirmAttachments: vi.fn().mockResolvedValue({
        includeAttachments: true,
      }),
      getBody: async () => BODY_WITH_ATTACHMENTS,
    });
    expect(invokeMock).toHaveBeenCalledWith(
      "plugin:notes|note_export_attachments",
      {
        noteId: NOTE_ID,
        targetDir: "/home/u/Desktop",
        noteFilename: "Atts.md",
        overwrite: true,
      },
    );
    expect(showToast).toHaveBeenCalledWith({
      message: "Exported to Atts.md + 2 attachments",
      revealPath: "/home/u/Desktop/Atts.md",
    });
  });

  it("attachments-branch rejection → mapped attachments copy, no revealPath", async () => {
    saveMock.mockResolvedValue("/home/u/Desktop/Atts.md");
    invokeMock.mockRejectedValue({ kind: "AttachmentMissing" });
    const showToast = vi.fn();
    await runNoteExportFlow({
      noteId: NOTE_ID,
      noteTitle: "Atts",
      showToast,
      confirmAttachments: vi.fn().mockResolvedValue({
        includeAttachments: true,
      }),
      getBody: async () => BODY_WITH_ATTACHMENTS,
    });
    expect(showToast).toHaveBeenCalledWith({
      message: noteExportAttachmentsErrorMessage({ kind: "AttachmentMissing" }),
    });
  });

  it("attachments-branch null IPC rejection → generic fallback copy, never a throw", async () => {
    saveMock.mockResolvedValue("/home/u/Desktop/Atts.md");
    invokeMock.mockRejectedValue(null);
    const showToast = vi.fn();
    await expect(
      runNoteExportFlow({
        noteId: NOTE_ID,
        noteTitle: "Atts",
        showToast,
        confirmAttachments: vi.fn().mockResolvedValue({
          includeAttachments: true,
        }),
        getBody: async () => BODY_WITH_ATTACHMENTS,
      }),
    ).resolves.toBeUndefined();
    expect(showToast).toHaveBeenCalledWith({
      message: "Export failed unexpectedly. Try again.",
    });
  });

  it("dialog dismissed after the modal → silent no-op (no export IPC)", async () => {
    saveMock.mockResolvedValue(null);
    const showToast = vi.fn();
    await runNoteExportFlow({
      noteId: NOTE_ID,
      noteTitle: "Atts",
      showToast,
      confirmAttachments: vi.fn().mockResolvedValue({
        includeAttachments: true,
      }),
      getBody: async () => BODY_WITH_ATTACHMENTS,
    });
    expect(invokeMock).not.toHaveBeenCalled();
    expect(showToast).not.toHaveBeenCalled();
  });
});

describe("exportToastAction (task 4 — Show in folder)", () => {
  it("success toast (revealPath present) → platform-neutral action revealing the file", () => {
    revealMock.mockResolvedValue(undefined);
    const dismiss = vi.fn();
    const action = exportToastAction(
      { message: "Exported to Note.md", revealPath: "/home/u/Desktop/Note.md" },
      dismiss,
    );
    expect(action).toBeDefined();
    expect(action?.label).toBe("Show in folder");
    action?.onAction();
    expect(revealMock).toHaveBeenCalledWith("/home/u/Desktop/Note.md");
    expect(dismiss).toHaveBeenCalledTimes(1);
  });

  it("error toast (no revealPath) → no action", () => {
    expect(
      exportToastAction({ message: "Could not write the exported file." }, vi.fn()),
    ).toBeUndefined();
  });
});

describe("noteExportErrorMessage closed-enum copy map", () => {
  // Every variant (with all reachable Io sub-kinds) → its mapped copy.
  // `NotFound` Io is special-cased upstream as NoteNotFound and never
  // surfaces, but the mapper must still answer for it (closed total map).
  const table: Array<[label: string, e: NoteExportError]> = [
    ["VaultNotUnlocked", { kind: "VaultNotUnlocked" }],
    ["InvalidNoteId", { kind: "InvalidNoteId" }],
    ["NoteNotFound", { kind: "NoteNotFound" }],
    ["CannotDecrypt", { kind: "CannotDecrypt" }],
    ["InvalidPlaintextEncoding", { kind: "InvalidPlaintextEncoding" }],
    ["InvalidDestination", { kind: "InvalidDestination" }],
    ["TargetAlreadyExists", { kind: "TargetAlreadyExists" }],
    ["Io/NoSpace", { kind: "Io", detail: { io_error_kind: "NoSpace" } }],
    [
      "Io/PermissionDenied",
      { kind: "Io", detail: { io_error_kind: "PermissionDenied" } },
    ],
    ["Io/NotFound", { kind: "Io", detail: { io_error_kind: "NotFound" } }],
    ["Io/Other", { kind: "Io", detail: { io_error_kind: "Other" } }],
    ["JoinFailure", { kind: "JoinFailure" }],
  ];

  it("covers every NoteExportError variant with non-empty copy", () => {
    for (const [, e] of table) {
      expect(noteExportErrorMessage(e).length).toBeGreaterThan(0);
    }
  });

  it("distinct variants read distinctly (Io/NotFound + Io/Other share the residual write line)", () => {
    const messages = table.map(([, e]) => noteExportErrorMessage(e));
    // Io/NotFound never surfaces in practice (special-cased upstream as
    // NoteNotFound) — it shares the residual "could not write" copy with
    // Io/Other. Every other pair must differ.
    const unique = new Set(messages);
    expect(unique.size).toBe(messages.length - 1);
  });
});

describe("noteExportAttachmentsErrorMessage closed-enum copy map", () => {
  const attachmentsOnly: Array<[label: string, e: NoteExportAttachmentsError]> = [
    ["InvalidNoteFilename", { kind: "InvalidNoteFilename" }],
    ["InvalidVaultMeta", { kind: "InvalidVaultMeta" }],
    ["AttachmentMissing", { kind: "AttachmentMissing" }],
    ["AttachmentCorrupt", { kind: "AttachmentCorrupt" }],
  ];
  const shared: Array<[label: string, e: NoteExportError]> = [
    ["VaultNotUnlocked", { kind: "VaultNotUnlocked" }],
    ["InvalidNoteId", { kind: "InvalidNoteId" }],
    ["NoteNotFound", { kind: "NoteNotFound" }],
    ["CannotDecrypt", { kind: "CannotDecrypt" }],
    ["InvalidPlaintextEncoding", { kind: "InvalidPlaintextEncoding" }],
    ["InvalidDestination", { kind: "InvalidDestination" }],
    ["TargetAlreadyExists", { kind: "TargetAlreadyExists" }],
    ["Io/NoSpace", { kind: "Io", detail: { io_error_kind: "NoSpace" } }],
    ["JoinFailure", { kind: "JoinFailure" }],
  ];

  it("attachments-specific variants get non-empty, pairwise-distinct copy", () => {
    const messages = attachmentsOnly.map(([, e]) =>
      noteExportAttachmentsErrorMessage(e),
    );
    for (const m of messages) expect(m.length).toBeGreaterThan(0);
    expect(new Set(messages).size).toBe(messages.length);
  });

  it("variants shared with NoteExportError reuse its copy verbatim", () => {
    for (const [, e] of shared) {
      expect(noteExportAttachmentsErrorMessage(e)).toBe(
        noteExportErrorMessage(e),
      );
    }
  });
});
