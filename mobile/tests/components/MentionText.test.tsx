// @vitest-environment jsdom
//
// A note mention inside a chat turn (myne-md/myne#867).
//
// The matcher's own rules are unit-tested on the desktop side
// (`tests/notes/noteMentions.test.ts`) and are shared into this client by
// alias, so what is under test HERE is the half the phone owns: that a note
// name becomes a link with the app's mention testid, that anything the matcher
// refuses stays plain text, and that pressing one reports the note.
//
// The refusal cases are the ones worth asserting rather than assuming, because
// they are the reason the matcher is shared instead of retyped: a name one
// character short of a real title, and a title appearing inside a longer name,
// must NOT become a link. Both would otherwise open a note the model never
// named, which is worse than a mention that does nothing.

import { describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

import { MentionText } from "../../src/components/MentionText";
import { buildMentionTargets } from "@myne/note-mentions";

// The vault, as the resolver projects it: a path comes from title + folder.
const TARGETS = buildMentionTargets([
  { noteUuid: "n1", title: "Pixel 10 Graphene OS", folder: "Personal/Things I have/" },
  { noteUuid: "n2", title: "Notes", folder: null },
  { noteUuid: "n3", title: "Notes on Q3", folder: null },
]);

function renderText(text: string, onOpenNote = vi.fn()) {
  render(
    <MentionText text={text} targets={TARGETS} onOpenNote={onOpenNote} />,
  );
  return onOpenNote;
}

describe("a mention is the whole name and nothing less (myne-md/myne#867)", () => {
  it("opens the note that a whole path names", () => {
    const onOpen = renderText(
      "That one is under Personal/Things I have/Pixel 10 Graphene OS.",
    );
    const link = screen.getByTestId("ai.mention-link");
    expect(link.textContent).toBe("Personal/Things I have/Pixel 10 Graphene OS");
    fireEvent.click(link);
    expect(onOpen).toHaveBeenCalledWith("n1");
    cleanup();
  });

  it("opens the same note when the answer names only its title", () => {
    const onOpen = renderText("I wrote it into Pixel 10 Graphene OS for you.");
    const link = screen.getByTestId("ai.mention-link");
    expect(link.textContent).toBe("Pixel 10 Graphene OS");
    fireEvent.click(link);
    expect(onOpen).toHaveBeenCalledWith("n1");
    cleanup();
  });

  it("leaves a PREFIX of a real title as plain text", () => {
    // `Pixel 10` is not a note. Linking it would open `Pixel 10 Graphene OS`,
    // which is the exact failure the exact-match rule exists to prevent.
    renderText("I looked at Pixel 10 this morning.");
    expect(screen.queryByTestId("ai.mention-link")).toBeNull();
    cleanup();
  });

  it("does not let the shorter note claim the longer note's name", () => {
    // `Notes` must not match inside `Notes on Q3`, and longest-first is what
    // makes the longer name win at the same position.
    const onOpen = renderText("See Notes on Q3 for the rest.");
    const links = screen.getAllByTestId("ai.mention-link");
    expect(links).toHaveLength(1);
    expect(links[0]!.textContent).toBe("Notes on Q3");
    fireEvent.click(links[0]!);
    expect(onOpen).toHaveBeenCalledWith("n3");
    cleanup();
  });

  it("does not match against a name-continuing character", () => {
    // `Notes` followed by `Q3` is one longer token, so it is not a mention.
    renderText("The file is NotesQ3 in my head.");
    expect(screen.queryByTestId("ai.mention-link")).toBeNull();
    cleanup();
  });

  it("follows a mention from the keyboard, as this client's links do", () => {
    const onOpen = renderText("It is in Notes on Q3.");
    const link = screen.getByTestId("ai.mention-link");
    expect(link.getAttribute("role")).toBe("link");
    expect(link.getAttribute("tabindex")).toBe("0");
    fireEvent.keyDown(link, { key: "Enter" });
    fireEvent.keyDown(link, { key: " " });
    expect(onOpen).toHaveBeenCalledTimes(2);
    cleanup();
  });

  it("wraps nothing at all when the note list has not loaded", () => {
    render(<MentionText text="See Personal/Things I have/Notes." targets={undefined} onOpenNote={vi.fn()} />);
    expect(screen.queryByTestId("ai.mention-link")).toBeNull();
    expect(screen.getByText("See Personal/Things I have/Notes.")).toBeTruthy();
    cleanup();
  });
});
