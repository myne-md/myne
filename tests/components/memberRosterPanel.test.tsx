// @vitest-environment jsdom
//
// Component tests for `src/components/sync/MemberRosterPanel.tsx` (myne-md/myne#698).
// Covers the pr-review minor: the recovery-phrase input carries a programmatic
// label (`aria-label`), so a screen reader names the field instead of
// announcing an unlabeled password input.
// Covers the parking gate: member removal is disabled until the roster wire
// ships, so no Remove button renders and the disabled notice does.

import { afterEach, describe, expect, it, vi } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import type { RosterMemberView } from "../../src/lib/invite";
import type { DeviceAttributionView } from "../../src/lib/deviceBindings";
import {
  resetPersonIdentityState,
  setPersonIdentityState,
} from "../../src/components/sync/personIdentityState";

vi.mock("react-i18next", () => ({
  // `count` is interpolated because the roster's device lines are pluralised
  // (`_one` / `_other` in the catalog), and a mock that always answered the bare
  // key could not tell "1 device claim" from "3 device claims".
  useTranslation: () => ({
    t: (key: string, opts?: Record<string, unknown>) =>
      opts && "count" in opts ? `${key}:${String(opts.count)}` : key,
  }),
}));

// The member display-name writers (myne-md/myne#851 task 6). Mocked so the row
// editor's calls, its busy state and its inline refusals are all observable
// without a backend.
const namesMocks = vi.hoisted(() => ({
  setMyMemberName: vi.fn<(name: string) => Promise<unknown>>(() => Promise.resolve({})),
  clearMyMemberName: vi.fn<() => Promise<unknown>>(() => Promise.resolve({})),
}));
// The roster hook's retry. Hoisted for the same reason: the `vi.mock` factory
// runs during the import phase, before any top-level `const` below it exists.
const rosterMocks = vi.hoisted(() => ({ reload: vi.fn() }));
// The REAL module is spread so `memberNameErrorKey` (its pure mapper) stays
// available: the panel resolves the refusal copy through it, and a wholesale
// replacement would leave the mapper undefined and the catch block throwing.
vi.mock("../../src/lib/memberNames", async (importOriginal) => {
  const real = await importOriginal<typeof import("../../src/lib/memberNames")>();
  return {
    ...real,
    setMyMemberName: namesMocks.setMyMemberName,
    clearMyMemberName: namesMocks.clearMyMemberName,
  };
});

// The roster rows per test. `members: []` renders the invite-only empty
// state; a non-empty list renders the rows plus the removal-disabled notice.
// The row carries a signed name (`name_state: "verified"`), which is the only
// state the member list is allowed to render a name from.
let mockMembers: RosterMemberView[] = [
  {
    fingerprint_hex: "ab".repeat(32),
    is_self: false,
    display_name: "Member One",
    name_state: "verified",
    role: "member",
    version: 1,
    previous_fingerprint_hex: null,
    joined_at: 1_700_000_000,
    member_ed_pk_hex: "cd".repeat(32),
    member_kem_ek_hex: "ef".repeat(32),
    member_mldsa_vk_hex: "01".repeat(48),
    continuity: "current",
  },
];

// The caller's vault authority per test. `owner` renders the invite control;
// `member` must hide it.
let mockAuthority: "owner" | "member" = "owner";
// The group-key epoch per test (`null` = legacy roster, no epoch line).
let mockGroupKeyEpoch: number | null = null;
// The owner's sent-invitation rows per test. Empty by default: most cases are
// about the member list, not the invitations section.
let mockVaultInvites: Array<{
  invite_id_hex: string;
  recipient_person_id_hex: string;
  claimed: boolean;
  declined: boolean;
}> = [];

// The roster read's rejection per test (myne-md/myne#932). `kind` is what the
// panel branches on: `NotOwner` beside a locked identity is the STATE, and
// everything else is a failure.
let mockError: string | null = null;
let mockErrorKind: string | null = null;

// The signature-verified binding view per test (myne-md/myne#976). The roster is
// the only surface that renders it now: the `MEMBER DEVICES` panel it used to
// live on is gone. `null` is the absent/unshared state, which draws nothing.
let mockBindingsView: DeviceAttributionView | null = null;
let mockBindingsError: string | null = null;

/** One row over the base fixture, so a test states only what it is about. */
const rowView = (over: Partial<RosterMemberView>): RosterMemberView => ({
  ...mockMembers[0],
  ...over,
});

vi.mock("../../src/hooks/useRoster", () => ({
  useRoster: () => ({
    members: mockMembers,
    authority: mockAuthority,
    groupKeyEpoch: mockGroupKeyEpoch,
    // The real hook derives this from the roster view's `group_key_epoch`, so
    // the mock must too: the rename affordance is gated on the vault being
    // shared, and a mock that always says "not shared" would hide it.
    shared: mockGroupKeyEpoch !== null,
    loading: false,
    error: mockError,
    errorKind: mockErrorKind,
    reload: rosterMocks.reload,
    lockPerson: vi.fn(() => Promise.resolve()),
    inviting: false,
    lastInvite: null,
    invite: vi.fn(() => Promise.resolve(null)),
    vaultInvites: mockVaultInvites,
    removing: false,
    remove: vi.fn(() => Promise.resolve()),
  }),
}));

vi.mock("../../src/hooks/usePrefs", () => ({
  usePrefs: () => ({ prefs: { label: "Test vault" } }),
}));

vi.mock("../../src/hooks/useDeviceBindings", () => ({
  useDeviceBindings: () => ({
    view: mockBindingsView,
    loading: false,
    error: mockBindingsError,
    shared: mockBindingsView !== null,
    refresh: vi.fn(),
  }),
}));

vi.mock("../../src/hooks/useFocusTrap", () => ({
  useFocusTrap: () => {},
}));

import { MemberRosterPanel } from "../../src/components/sync/MemberRosterPanel";

describe("MemberRosterPanel roster failure", () => {
  it("reads a locked identity's NotOwner as the state it is, not as an error", () => {
    // A person-born vault with a locked identity has no owner public half to
    // verify its own signed roster with, so `sync_list_roster` answers
    // `NotOwner`. Reporting that as a failure told the user their vault was
    // broken when the only thing missing was the phrase for this session.
    mockError = "NotOwner not from the panel's own vocabulary";
    mockErrorKind = "NotOwner";
    resetPersonIdentityState();
    render(<MemberRosterPanel />);
    try {
      expect(screen.queryByTestId("member-roster.error")).toBeNull();
      // The door that fixes the state is on screen instead.
      expect(screen.getByTestId("member-roster.identity-locked")).toBeDefined();
    } finally {
      cleanup();
      mockError = null;
      mockErrorKind = null;
    }
  });

  it("keeps the panel and puts a genuine failure under the section that owns it", () => {
    mockError = "Transport";
    mockErrorKind = "Transport";
    setPersonIdentityState({ ready: true, ownerCode: null });
    rosterMocks.reload.mockClear();
    render(<MemberRosterPanel />);
    try {
      // The failure used to replace the whole panel, which deleted the heading
      // that says which block failed (myne-md/myne#932).
      expect(screen.getByTestId("member-roster.identity-section")).toBeDefined();
      const failure = screen.getByTestId("member-roster.error");
      expect(failure.textContent).toContain("sync.memberRoster.error");
      fireEvent.click(screen.getByTestId("member-roster.retry"));
      expect(rosterMocks.reload).toHaveBeenCalledTimes(1);
    } finally {
      cleanup();
      mockError = null;
      mockErrorKind = null;
      resetPersonIdentityState();
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
          is_self: false,
          display_name: "Member One",
          name_state: "verified",
          role: "member",
          version: 1,
          previous_fingerprint_hex: null,
          joined_at: 1_700_000_000,
          member_ed_pk_hex: "cd".repeat(32),
          member_kem_ek_hex: "ef".repeat(32),
          member_mldsa_vk_hex: "01".repeat(48),
          continuity: "current",
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

  it("puts the invite control inside the empty members state, not under it", () => {
    // myne-md/myne#867: with no members the zero state says "invite someone",
    // so the button sits under that sentence, centred, and nowhere else.
    const saved = mockMembers;
    mockMembers = [];
    render(<MemberRosterPanel />);
    try {
      const empty = screen.getByTestId("member-roster.empty");
      const buttons = screen.getAllByTestId("member-roster.invite-button");
      expect(buttons).toHaveLength(1);
      expect(empty.contains(buttons[0])).toBe(true);
    } finally {
      mockMembers = saved;
      cleanup();
    }
  });
});

// The owner's view of the invitations it sent (myne-md/myne#911 follow-up). It
// used to carry two states; the recipient's refusal is a third, and it is the only
// one that says "they said no" rather than "not yet", which is what decides whether
// the owner waits or invites somebody else.
describe("MemberRosterPanel invitation rows", () => {
  it("tells a declined invitation apart from one nobody has opened yet", () => {
    mockAuthority = "owner";
    mockVaultInvites = [
      { invite_id_hex: "aa", recipient_person_id_hex: "11".repeat(16), claimed: false, declined: false },
      { invite_id_hex: "bb", recipient_person_id_hex: "22".repeat(16), claimed: true, declined: false },
      { invite_id_hex: "cc", recipient_person_id_hex: "33".repeat(16), claimed: false, declined: true },
    ];
    render(<MemberRosterPanel />);
    try {
      const states = screen
        .getAllByTestId("member-roster.invitation-status")
        .map((el) => el.getAttribute("data-declined") + ":" + el.textContent);
      expect(states).toEqual([
        "false:sync.memberRoster.invitationPending",
        "false:sync.memberRoster.invitationClaimed",
        "true:sync.memberRoster.invitationDeclined",
      ]);
    } finally {
      mockVaultInvites = [];
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

  it("marks the caller's own row You by identity, not by the owner role", () => {
    mockAuthority = "owner";
    const previous = mockMembers;
    mockMembers = [
      {
        ...previous[0],
        fingerprint_hex: "ff".repeat(32),
        display_name: "Untitled vault",
        role: "owner",
        is_self: true,
      },
    ];
    render(<MemberRosterPanel />);
    try {
      // The row renders its own VERIFIED name like any other, and the identity
      // marker beside it is what says which row is the caller's.
      expect(screen.getByTestId("member-roster.name").textContent).toBe("Untitled vault");
      expect(screen.getByTestId("member-roster.you").textContent).toBe(
        "sync.memberRoster.youBadge",
      );
    } finally {
      cleanup();
      mockMembers = previous;
      mockAuthority = "owner";
    }
  });

  // The unnamed half of the same rule: with no name to show, the badge itself is
  // the name slot, and there is no second marker.
  it("shows the you-badge in the name slot of an unnamed self row", () => {
    const previous = mockMembers;
    mockMembers = [
      rowView({ fingerprint_hex: "aa".repeat(32), is_self: true, display_name: "", name_state: "absent" }),
    ];
    render(<MemberRosterPanel />);
    try {
      expect(screen.getByTestId("member-roster.name").textContent).toBe(
        "sync.memberRoster.youBadge",
      );
      expect(screen.queryByTestId("member-roster.you")).toBeNull();
    } finally {
      cleanup();
      mockMembers = previous;
    }
  });

  // The bug this guards (myne-md/myne#859): keying "You" on
  // `role === "owner"` made an invited member read the OWNER's row as
  // themselves, on the member's own device.
  it("does not mark another person's owner row You", () => {
    mockAuthority = "member";
    const previous = mockMembers;
    mockMembers = [
      {
        ...previous[0],
        fingerprint_hex: "ff".repeat(32),
        // A row migrated from a pre-B2B roster has no signed name, so the owner
        // row reports none and falls back to the fingerprint (myne#851 task 4).
        display_name: "",
        name_state: "absent",
        role: "owner",
        is_self: false,
      },
      { ...previous[0], fingerprint_hex: "aa".repeat(32), is_self: true },
    ];
    render(<MemberRosterPanel />);
    try {
      // Exactly one "You" marker: the member's own row. The owner row is not the
      // caller, so it carries none.
      const youMarkers = screen.getAllByTestId("member-roster.you");
      expect(youMarkers).toHaveLength(1);
      expect(youMarkers[0].textContent).toBe("sync.memberRoster.youBadge");
      // The caller's own row renders its verified name; the owner row shows no
      // name at all (an absent record falls back to the fingerprint).
      expect(screen.getByTestId("member-roster.you").closest("li")?.getAttribute("data-fingerprint")).toBe(
        "aa".repeat(32).slice(0, 16),
      );
      // The owner row still reads as the owner (role badge) and shows no name.
      const roles = screen.getAllByTestId("member-roster.role");
      expect(roles[0].textContent).toBe("sync.memberRoster.ownerBadge");
      expect(roles[1].textContent).toBe("sync.memberRoster.memberBadge");
    } finally {
      cleanup();
      mockMembers = previous;
      mockAuthority = "owner";
    }
  });
});

// The row identity rule (myne-md/myne#851 task 5): the VERIFIED name where there
// is one, the short fingerprint where there is not, and a marker when a record
// exists that nobody's signature backs. The rule keys on `name_state`, never on
// `role`, which is what the owner-row test below pins.
describe("MemberRosterPanel row identity rule", () => {
  it("renders the verified name where there is one and the fingerprint where there is not", () => {
    const previous = mockMembers;
    const bare = "22".repeat(32);
    mockMembers = [
      rowView({ fingerprint_hex: "11".repeat(32), display_name: "Ada", name_state: "verified" }),
      rowView({ fingerprint_hex: bare, display_name: "", name_state: "absent" }),
    ];
    render(<MemberRosterPanel />);
    try {
      const names = screen.getAllByTestId("member-roster.name");
      expect(names).toHaveLength(1);
      expect(names[0].textContent).toBe("Ada");
      // Only the nameless row carries a fingerprint: the name IS the identifier
      // where there is one.
      const fingerprints = screen.getAllByTestId("member-roster.fingerprint");
      expect(fingerprints).toHaveLength(1);
      expect(fingerprints[0].textContent).toBe(bare.slice(0, 16));
      // An absent record is not a failure, so nothing marks it.
      expect(screen.queryByTestId("member-roster.name-unverified")).toBeNull();
    } finally {
      cleanup();
      mockMembers = previous;
    }
  });

  it("renders the unverified marker instead of a name nobody signed", () => {
    const previous = mockMembers;
    mockMembers = [
      rowView({ fingerprint_hex: "33".repeat(32), display_name: "", name_state: "unverified" }),
    ];
    render(<MemberRosterPanel />);
    try {
      expect(screen.queryByTestId("member-roster.name")).toBeNull();
      expect(screen.getByTestId("member-roster.name-unverified").textContent).toBe(
        "sync.memberRoster.nameUnverified",
      );
      // The row still carries the identifier that IS trustworthy.
      expect(screen.getByTestId("member-roster.fingerprint")).toBeDefined();
    } finally {
      cleanup();
      mockMembers = previous;
    }
  });

  // The assertion that fails if the name rule is replaced by the role. The row
  // before task 5 guarded the owner's name with `m.role !== "owner"` by hand
  // (myne#795 UI pass), so an owner row carrying a verified name rendered
  // nothing; under the one rule it renders the name like any other row.
  it("renders the owner's verified name on the owner's row", () => {
    const previous = mockMembers;
    mockMembers = [
      rowView({
        fingerprint_hex: "44".repeat(32),
        display_name: "Omer",
        name_state: "verified",
        role: "owner",
      }),
    ];
    render(<MemberRosterPanel />);
    try {
      expect(screen.getByTestId("member-roster.name").textContent).toBe("Omer");
      expect(screen.getByTestId("member-roster.role").textContent).toBe(
        "sync.memberRoster.ownerBadge",
      );
    } finally {
      cleanup();
      mockMembers = previous;
    }
  });

  it("never puts a full fingerprint in the DOM", () => {
    const previous = mockMembers;
    const raw = "77".repeat(32);
    mockMembers = [rowView({ fingerprint_hex: raw, display_name: "", name_state: "absent" })];
    render(<MemberRosterPanel />);
    try {
      expect(document.body.innerHTML).not.toContain(raw);
      expect(screen.getByTestId("member-roster.fingerprint").textContent).toBe(
        raw.slice(0, 16),
      );
      // The repeated-row discriminator carries the same prefix the row shows,
      // not the raw value (myne#851 task 5).
      expect(screen.getByTestId("member-roster.row").getAttribute("data-fingerprint")).toBe(
        raw.slice(0, 16),
      );
    } finally {
      cleanup();
      mockMembers = previous;
    }
  });
});

// The inline rename (myne-md/myne#851 task 6). The backend can only ever write
// the CALLER'S OWN row, so the affordance is gated on identity (`is_self`) and on
// the vault being shared (the store is `NTV6`-only), and the writer's refusals
// render inline with their own copy rather than being swallowed.
describe("MemberRosterPanel rename", () => {
  const setup = () => {
    mockGroupKeyEpoch = 3; // a shared (NTV6) vault: the name store exists here
    mockAuthority = "owner";
    namesMocks.setMyMemberName.mockClear();
    namesMocks.clearMyMemberName.mockClear();
  };

  it("offers rename on the caller's own row and nowhere else", () => {
    const previous = mockMembers;
    setup();
    mockMembers = [
      rowView({
        fingerprint_hex: "aa".repeat(32),
        is_self: true,
        role: "owner",
        display_name: "Omer",
        name_state: "verified",
      }),
      rowView({ fingerprint_hex: "bb".repeat(32), is_self: false, role: "member" }),
    ];
    render(<MemberRosterPanel />);
    try {
      const affordances = screen.getAllByTestId("member-roster.name-edit");
      expect(affordances).toHaveLength(1);
      // ...and it is the own row's, not simply the first one rendered.
      const ownRow = screen
        .getAllByTestId("member-roster.row")
        .find((li) => li.getAttribute("data-fingerprint") === "aa".repeat(32).slice(0, 16));
      expect(ownRow).toBeDefined();
      expect(within(ownRow!).getByTestId("member-roster.name-edit")).toBeDefined();
    } finally {
      cleanup();
      mockMembers = previous;
      mockGroupKeyEpoch = null;
    }
  });

  it("saves the trimmed name through the writer", async () => {
    const previous = mockMembers;
    setup();
    mockMembers = [
      rowView({ is_self: true, display_name: "", name_state: "absent" }),
    ];
    render(<MemberRosterPanel />);
    try {
      fireEvent.click(screen.getByTestId("member-roster.name-edit"));
      // 2026-10-25: the editor is a DIALOG, not an inline field that reflows the
      // row. Asserted rather than implied, because the testids are the same either
      // way and a regression to the row shape would keep every other case green.
      const dialog = screen.getByTestId("member-roster.name-dialog");
      expect(dialog.getAttribute("role")).toBe("dialog");
      expect(dialog.getAttribute("aria-modal")).toBe("true");
      // P4 (2026-10-25): the dialog runs on the shared `ModalShell`, so it has a
      // backdrop, a card and a centred position. Asserted because the testids and
      // the copy are identical on the hand-rolled `role="dialog"` div this
      // replaced, so a regression to that shape would keep every other case green.
      expect(dialog.className).toContain("myne-modal-backdrop");
      fireEvent.change(screen.getByTestId("member-roster.name-input"), {
        target: { value: "  Ada  " },
      });
      fireEvent.submit(screen.getByTestId("member-roster.name-save").closest("form")!);
      await waitFor(() =>
        expect(namesMocks.setMyMemberName).toHaveBeenCalledWith("Ada"),
      );
      // The editor closes on success, so the row goes back to its own rule.
      await waitFor(() => expect(screen.queryByTestId("member-roster.name-input")).toBeNull());
    } finally {
      cleanup();
      mockMembers = previous;
      mockGroupKeyEpoch = null;
    }
  });

  it("renders a writer refusal inline, with its own copy", async () => {
    const previous = mockMembers;
    setup();
    namesMocks.setMyMemberName.mockRejectedValueOnce({
      kind: "NameTooLong",
      detail: { max: 64 },
    });
    mockMembers = [rowView({ is_self: true, display_name: "Ada", name_state: "verified" })];
    render(<MemberRosterPanel />);
    try {
      fireEvent.click(screen.getByTestId("member-roster.name-edit"));
      fireEvent.submit(screen.getByTestId("member-roster.name-save").closest("form")!);
      expect((await screen.findByTestId("member-roster.name-error")).textContent).toBe(
        "sync.memberRoster.nameErrorTooLong",
      );
      // The editor stays open with the draft intact, so the refusal is fixable
      // rather than a silent no-op.
      expect(screen.getByTestId("member-roster.name-input")).toBeDefined();
    } finally {
      cleanup();
      mockMembers = previous;
      mockGroupKeyEpoch = null;
    }
  });

  it("clears the caller's name, which returns the row to the fingerprint", async () => {
    const previous = mockMembers;
    setup();
    mockMembers = [rowView({ is_self: true, display_name: "Ada", name_state: "verified" })];
    render(<MemberRosterPanel />);
    try {
      fireEvent.click(screen.getByTestId("member-roster.name-edit"));
      fireEvent.click(screen.getByTestId("member-roster.name-clear"));
      await waitFor(() => expect(namesMocks.clearMyMemberName).toHaveBeenCalled());
    } finally {
      cleanup();
      mockMembers = previous;
      mockGroupKeyEpoch = null;
    }
    // The tombstone reads as `absent` in the roster view (task 4), and an absent
    // record renders the fingerprint (task 5): the two together are the rule.
    mockMembers = [rowView({ is_self: false, display_name: "", name_state: "absent" })];
    render(<MemberRosterPanel />);
    try {
      expect(screen.getByTestId("member-roster.fingerprint")).toBeDefined();
      expect(screen.queryByTestId("member-roster.name")).toBeNull();
    } finally {
      cleanup();
      mockMembers = previous;
    }
  });
});

// myne-md/myne#851 task 9 (story 22): a member who accepted before the name step
// shipped still needs a way to set one. It is the `Set a name` button on their
// OWN unverified row and nothing else (2026-10-23: the sentence beside it and its
// session-scoped `Not now` were removed, see the panel's own comment).
describe("MemberRosterPanel name invitation", () => {
  const setup = () => {
    mockGroupKeyEpoch = 3; // shared: the store exists, so a name can be set
    mockAuthority = "owner";
    namesMocks.setMyMemberName.mockClear();
    namesMocks.clearMyMemberName.mockClear();
  };

  it("offers the setter on the caller's own row, and only there", () => {
    const previous = mockMembers;
    setup();
    mockMembers = [
      rowView({
        fingerprint_hex: "aa".repeat(32),
        is_self: true,
        display_name: "",
        name_state: "absent",
      }),
      rowView({
        fingerprint_hex: "bb".repeat(32),
        is_self: false,
        display_name: "",
        name_state: "absent",
      }),
    ];
    render(<MemberRosterPanel />);
    try {
      const ownRow = screen
        .getAllByTestId("member-roster.row")
        .find((li) => li.getAttribute("data-fingerprint") === "aa".repeat(32).slice(0, 16));
      expect(within(ownRow!).getByTestId("member-roster.name-edit").textContent).toBe(
        "sync.memberRoster.nameInviteCta",
      );
      // The sentence and its `Not now` link are gone: the button is the whole
      // invitation, so the row has exactly one affordance to set a name.
      expect(screen.queryByTestId("member-roster.name-invite")).toBeNull();
      expect(screen.queryByTestId("member-roster.name-invite-dismiss")).toBeNull();
      expect(screen.getAllByTestId("member-roster.name-edit")).toHaveLength(1);
    } finally {
      cleanup();
      mockMembers = previous;
      mockGroupKeyEpoch = null;
    }
  });

  it("offers only a rename once a name is set", () => {
    const previous = mockMembers;
    setup();
    mockMembers = [
      rowView({
        fingerprint_hex: "aa".repeat(32),
        is_self: true,
        display_name: "Ada",
        name_state: "verified",
      }),
    ];
    render(<MemberRosterPanel />);
    try {
      // The row still offers a rename: the ability to SET a name is not the same
      // as the standing ability to change one.
      expect(screen.getByTestId("member-roster.name-edit").textContent).toBe(
        "sync.memberRoster.nameEdit",
      );
    } finally {
      cleanup();
      mockMembers = previous;
      mockGroupKeyEpoch = null;
    }
  });

  it("does not invite on an unshared vault, where a name cannot be set", () => {
    const previous = mockMembers;
    mockAuthority = "owner";
    mockGroupKeyEpoch = null; // birth-format vault: the family does not exist
    mockMembers = [rowView({ is_self: true, display_name: "", name_state: "absent" })];
    render(<MemberRosterPanel />);
    try {
      expect(screen.queryByTestId("member-roster.name-edit")).toBeNull();
    } finally {
      cleanup();
      mockMembers = previous;
    }
  });
});

// The two facts the deleted `MEMBER DEVICES` panel still owed (myne-md/myne#976).
//
// The panel listed every device in the vault beside the member who claimed it, and
// nothing on it could be acted on but your own row. What survives is what nothing
// else said: how many devices each member has claimed HERE, and whether any claim
// failed verification. Both now live where a reader already looks.
describe("MemberRosterPanel device claims", () => {
  const row = (person: string, deviceByte: string) => ({
    device_id_hex: deviceByte.repeat(32),
    person_fingerprint_hex: person,
    person_id_hex: null,
    member_name: null,
    is_this_device: false,
  });

  afterEach(() => {
    mockBindingsView = null;
    mockBindingsError = null;
  });

  it("counts a member's claimed devices on their row", () => {
    mockMembers = [
      rowView({ fingerprint_hex: "11".repeat(32), display_name: "Two Devices" }),
      rowView({ fingerprint_hex: "22".repeat(32), display_name: "No Devices" }),
    ];
    mockBindingsView = {
      rows: [row("11".repeat(32), "a"), row("11".repeat(32), "b")],
      unverified_device_ids: [],
    };
    render(<MemberRosterPanel />);
    try {
      const counts = screen.getAllByTestId("member-roster.device-count");
      expect(counts).toHaveLength(1);
      expect(counts[0].textContent).toContain("sync.memberRoster.deviceCount:2");
      // Zero is ABSENT rather than "0 devices": a member with no claim here is
      // not a fact worth a line about a thing that does not exist.
      expect(screen.getByText("No Devices")).toBeDefined();
    } finally {
      cleanup();
    }
  });

  it("states an unverified claim once and never renders the device id", () => {
    mockBindingsView = {
      rows: [row("11".repeat(32), "a")],
      unverified_device_ids: ["f".repeat(32), "e".repeat(32)],
    };
    const { container } = render(<MemberRosterPanel />);
    try {
      const line = screen.getByTestId("member-roster.device-claims-unverified");
      expect(line.textContent).toContain("sync.memberRoster.deviceClaimsUnverified:2");
      // The invariant the panel itself carried, kept: `unverified_device_ids`
      // names devices and no persons, so an id beside a member's name would be
      // the attribution the backend's partition exists to withhold.
      expect(container.innerHTML).not.toContain("f".repeat(32));
      expect(container.innerHTML).not.toContain("e".repeat(32));
    } finally {
      cleanup();
    }
  });

  it("reports an unreadable store rather than an empty one", () => {
    mockBindingsView = null;
    mockBindingsError = "sync.deviceBindings.errorUnreadable";
    render(<MemberRosterPanel />);
    try {
      const failure = screen.getByTestId("member-roster.device-claims-error");
      expect(failure.textContent).toBe("sync.deviceBindings.errorUnreadable");
      // A damaged store answering as "no claims" is the one way this line could
      // be silently wrong, so the failure is not folded into the empty state.
      expect(screen.queryByTestId("member-roster.device-claims-unverified")).toBeNull();
    } finally {
      cleanup();
    }
  });
});
