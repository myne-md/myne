// @vitest-environment jsdom
//
// The mobile Members panel's row-identity rule (myne-md/myne#851 task 15). This is
// the mobile twin of `tests/components/memberRosterPanel.test.tsx` on the desktop
// side, and it exists because that rule had no component test here at all: the
// phone's panel was covered by the flow-logic tier, which drives the ACCEPT flow
// and never mounts this panel, so every arm below could have been re-ordered with
// the whole tree green.
//
// What is under test is the ONE RULE, in arm ORDER, over `name_state` and `is_self`
// and never over `role`:
//
//   1. the caller's OWN row renders its verified name like any other, plus a "You"
//      marker beside it so its owner sees what the other members see;
//      an UNNAMED self row keeps the badge in the name slot, there being no name;
//   2. a row whose name is backed by a signature renders that name;
//   3. otherwise the SHORT fingerprint, plus a marker when a record exists that
//      no signature backs, and the claimed name is never rendered.
//
// "One rule" is the assertion that is easy to lose: the desktop panel guarded its
// owner row's name with `role !== "owner"` by hand before task 5, so an owner row
// carrying a verified name rendered nothing. Same failure is available here in the
// other direction, which is why the owner-row case below is a test and not a
// remark.

import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { RosterMemberView } from "../../src/lib/sync";

// The real module is spread rather than replaced: `@myne/i18n` initializes
// i18next with `initReactI18next` at import time, and a wholesale mock leaves that
// undefined and the whole suite fails to load.
vi.mock("react-i18next", async (importOriginal) => {
  const real = await importOriginal<typeof import("react-i18next")>();
  return { ...real, useTranslation: () => ({ t: (key: string) => key }) };
});

// The roster per test. `useMembers` is the panel's only data dependency, so
// mocking it is the whole fixture: no IPC, no host, no backend.
let mockMembers: RosterMemberView[] = [];
let mockAuthority: "owner" | "member" | null = "member";
let mockGroupKeyEpoch: number | null = 1;
let mockError: string | null = null;

vi.mock("../../src/lib/sync", async (importOriginal) => {
  const real = await importOriginal<typeof import("../../src/lib/sync")>();
  return {
    ...real,
    useMembers: () => ({
      members: mockMembers,
      authority: mockAuthority,
      groupKeyEpoch: mockGroupKeyEpoch,
      error: mockError,
    }),
  };
});

import { SyncMembersPanel } from "../../src/components/SyncSettingsPanels";

/** One row over a base fixture, so a test states only what it is about. */
const row = (over: Partial<RosterMemberView>): RosterMemberView => ({
  fingerprint_hex: "ab".repeat(32),
  is_self: false,
  display_name: "",
  name_state: "absent",
  role: "member",
  previous_fingerprint_hex: null,
  continuity: null,
  ...over,
});

/** Restore the shared fixture after a test that replaced it. */
function reset(): void {
  mockMembers = [];
  mockAuthority = "member";
  mockGroupKeyEpoch = 1;
  mockError = null;
}

afterEach(() => {
  cleanup();
  reset();
});

describe("SyncMembersPanel row identity rule (myne-md/myne#851 task 15)", () => {
  it("renders the verified name where the signed store holds one", () => {
    mockMembers = [
      row({ fingerprint_hex: "11".repeat(32), display_name: "Ada", name_state: "verified" }),
    ];
    render(<SyncMembersPanel />);
    expect(screen.getByTestId("sync.members.name").textContent).toBe("Ada");
    // The name IS the identifier where there is one, so no fingerprint is drawn
    // beside it: two identifiers for one row is how a user learns to ignore both.
    expect(screen.queryByTestId("sync.members.fingerprint")).toBeNull();
  });

  it("falls back to the short fingerprint and marks nothing when no record exists", () => {
    const bare = "22".repeat(32);
    mockMembers = [row({ fingerprint_hex: bare, display_name: "", name_state: "absent" })];
    render(<SyncMembersPanel />);
    expect(screen.queryByTestId("sync.members.name")).toBeNull();
    expect(screen.getByTestId("sync.members.fingerprint").textContent).toBe(bare.slice(0, 16));
    // An absent record is not a failure: the user has simply not chosen a name.
    expect(screen.queryByTestId("sync.members.name-unverified")).toBeNull();
  });

  it("renders the unverified marker instead of a name nobody signed", () => {
    mockMembers = [
      row({
        fingerprint_hex: "33".repeat(32),
        // A claimed name is present on the wire and must NOT reach the DOM: it is
        // exactly the field an attacker with write access to the store controls.
        display_name: "Ada",
        name_state: "unverified",
      }),
    ];
    render(<SyncMembersPanel />);
    expect(screen.queryByTestId("sync.members.name")).toBeNull();
    expect(screen.getByTestId("sync.members.name-unverified").textContent).toBe(
      "sync.memberRoster.nameUnverified",
    );
    // The identifier that IS trustworthy stays on the row.
    expect(screen.getByTestId("sync.members.fingerprint").textContent).toBe(
      "33".repeat(32).slice(0, 16),
    );
    expect(document.body.textContent).not.toContain("Ada");
  });

  it("renders the caller's own verified name with a you marker beside it", () => {
    mockMembers = [
      row({
        fingerprint_hex: "aa".repeat(32),
        is_self: true,
        // The row shows the name it wrote, so its owner sees what the other
        // members see; the "You" marker is what still says which row is theirs
        //.
        display_name: "Ada",
        name_state: "verified",
      }),
    ];
    render(<SyncMembersPanel />);
    expect(screen.getByTestId("sync.members.name").textContent).toBe("Ada");
    expect(screen.getByTestId("sync.members.you").textContent).toBe(
      "sync.memberRoster.youBadge",
    );
  });

  it("keeps the badge in the name slot of an unnamed self row, with no marker", () => {
    mockMembers = [row({ fingerprint_hex: "aa".repeat(32), is_self: true })];
    render(<SyncMembersPanel />);
    expect(screen.getByTestId("sync.members.name").textContent).toBe(
      "sync.memberRoster.youBadge",
    );
    expect(screen.queryByTestId("sync.members.you")).toBeNull();
  });

  it("marks another person's row You only when the backend says is_self", () => {
    mockMembers = [
      row({
        fingerprint_hex: "ff".repeat(32),
        // An owner row that is NOT the caller. Keying "You" on `role === "owner"`
        // made an invited member read the owner's row as themselves on their own
        // phone (myne-md/myne#859, desktop side).
        role: "owner",
        is_self: false,
        display_name: "Omer",
        name_state: "verified",
      }),
      row({ fingerprint_hex: "aa".repeat(32), is_self: true, role: "member" }),
    ];
    render(<SyncMembersPanel />);
    const rows = screen.getAllByTestId("sync.members.row");
    // Exactly one "You", in the second row.
    const badges = screen.getAllByText("sync.memberRoster.youBadge");
    expect(badges).toHaveLength(1);
    expect(within(rows[1]).getByTestId("sync.members.name").textContent).toBe(
      "sync.memberRoster.youBadge",
    );
    // The owner row reads as the owner and still shows the name it was signed for.
    expect(within(rows[0]).getByTestId("sync.members.name").textContent).toBe("Omer");
    expect(within(rows[0]).getAllByText("sync.memberRoster.ownerBadge")).toHaveLength(1);
  });

  it("renders an owner's verified name on the owner's own row like any other name", () => {
    // The assertion that fails if the rule is replaced by the role: an owner who
    // is also the caller is the row on which the name and the "You" marker meet,
    // and the name must still render.
    mockMembers = [
      row({
        fingerprint_hex: "44".repeat(32),
        is_self: true,
        role: "owner",
        display_name: "Omer",
        name_state: "verified",
      }),
    ];
    render(<SyncMembersPanel />);
    expect(screen.getByTestId("sync.members.name").textContent).toBe("Omer");
    expect(screen.getByTestId("sync.members.you").textContent).toBe(
      "sync.memberRoster.youBadge",
    );
  });

  it("always renders the role badge, in every arm", () => {
    mockMembers = [
      row({ fingerprint_hex: "11".repeat(32), display_name: "Ada", name_state: "verified", role: "owner" }),
      row({ fingerprint_hex: "22".repeat(32), is_self: true, role: "member" }),
      row({ fingerprint_hex: "33".repeat(32), display_name: "Ada", name_state: "unverified", role: "member" }),
    ];
    render(<SyncMembersPanel />);
    // Scoped to the rows: the panel's authority line renders the same badge copy,
    // so a document-wide count would be counting that line too.
    const rows = screen.getAllByTestId("sync.members.row");
    expect(rows).toHaveLength(3);
    expect(within(rows[0]).getByText("sync.memberRoster.ownerBadge")).toBeDefined();
    expect(within(rows[1]).getByText("sync.memberRoster.memberBadge")).toBeDefined();
    expect(within(rows[2]).getByText("sync.memberRoster.memberBadge")).toBeDefined();
  });

  it("never puts a full fingerprint in the DOM", () => {
    const raw = "77".repeat(32);
    mockMembers = [row({ fingerprint_hex: raw, display_name: "", name_state: "absent" })];
    render(<SyncMembersPanel />);
    expect(document.body.innerHTML).not.toContain(raw);
    expect(screen.getByTestId("sync.members.fingerprint").textContent).toBe(raw.slice(0, 16));
  });
});

describe("SyncMembersPanel states", () => {
  it("states the caller's own authority rather than a row's", () => {
    mockAuthority = "owner";
    mockMembers = [row({ fingerprint_hex: "11".repeat(32), display_name: "Ada", name_state: "verified" })];
    render(<SyncMembersPanel />);
    expect(screen.getByTestId("sync.members.authority").textContent).toContain(
      "sync.memberRoster.ownerBadge",
    );
  });

  it("shows no role at all until the roster has been read", () => {
    // myne-md/myne#938 task 13. The hook's authority is `null` until a read
    // answers, and `null` is a third state rather than a fail-closed default: a
    // badge saying "Member" is a CLAIM to the user, and to a vault's owner it is
    // the wrong one. The absent-not-disabled rule applies to a fact here, not to
    // a control, which is why the row is omitted rather than greyed.
    mockAuthority = null;
    render(<SyncMembersPanel />);
    expect(screen.queryByTestId("sync.members.authority")).toBeNull();
    // Nothing else may claim a role either: the badge copy must be absent from
    // the whole panel, not just from that row.
    expect(screen.queryByText("sync.memberRoster.memberBadge")).toBeNull();
    expect(screen.queryByText("sync.memberRoster.ownerBadge")).toBeNull();
  });

  it("leaves the role unknown when the roster read failed", () => {
    // The failure arm is the one that used to assert "member": a read that never
    // answered is the last state in which a role can be inferred, so the error row
    // says what happened and no role is shown beside it.
    mockAuthority = null;
    mockError = "NotUnlocked";
    render(<SyncMembersPanel />);
    expect(screen.queryByTestId("sync.members.authority")).toBeNull();
    expect(screen.getByTestId("sync.members.error")).toBeDefined();
  });

  it("renders an unreadable roster as an error, not as an empty one", () => {
    // The two are different answers: one says "this device cannot read the
    // roster", the other "the vault has no members", and a user who reads the
    // second when the truth is the first concludes they were removed.
    mockError = "NotUnlocked";
    render(<SyncMembersPanel />);
    expect(screen.getByTestId("sync.members.error")).toBeDefined();
    expect(screen.queryByTestId("sync.members.empty")).toBeNull();
  });

  it("renders a readable but empty roster as empty", () => {
    mockMembers = [];
    render(<SyncMembersPanel />);
    expect(screen.getByTestId("sync.members.empty")).toBeDefined();
    expect(screen.queryByTestId("sync.members.error")).toBeNull();
  });
});
