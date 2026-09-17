// @vitest-environment jsdom
//
// Component tests for `src/components/sync/MemberRosterPanel.tsx` (myne-md/myne#698).
// Covers the pr-review minor: the recovery-phrase input carries a programmatic
// label (`aria-label`), so a screen reader names the field instead of
// announcing an unlabeled password input.

import { describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

vi.mock("../../src/hooks/useRoster", () => ({
  useRoster: () => ({
    members: [],
    loading: false,
    error: null,
    reload: vi.fn(),
    unlockPerson: vi.fn(() => Promise.resolve()),
    lockPerson: vi.fn(() => Promise.resolve()),
    inviting: false,
    lastInvite: null,
    invite: vi.fn(() => Promise.resolve(null)),
    removing: false,
    remove: vi.fn(() => Promise.resolve()),
  }),
}));

vi.mock("../../src/hooks/usePrefs", () => ({
  usePrefs: () => ({ prefs: { label: "Test vault" } }),
}));

vi.mock("../../src/hooks/useFocusTrap", () => ({
  useFocusTrap: () => {},
}));

import { MemberRosterPanel } from "../../src/components/sync/MemberRosterPanel";

describe("MemberRosterPanel phrase input", () => {
  it("exposes the recovery-phrase field under a programmatic label", () => {
    render(<MemberRosterPanel />);
    try {
      const input = screen.getByTestId("member-roster.phrase-input");
      expect(input.getAttribute("aria-label")).toBe("sync.memberRoster.personHint");
      // The label query resolves to the same element: assistive tech names it.
      expect(screen.getByLabelText("sync.memberRoster.personHint")).toBe(input);
    } finally {
      cleanup();
    }
  });

  it("still accepts typing after the label is added", () => {
    render(<MemberRosterPanel />);
    try {
      const input = screen.getByTestId("member-roster.phrase-input") as HTMLInputElement;
      fireEvent.change(input, { target: { value: "word ".repeat(24).trim() } });
      expect(input.value.split(" ")).toHaveLength(24);
    } finally {
      cleanup();
    }
  });
});
