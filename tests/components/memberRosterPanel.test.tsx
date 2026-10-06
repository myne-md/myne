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
import type { RosterMemberView } from "../../src/lib/invite";
import {
  resetPersonIdentityState,
  setPersonIdentityState,
} from "../../src/components/sync/personIdentityState";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

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
    // The identity section is the unlocked state; the Sync panel's Identity
    // block owns the unlock (myne-md/myne#831).
    setPersonIdentityState({ ready: true, ownerCode: "MYNE-PERSON-1:owner" });
    render(<MemberRosterPanel />);
    try {
      expect(screen.getByTestId("member-roster.identity-section")).toBeDefined();
      expect(screen.getByTestId("member-roster.members-section")).toBeDefined();
      expect(screen.getByTestId("member-roster.invitations-section")).toBeDefined();
    } finally {
      cleanup();
      resetPersonIdentityState();
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
