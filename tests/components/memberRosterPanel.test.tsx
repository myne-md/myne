// @vitest-environment jsdom
//
// Component tests for `src/components/sync/MemberRosterPanel.tsx` (myne-md/myne#698).
// Covers the pr-review minor: the recovery-phrase input carries a programmatic
// label (`aria-label`), so a screen reader names the field instead of
// announcing an unlabeled password input.
// Covers the parking gate: member removal is disabled until the roster wire
// ships, so no Remove button renders and the disabled notice does.

import { describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { RosterMemberView } from "../../src/lib/invite";
import {
  resetPersonIdentityState,
  setPersonIdentityState,
} from "../../src/components/sync/personIdentityState";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

// The person unlock result per test.
type MockUnlockView = {
  fingerprint_hex: string;
  person_id_hex: string;
  identity_code: string;
};
let mockUnlockPerson = (): Promise<MockUnlockView> =>
  Promise.resolve({
    fingerprint_hex: "00".repeat(32),
    person_id_hex: "11".repeat(16),
    identity_code: "MYNE-PERSON-1:x",
  });

// The roster rows per test. `members: []` renders the invite-only empty
// state; a non-empty list renders the rows plus the removal-disabled notice.
let mockMembers: RosterMemberView[] = [
  {
    fingerprint_hex: "ab".repeat(32),
    display_name: "Member One",
    role: "member",
    version: 1,
    previous_fingerprint_hex: null,
    joined_at: 1_700_000_000,
    member_ed_pk_hex: "cd".repeat(32),
    member_kem_ek_hex: "ef".repeat(32),
    member_mldsa_vk_hex: "01".repeat(48),
    continuity: null,
  },
];

// The caller's vault authority per test. `owner` renders the invite control;
// `member` must hide it.
let mockAuthority: "owner" | "member" = "owner";
// The group-key epoch per test (`null` = legacy roster, no epoch line).
let mockGroupKeyEpoch: number | null = null;

vi.mock("../../src/hooks/useRoster", () => ({
  useRoster: () => ({
    members: mockMembers,
    authority: mockAuthority,
    groupKeyEpoch: mockGroupKeyEpoch,
    loading: false,
    error: null,
    reload: vi.fn(),
    unlockPerson: vi.fn(() => mockUnlockPerson()),
    lockPerson: vi.fn(() => Promise.resolve()),
    inviting: false,
    lastInvite: null,
    invite: vi.fn(() => Promise.resolve(null)),
    vaultInvites: [],
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

/** The 24-word grid sits behind the card's Unlock button, closed by default so
 *  the panel does not open on twenty-four empty fields. */
function openUnlock(): void {
  const open = screen.queryByTestId("member-roster.person-unlock-open");
  if (open) fireEvent.click(open);
}

describe("MemberRosterPanel phrase input", () => {
  it("exposes the recovery-phrase field under a programmatic label", () => {
    render(<MemberRosterPanel />);
    openUnlock();
     try {
       const input = screen.getByTestId("member-roster.phrase-input") as HTMLInputElement;
       expect(input.type).toBe("text");
       expect(input.style.padding).toBe("var(--space-1) var(--space-2)");
       expect(input.style.borderRadius).toBe("var(--radius-1)");
       expect(input.getAttribute("aria-label")).toBe("sync.enroll.wordAria");

       // The label query resolves to the same element: assistive tech names it.
       expect(screen.getAllByLabelText("sync.enroll.wordAria")[0]).toBe(input);

    } finally {
      cleanup();
    }
  });

  // #764: the panel's own `personHint` sentence AND the grid's field label were
  // the same i18n key, so the user read it twice. Asserted on the rendered
  // count, not on the absence of the `label` prop, because the prop is one of
  // several ways to produce the duplicate.
  it("states the unlock instruction once, not once per text slot", () => {
    render(<MemberRosterPanel />);
    openUnlock();
    try {
      const panel = screen.getByTestId("member-roster");
      const statements = Array.from(panel.querySelectorAll("p, span")).filter(
        (node) => node.textContent === "sync.memberRoster.personHint",
      );
      expect(statements).toHaveLength(1);
    } finally {
      cleanup();
    }
  });

  // #764: a `1fr` track is `minmax(auto, 1fr)`, and the `auto` floor is each
  // cell's min-content width — a text input's intrinsic `size` width, which
  // `min-width: 0` on the input alone does not reduce. Four of those overflowed
  // the panel and pushed words 4/8/12/16/20/24 off the right edge. Both halves
  // are asserted because either one alone still overflows.
  it("keeps the phrase grid inside its container at any panel width", () => {
    render(<MemberRosterPanel />);
    openUnlock();
    try {
      const grid = screen.getByTestId("member-roster.phrase-grid") as HTMLElement;
      expect(grid.style.gridTemplateColumns).toBe("repeat(4, minmax(0, 1fr))");
      const wraps = Array.from(grid.children) as HTMLElement[];
      expect(wraps).toHaveLength(24);
      for (const wrap of wraps) {
        expect(wrap.style.minWidth).toBe("0px");
      }
    } finally {
      cleanup();
    }
  });

  it("still accepts typing after the label is added", () => {

    render(<MemberRosterPanel />);
    openUnlock();
    try {
      const input = screen.getByTestId("member-roster.phrase-input") as HTMLInputElement;
      fireEvent.change(input, { target: { value: "abandon" } });
      expect(input.value).toBe("abandon");
    } finally {
      cleanup();
    }
  });

  it("keeps the recovery-phrase grid collapsed until the user asks for it", () => {
    render(<MemberRosterPanel />);
    try {
      // myne#796 follow-up: the panel must not sit with an always-open phrase
      // field; the grid appears only after the user chooses to enter it.
      expect(screen.queryByTestId("member-roster.phrase-grid")).toBeNull();
      fireEvent.click(screen.getByTestId("member-roster.person-unlock-open"));
      expect(screen.getByTestId("member-roster.phrase-grid")).toBeTruthy();
      fireEvent.click(screen.getByTestId("member-roster.person-unlock-cancel"));
      expect(screen.queryByTestId("member-roster.phrase-grid")).toBeNull();
    } finally {
      cleanup();
    }
  });

  it("does not publish an unlock that resolves after a session reset", async () => {
    let resolveUnlock!: (view: MockUnlockView) => void;
    mockUnlockPerson = () =>
      new Promise<MockUnlockView>((resolve) => {
        resolveUnlock = resolve;
      });
    render(<MemberRosterPanel />);
    openUnlock();
    try {
      for (let index = 0; index < 24; index += 1) {
        const testId = index === 0 ? "member-roster.phrase-input" : `member-roster.phrase-cell-${index + 1}`;
        fireEvent.change(screen.getByTestId(testId), { target: { value: "abandon" } });
      }
      fireEvent.click(screen.getByTestId("member-roster.person-unlock-button"));
      resetPersonIdentityState();
      resolveUnlock({
        fingerprint_hex: "00".repeat(32),
        person_id_hex: "11".repeat(16),
        identity_code: "MYNE-PERSON-1:stale",
      });
      await waitFor(() => {
        expect(screen.queryByTestId("member-roster.person-ready")).toBeNull();
      });
    } finally {
      cleanup();
      mockUnlockPerson = () =>
        Promise.resolve({
          fingerprint_hex: "00".repeat(32),
          person_id_hex: "11".repeat(16),
          identity_code: "MYNE-PERSON-1:x",
        });
    }
  });

});

describe("MemberRosterPanel removal", () => {
  it("offers the owner a Remove button that opens a confirm stating the limits", () => {
    mockAuthority = "owner";
    render(<MemberRosterPanel />);
    try {
      fireEvent.click(screen.getByTestId("member-roster.remove-button"));
      const dialog = screen.getByTestId("member-roster.remove-confirm");
      // The copy states future-access revocation and non-recall.
      expect(dialog.textContent).toContain("sync.memberRoster.removeConfirm");
    } finally {
      cleanup();
    }
  });

  it("states the removal limits honestly and promises no recall", () => {
    render(<MemberRosterPanel />);
    try {
      const notice = screen.getByTestId("member-roster.removal-limits");
      expect(notice.textContent).toBe("sync.memberRoster.removalLimits");
    } finally {
      cleanup();
    }
  });

  it("renders no owner-only invite control for a member", () => {
    mockAuthority = "member";
    render(<MemberRosterPanel />);
    try {
      // A member session must not be shown an admin control the backend refuses
      // with `NotOwner`.
      expect(screen.queryByTestId("member-roster.invite-button")).toBeNull();
    } finally {
      cleanup();
      mockAuthority = "owner";
    }
  });
});

describe("MemberRosterPanel key-generation state", () => {
  it("distinguishes a key change from an owner-confirmed relink", () => {
    mockAuthority = "owner";
    mockGroupKeyEpoch = 3;
    mockMembers = [
      {
        ...mockMembers[0],
        fingerprint_hex: "11".repeat(32),
        display_name: "Changed",
        continuity: "changed",
      },
      {
        ...mockMembers[0],
        fingerprint_hex: "22".repeat(32),
        display_name: "Relinked",
        continuity: "owner-confirmed",
      },
    ];
    render(<MemberRosterPanel />);
    try {
      // The internal group-key epoch is no longer surfaced (myne#795 UI pass).
      expect(screen.queryByTestId("member-roster.epoch")).toBeNull();
      // The two continuity states render as DIFFERENT elements: a key change is
      // the danger-toned verify prompt, an owner-confirmed relink is neutral.
      expect(screen.getByTestId("member-roster.key-changed")).toBeDefined();
      expect(screen.getByTestId("member-roster.relink-confirmed")).toBeDefined();
    } finally {
      cleanup();
      mockGroupKeyEpoch = null;
      mockMembers = [
        {
          fingerprint_hex: "ab".repeat(32),
          display_name: "Member One",
          role: "member",
          version: 1,
          previous_fingerprint_hex: null,
          joined_at: 1_700_000_000,
          member_ed_pk_hex: "cd".repeat(32),
          member_kem_ek_hex: "ef".repeat(32),
          member_mldsa_vk_hex: "01".repeat(48),
          continuity: null,
        },
      ];
      mockAuthority = "owner";
    }
  });
});

describe("MemberRosterPanel roles", () => {
  it("renders a role badge on each row", () => {
    render(<MemberRosterPanel />);
    try {
      const badges = screen.getAllByTestId("member-roster.role");
      expect(badges).toHaveLength(1);
      expect(badges[0].textContent).toBe("sync.memberRoster.memberBadge");
    } finally {
      cleanup();
    }
  });

  it("hides the owner identity code from a member", () => {
    mockAuthority = "member";
    setPersonIdentityState({ ready: true, ownerCode: "MYNE-PERSON-1:owner" });
    render(<MemberRosterPanel />);
    try {
      expect(screen.queryByTestId("member-roster.owner-code")).toBeNull();
      expect(screen.queryByTestId("member-roster.copy-owner-code")).toBeNull();
    } finally {
      cleanup();
      resetPersonIdentityState();
      mockAuthority = "owner";
    }
  });

  it("shows the invite control to the owner", () => {
    render(<MemberRosterPanel />);
    try {
      expect(screen.getByTestId("member-roster.invite-button")).toBeDefined();
    } finally {
      cleanup();
    }
  });

  it("hides the invite control from a member", () => {
    mockAuthority = "member";
    render(<MemberRosterPanel />);
    try {
      expect(screen.queryByTestId("member-roster.invite-button")).toBeNull();
    } finally {
      mockAuthority = "owner";
      cleanup();
    }
  });
});

// myne#795 UI pass: the panel is grouped into titled sections and the owner row
// no longer renders the vault label (which read as "Untitled vault").
describe("MemberRosterPanel layout", () => {
  it("groups the roster into identity, members and invitations sections", () => {
    mockAuthority = "owner";
    render(<MemberRosterPanel />);
    try {
      expect(screen.getByTestId("member-roster.identity-section")).toBeDefined();
      expect(screen.getByTestId("member-roster.members-section")).toBeDefined();
      expect(screen.getByTestId("member-roster.invitations-section")).toBeDefined();
    } finally {
      cleanup();
    }
  });

  it("labels the owner row You instead of the stored vault name", () => {
    mockAuthority = "owner";
    const previous = mockMembers;
    mockMembers = [
      { ...previous[0], fingerprint_hex: "ff".repeat(32), display_name: "Untitled vault", role: "owner" },
    ];
    render(<MemberRosterPanel />);
    try {
      expect(screen.getByTestId("member-roster.name").textContent).toBe(
        "sync.memberRoster.youBadge",
      );
    } finally {
      cleanup();
      mockMembers = previous;
      mockAuthority = "owner";
    }
  });
});
