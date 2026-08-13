// @vitest-environment jsdom
//
// The one expression in `SyncPanel` that decides whether a device is invited to
// enrol — and, until MYND-635, the expression that invited the one person it
// could not help.
//
// # The gate, and why it was wrong
//
// `showEnroll = enrollmentKnown && !enrolledHere` reads the DEVICE ROSTER. A
// device awaiting approval holds no token, so the roster call fails
// `NotEnrolled` (`devices.rs:293`) — which makes `enrollmentKnown` true and
// `enrolledHere` false, and lights the form up. It can never stop lighting up,
// because the only thing that would flip `enrolledHere` is the roster the
// device cannot read.
//
// Pressing that form does not merely fail. `sync_enroll` mints a FRESH
// `device_id` (`enroll.rs:151`), so each attempt leaves another pending record
// on the account — devices nobody can identify, each needing its own approval,
// while the one in front of the user still waits. The live account that
// surfaced this bug carries five.
//
// # Why the fix asks `sync_status` and not the roster
//
// The roster is precisely what a pending device cannot read, so asking it "am I
// pending?" is asking the one source guaranteed to be silent. `sync_status`
// derives the answer from disk — identity persisted, token absent — with no
// server round trip and no token required.
//
// # Why this file exists at all
//
// `SyncPanel` had NO test of any kind before this. The gate shipped, was wrong,
// and nothing anywhere would have said so.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

const invokeMock = vi.fn();

vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => invokeMock(...args),
}));
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(() => Promise.resolve(() => {})),
}));

import { SyncPanel } from "../../src/components/settings/SyncPanel";
import { SidebarStateProvider } from "../../src/notes/sidebarState";
import { ENROLL_PENDING_NOTICE } from "../../src/lib/load-bearing-copy";

/** `usePrefs` consumers crash on a bare `undefined`; answer prefs-shaped. */
const PREFS_STUB = { device_names: {} };

/**
 * Route every command this panel's subtree issues.
 *
 * `syncState` is the whole variable under test. The roster ALWAYS rejects
 * `NotEnrolled` here, because that is what a token-less device gets and it is
 * what made the old gate stick — so any behaviour difference between the cases
 * below comes from `sync_status` alone.
 */
function mountWith(syncState: string, betaTermsAccepted = true) {
  invokeMock.mockImplementation(async (cmd: string) => {
    if (cmd === "plugin:sync|sync_list_devices") throw { kind: "NotEnrolled" };
    if (cmd === "plugin:sync|sync_status") return { state: syncState };
    if (cmd === "plugin:sync|sync_beta_terms_accepted") return betaTermsAccepted;
    if (cmd === "plugin:sync|sync_accept_beta_terms") return undefined;
    if (cmd === "plugin:prefs|prefs_read") return PREFS_STUB;
    if (cmd === "plugin:sync|sync_get_endpoint") return { endpoint_url: null };
    if (cmd === "plugin:sync|sync_account_status") return null;
    if (cmd === "plugin:sync|sync_pending_conflicts") return [];
    if (cmd === "plugin:sync|sync_list_quarantine") return [];
    if (cmd === "plugin:notes|note_list") return [];
    return undefined;
  });
  // `SyncPanel` reads the selected note through the sidebar context (its
  // conflict view links to one), so the panel cannot mount bare.
  return render(
    <SidebarStateProvider>
      <SyncPanel />
    </SidebarStateProvider>,
  );
}

beforeEach(() => {
  invokeMock.mockReset();
});
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("the enrol gate, for a device that cannot read the roster", () => {
  it("offers the enrol form when the device is genuinely not enrolled", async () => {
    // The case the form is FOR, pinned first — otherwise a fix that simply
    // deleted the form would pass every assertion below.
    mountWith("not_enrolled");
    await waitFor(() => {
      expect(screen.getByText("Add a device")).toBeTruthy();
    });
    expect(screen.queryByTestId("sync.panel.awaiting-approval")).toBeNull();
  });

  it("withholds it from a device that is awaiting approval", async () => {
    mountWith("pending");
    await waitFor(() => {
      expect(screen.getByTestId("sync.panel.awaiting-approval")).toBeTruthy();
    });
    // The heart of it. Enrolling again mints a new `device_id` and strands a
    // second pending record; the affordance is OMITTED, not disabled, which is
    // this codebase's rule for something a client cannot honour.
    expect(screen.queryByText("Add a device")).toBeNull();
  });

  it("says why it is waiting, in the load-bearing wording", async () => {
    // Byte-for-byte from `@myne/copy`, not an i18n key. `check-i18n.mjs`
    // derives its load-bearing list from those exported constants and fails if
    // one shows up as a catalog value — so this sentence cannot quietly acquire
    // 24 machine-filled variants that each promise something slightly else.
    mountWith("pending");
    await waitFor(() => {
      expect(screen.getByText(ENROLL_PENDING_NOTICE)).toBeTruthy();
    });
  });

  it("withholds it from a device that already holds a token", async () => {
    // The roster still rejects here, exactly as in every case above — so this
    // is the assertion that the ENROLLED case is now answered by status too,
    // not by `enrolledHere`. It is also the case mobile got wrong
    // (myne-md/myne-mobile#38): an already-syncing device shown "Add this
    // device", where pressing it mints a second registration.
    mountWith("idle");
    await waitFor(() => {
      expect(screen.getByTestId("sync.device-management")).toBeTruthy();
    });
    expect(screen.queryByText("Add a device")).toBeNull();
    expect(screen.queryByTestId("sync.panel.awaiting-approval")).toBeNull();
  });

  // ── The beta-terms gate in front of that form (myne-ops#15) ──────────────
  //
  // The terms are a dialog, and a dialog can be dismissed. What must survive
  // that is the rule the consent component states: no route to the enrol form
  // that skips the text. It survives by the form not being RENDERED until the
  // terms are accepted — not by being covered, and not by being disabled.
  it("withholds the enrol form until the beta terms are accepted", async () => {
    mountWith("not_enrolled", false);
    await waitFor(() => expect(screen.getByTestId("sync.beta-terms.open")).toBeTruthy());
    expect(screen.queryByTestId("sync.enroll")).toBeNull();
  });

  it("opening the dialog, dismissing it, and only then accepting", async () => {
    mountWith("not_enrolled", false);
    fireEvent.click(await screen.findByTestId("sync.beta-terms.open"));

    // Every clause is in the dialog — the accepting button is rendered beside
    // them and nowhere else.
    expect(await screen.findByTestId("sync.beta-terms.what-this-is")).toBeTruthy();
    expect(screen.getByTestId("sync.beta-terms.data-loss")).toBeTruthy();
    expect(screen.getByTestId("sync.beta-terms.what-happens-next")).toBeTruthy();
    expect(screen.getByTestId("sync.beta-terms.what-we-can-see")).toBeTruthy();

    // Dismissing records nothing and reveals nothing.
    fireEvent.click(screen.getByTestId("sync.beta-terms.cancel"));
    await waitFor(() => expect(screen.queryByTestId("sync.beta-terms.accept")).toBeNull());
    expect(screen.queryByTestId("sync.enroll")).toBeNull();
    expect(
      invokeMock.mock.calls.some((c) => c[0] === "plugin:sync|sync_accept_beta_terms"),
    ).toBe(false);

    // Accepting is what opens the door.
    fireEvent.click(screen.getByTestId("sync.beta-terms.open"));
    fireEvent.click(await screen.findByTestId("sync.beta-terms.accept"));
    expect(await screen.findByTestId("sync.enroll")).toBeTruthy();
  });

  it("the roster failure alone does not decide it", async () => {
    // Both cases above see the SAME roster rejection. If the gate were still
    // reading only the roster, the two would render identically — so this
    // asserts the difference exists at all, which is the regression that would
    // reappear if someone reverted to `enrollmentKnown && !enrolledHere`.
    mountWith("not_enrolled");
    await waitFor(() => expect(screen.getByText("Add a device")).toBeTruthy());
    const notEnrolledShowsForm = screen.queryByText("Add a device") !== null;
    cleanup();

    mountWith("pending");
    await waitFor(() =>
      expect(screen.getByTestId("sync.panel.awaiting-approval")).toBeTruthy(),
    );
    const pendingShowsForm = screen.queryByText("Add a device") !== null;

    expect(notEnrolledShowsForm).toBe(true);
    expect(pendingShowsForm).toBe(false);
  });
});
