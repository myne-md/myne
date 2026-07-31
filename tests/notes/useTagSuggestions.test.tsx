// @vitest-environment jsdom
//
// `useTagSuggestions` (on-device-tag-suggestion MYND-651 task 7): the host-side
// state behind the inline band.
//
// The trigger, the pass and the accept writer are each tested alone; what only
// exists here is the composition — the gate that stops the whole surface, the
// per-note dismissal set, and the rule that a tag the note already carries is
// not a suggestion. The IPC seams (`suggest_tags`, the vault tag index) are
// mocked, so no Tauri command is invoked.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, renderHook, waitFor } from "@testing-library/react";

const suggestMock = vi.fn<(args: { noteId: string; prompt: string }) => Promise<string>>();
const tagTreeMock = vi.fn();

vi.mock("../../src/lib/ai-tags", async () => {
  const actual = await vi.importActual<typeof import("../../src/lib/ai-tags")>(
    "../../src/lib/ai-tags",
  );
  return {
    ...actual,
    suggestTagsForNote: (args: { noteId: string; prompt: string }) => suggestMock(args),
  };
});

vi.mock("../../src/notes/vaultIndices", () => ({
  tagTree: () => tagTreeMock(),
}));

import { useTagSuggestions } from "../../src/notes/useTagSuggestions";

const BODY = "---\ntitle: Notes\n---\n\nA note about borrow checking.\n";

/** Default props: on, unexcluded, a debounce short enough to await. */
function props(over: Partial<Parameters<typeof useTagSuggestions>[0]> = {}) {
  return {
    noteId: "note-1",
    body: BODY,
    folder: "",
    enabled: true,
    excludedFolders: [] as readonly string[],
    debounceMs: 5,
    ...over,
  };
}

beforeEach(() => {
  suggestMock.mockResolvedValue("rust, compilers");
  tagTreeMock.mockResolvedValue([{ display: "rust" }]);
});

afterEach(() => {
  suggestMock.mockReset();
  tagTreeMock.mockReset();
});

describe("the gate", () => {
  it("never calls the model while the feature is off", async () => {
    const { result } = renderHook(() => useTagSuggestions(props({ enabled: false })));
    await new Promise((r) => setTimeout(r, 30));
    expect(suggestMock).not.toHaveBeenCalled();
    expect(result.current.suggestions).toEqual([]);
  });

  it("clears the band the moment the feature is switched off", async () => {
    const { result, rerender } = renderHook((p: Parameters<typeof useTagSuggestions>[0]) =>
      useTagSuggestions(p),
    { initialProps: props() });
    await waitFor(() => expect(result.current.suggestions).toHaveLength(2));
    rerender(props({ enabled: false }));
    expect(result.current.suggestions).toEqual([]);
  });

  it("never calls the model with no note open", async () => {
    renderHook(() => useTagSuggestions(props({ noteId: null })));
    await new Promise((r) => setTimeout(r, 30));
    expect(suggestMock).not.toHaveBeenCalled();
  });

  it("never calls the model for an AI-excluded folder", async () => {
    renderHook(() =>
      useTagSuggestions(props({ folder: "private/", excludedFolders: ["private"] })),
    );
    await new Promise((r) => setTimeout(r, 30));
    expect(suggestMock).not.toHaveBeenCalled();
  });
});

describe("the chips", () => {
  it("surfaces the ranked suggestions, existing vocabulary marked as such", async () => {
    const { result } = renderHook(() => useTagSuggestions(props()));
    await waitFor(() => expect(result.current.suggestions).toHaveLength(2));
    expect(result.current.suggestions).toEqual([
      { tag: "rust", isNew: false },
      { tag: "compilers", isNew: true },
    ]);
  });

  it("drops a suggestion the note already carries", async () => {
    // After an accept the model legitimately proposes the same tag again — now
    // as existing vocabulary. A chip that would write nothing is not a chip.
    const withTag = "---\ntags:\n  - rust\n---\n\nA note about borrow checking.\n";
    const { result } = renderHook(() => useTagSuggestions(props({ body: withTag })));
    await waitFor(() => expect(result.current.suggestions).toHaveLength(1));
    expect(result.current.suggestions[0]!.tag).toBe("compilers");
  });

  it("drops a suggestion the note carries as an inline #tag", async () => {
    const inline = "---\ntitle: Notes\n---\n\nAbout #compilers today.\n";
    const { result } = renderHook(() => useTagSuggestions(props({ body: inline })));
    await waitFor(() => expect(result.current.suggestions).toHaveLength(1));
    expect(result.current.suggestions[0]!.tag).toBe("rust");
  });
});

describe("dismissal", () => {
  it("hides a dismissed tag without touching the others", async () => {
    const { result } = renderHook(() => useTagSuggestions(props()));
    await waitFor(() => expect(result.current.suggestions).toHaveLength(2));
    act(() => result.current.dismiss("rust"));
    expect(result.current.suggestions.map((s) => s.tag)).toEqual(["compilers"]);
  });

  it("dismisses under the tag-identity fold, not by exact bytes", async () => {
    const { result } = renderHook(() => useTagSuggestions(props()));
    await waitFor(() => expect(result.current.suggestions).toHaveLength(2));
    act(() => result.current.dismiss("RUST"));
    expect(result.current.suggestions.map((s) => s.tag)).toEqual(["compilers"]);
  });

  it("is scoped to the note — switching notes brings a fresh set", async () => {
    // A dismissal is a judgement about THIS note, and it is RAM-only: nothing
    // about it is written to disk (SYNC-8).
    const { result, rerender } = renderHook((p: Parameters<typeof useTagSuggestions>[0]) =>
      useTagSuggestions(p),
    { initialProps: props() });
    await waitFor(() => expect(result.current.suggestions).toHaveLength(2));
    act(() => result.current.dismiss("rust"));
    expect(result.current.suggestions).toHaveLength(1);

    rerender(props({ noteId: "note-2" }));
    await waitFor(() => expect(result.current.suggestions).toHaveLength(2));
  });
});

describe("referential stability", () => {
  it("returns the SAME array while the chips are unchanged", async () => {
    // The band is pushed into CodeMirror as a state effect, so a fresh array on
    // every keystroke would dispatch a transaction (and rebuild the decoration)
    // per character typed in a note that has a band up. `plan` IS rebuilt every
    // keystroke — this is the memo that keeps that invisible.
    const { result, rerender } = renderHook((p: Parameters<typeof useTagSuggestions>[0]) =>
      useTagSuggestions(p),
    { initialProps: props() });
    await waitFor(() => expect(result.current.suggestions).toHaveLength(2));
    const first = result.current.suggestions;

    // An edit that adds body text the model was already going to answer the same
    // way for: the pass re-runs, the chip list comes back identical.
    rerender(props({ body: `${BODY}One more sentence.\n` }));
    await new Promise((r) => setTimeout(r, 30));
    expect(result.current.suggestions).toBe(first);

    // A rerender with no input change at all must not churn it either.
    rerender(props({ body: `${BODY}One more sentence.\n` }));
    expect(result.current.suggestions).toBe(first);
  });

  it("hands back a new array as soon as the chips actually change", async () => {
    const { result } = renderHook(() => useTagSuggestions(props()));
    await waitFor(() => expect(result.current.suggestions).toHaveLength(2));
    const first = result.current.suggestions;

    act(() => result.current.dismiss("rust"));
    expect(result.current.suggestions).not.toBe(first);
    expect(result.current.suggestions.map((s) => s.tag)).toEqual(["compilers"]);
  });
});
