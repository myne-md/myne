// @vitest-environment jsdom
//
// Component tests for `src/components/sync/MemberRosterPanel.tsx` (myne-md/myne#698).
// Covers the pr-review minor: the recovery-phrase input carries a programmatic
// label (`aria-label`), so a screen reader names the field instead of
// announcing an unlabeled password input.
// Covers the parking gate: member removal is disabled until the roster wire
// ships, so no Remove button renders and the disabled notice does.

import { describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

// The roster rows per test. `members: []` renders the invite-only empty
// state; a non-empty list renders the rows plus the removal-disabled notice.
let mockMembers = [
  {
    fingerprint_hex: "ab".repeat(32),
    display_name: "Member One",
    version: 1,
    previous_fingerprint_hex: null,
    joined_at: 1_700_000_000,
    member_ed_pk_hex: "cd".repeat(32),
    member_kem_ek_hex: "ef".repeat(32),
    member_mldsa_vk_hex: "01".repeat(48),
  },
];

vi.mock("../../src/hooks/useRoster", () => ({
  useRoster: () => ({
    members: mockMembers,
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

describe("MemberRosterPanel removal parking", () => {
  it("renders no Remove button while members are listed", () => {
    render(<MemberRosterPanel />);
    try {
      expect(screen.getByTestId("member-roster.list")).toBeDefined();
      expect(screen.getAllByTestId("member-roster.row")).toHaveLength(1);
      expect(screen.queryByTestId("member-roster.remove-button")).toBeNull();
      expect(screen.queryByTestId("member-roster.remove-confirm")).toBeNull();
    } finally {
      cleanup();
    }
  });

  it("states the disabled state instead of promising a removal flow", () => {
    render(<MemberRosterPanel />);
    try {
      const notice = screen.getByTestId("member-roster.remove-disabled");
      expect(notice.textContent).toBe("sync.memberRoster.removeConfirm");
    } finally {
      cleanup();
    }
  });
});
