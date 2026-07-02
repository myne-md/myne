// @vitest-environment jsdom
//
// Component tests for `src/notes/components/TagSuggestionChips.tsx`
// (auto-tag-link MYND-411 task 4). Renders ranked suggestions as chips and
// asserts the existing-vs-new distinction, click-to-insert dispatch, and
// accepted-state reflection.

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

import { TagSuggestionChips } from "../../src/notes/components/TagSuggestionChips";
import type { TagSuggestion } from "../../src/notes/ai/tagRanker";

afterEach(() => cleanup());

const SUGGESTIONS: TagSuggestion[] = [
  { tag: "work", isNew: false },
  { tag: "rust", isNew: true },
];

describe("TagSuggestionChips", () => {
  it("renders a chip per suggestion", () => {
    render(<TagSuggestionChips suggestions={SUGGESTIONS} onAccept={vi.fn()} />);
    expect(screen.getAllByTestId("ai.tag-chip")).toHaveLength(2);
  });

  it("renders nothing for an empty suggestion list", () => {
    render(<TagSuggestionChips suggestions={[]} onAccept={vi.fn()} />);
    expect(screen.queryByTestId("ai.tag-chips")).toBeNull();
  });

  it("distinguishes new-flagged chips from existing-vocabulary chips", () => {
    render(<TagSuggestionChips suggestions={SUGGESTIONS} onAccept={vi.fn()} />);
    const chips = screen.getAllByTestId("ai.tag-chip");
    // input order: work (existing), rust (new)
    expect(chips[0].getAttribute("data-is-new")).toBe("false");
    expect(chips[1].getAttribute("data-is-new")).toBe("true");
    expect(chips[1].textContent).toContain("rust");
  });

  it("fires onAccept with the clicked suggestion (click-to-insert)", () => {
    const onAccept = vi.fn();
    render(<TagSuggestionChips suggestions={SUGGESTIONS} onAccept={onAccept} />);
    fireEvent.click(screen.getAllByTestId("ai.tag-chip")[1]);
    expect(onAccept).toHaveBeenCalledTimes(1);
    expect(onAccept).toHaveBeenCalledWith({ tag: "rust", isNew: true });
  });

  it("marks an already-accepted tag (folded) and does not fire onAccept for it", () => {
    const onAccept = vi.fn();
    render(
      <TagSuggestionChips
        suggestions={SUGGESTIONS}
        onAccept={onAccept}
        acceptedTags={["Work"]}
      />,
    );
    const chips = screen.getAllByTestId("ai.tag-chip");
    // "work" folds onto accepted "Work" → accepted + disabled.
    expect(chips[0].getAttribute("data-accepted")).toBe("true");
    fireEvent.click(chips[0]);
    expect(onAccept).not.toHaveBeenCalled();
    // the new "rust" chip is still interactive
    fireEvent.click(chips[1]);
    expect(onAccept).toHaveBeenCalledTimes(1);
  });
});
