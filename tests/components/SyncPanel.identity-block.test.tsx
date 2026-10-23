// @vitest-environment jsdom
//
// The Sync panel's Identity block, per device identity state.
//
// It used to render ONLY when no identity existed, so a device that held an
// identity (the common case, an owner created one at vault creation) had no
// identity surface here at all, and a locked one had no way to see which
// identity it held. The block now renders in every state: it offers the Add CTA
// when there is none, and otherwise shows the held identity's public code and,
// while the private identity is locked for the session, the unlock action.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, screen, waitFor } from "@testing-library/react";

const invokeMock = vi.fn();
const writeTextMock = vi.hoisted(() => vi.fn());

vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => invokeMock(...args),
}));
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(() => Promise.resolve(() => {})),
}));
vi.mock("@tauri-apps/plugin-clipboard-manager", () => ({
  writeText: writeTextMock,
}));

import { getToasts, resetToasts } from "../../src/components/toast/toastStore";
import {
  resetPersonIdentityState,
  setPersonIdentityState,
} from "../../src/components/sync/personIdentityState";
import { renderSyncPanel, syncPanelCommandRouter } from "./_syncPanelHarness";
import { setActiveSettingsTopic } from "../../src/components/settings/SettingsTabs";

function mount(route: Parameters<typeof syncPanelCommandRouter>[0]): void {
  invokeMock.mockImplementation(syncPanelCommandRouter(route));
  renderSyncPanel();
}

beforeEach(() => {
  invokeMock.mockReset();
  writeTextMock.mockReset().mockResolvedValue(undefined);
  resetPersonIdentityState();
  resetToasts();
});
afterEach(() => {
  cleanup();
  resetPersonIdentityState();
  vi.clearAllMocks();
});

describe("the Identity block, per device identity state", () => {
  it("offers the Add CTA when this device holds no identity", async () => {
    mount({ syncState: "idle" });
    await waitFor(() => expect(screen.getByTestId("sync.panel.add-identity")).toBeTruthy());
    expect(screen.queryByTestId("sync.panel.identity-locked")).toBeNull();
    expect(screen.queryByTestId("sync.panel.identity-unlocked")).toBeNull();
  });

  it("shows the held identity's code and the unlock action while it is locked", async () => {
    mount({
      syncState: "idle",
      person: {
        enrolled: true,
        identity_unlocked: false,
        identity_code: "MYNE-PERSON-1:deadbeef",
        sealed_keypair_present: true,
      },
    });
    await waitFor(() => expect(screen.getByTestId("sync.panel.identity-locked")).toBeTruthy());
    const code = screen.getByTestId("sync.panel.identity-code") as HTMLInputElement;
    expect(code.value).toBe("MYNE-PERSON-1:deadbeef");
    // The copy chip sits beside the code; the unlock is the inline phrase
    // entry below the row (myne-md/myne#831).
    expect(screen.getByTestId("sync.panel.copy-identity")).toBeTruthy();
    expect(screen.getByTestId("sync.panel.identity-unlock.open")).toBeTruthy();
    // The Add CTA is not shown; the identity already exists.
    expect(screen.queryByTestId("sync.panel.add-identity")).toBeNull();
  });

  it("shows the identity as unlocked, with no add or unlock action", async () => {
    mount({
      syncState: "idle",
      person: {
        enrolled: true,
        identity_unlocked: true,
        identity_code: "MYNE-PERSON-1:deadbeef",
        sealed_keypair_present: true,
      },
    });
    await waitFor(() => expect(screen.getByTestId("sync.panel.identity-unlocked")).toBeTruthy());
    expect(screen.queryByTestId("sync.panel.add-identity")).toBeNull();
    expect(screen.queryByTestId("sync.panel.identity-unlock")).toBeNull();
  });

  it("treats a sealed-but-unenrolled identity as 'recover', not 'add'", async () => {
    // `sealed_keypair_present` with `enrolled: false` is myne-md/myne#780's
    // shape: a live identity this device holds but whose token never landed.
    mount({
      syncState: "idle",
      person: { enrolled: false, sealed_keypair_present: true, identity_code: "c" },
    });
    await waitFor(() => expect(screen.getByTestId("sync.panel.identity-locked")).toBeTruthy());
    expect(screen.queryByTestId("sync.panel.add-identity")).toBeNull();
  });

  it("copies the identity code with outcome feedback (myne-md/myne#823)", async () => {
    // The chip's BEHAVIOUR, not just its presence: a test that only asserts the
    // testid exists passes with an empty `copyIdentityCode` body. This is the
    // third identity-code-copy surface (the other two are in
    // identityCodeCopy.test.tsx, which the locked harness here cannot drive).
    mount({
      syncState: "idle",
      person: {
        enrolled: true,
        identity_unlocked: false,
        identity_code: "MYNE-PERSON-1:deadbeef",
        sealed_keypair_present: true,
      },
    });
    await waitFor(() => expect(screen.getByTestId("sync.panel.copy-identity")).toBeTruthy());

    await act(async () => {
      fireEvent.click(screen.getByTestId("sync.panel.copy-identity"));
    });
    await waitFor(() =>
      expect(writeTextMock).toHaveBeenCalledWith("MYNE-PERSON-1:deadbeef"),
    );
    expect(getToasts().at(-1)?.variant).toBe("info");
    expect(getToasts().at(-1)?.message).toBe("Identity code copied");
  });

  it("reports a clipboard failure on the identity chip (myne-md/myne#823)", async () => {
    writeTextMock.mockRejectedValueOnce(new Error("clipboard unavailable"));
    mount({
      syncState: "idle",
      person: {
        enrolled: true,
        identity_unlocked: false,
        identity_code: "MYNE-PERSON-1:deadbeef",
        sealed_keypair_present: true,
      },
    });
    await waitFor(() => expect(screen.getByTestId("sync.panel.copy-identity")).toBeTruthy());

    await act(async () => {
      fireEvent.click(screen.getByTestId("sync.panel.copy-identity"));
    });
    await waitFor(() => expect(getToasts().at(-1)?.variant).toBe("error"));
    expect(getToasts().at(-1)?.message).toBe("Couldn't copy the identity code");
  });

  it("re-derives the locked branch after the identity is locked from the roster", async () => {
    // The roster's Lock identity clears the shared store; the block must
    // re-probe rather than keep its mount-time snapshot claiming unlocked, or
    // the only unlock surface is gone until Settings is reopened
    // (myne-md/myne#831 review).
    let unlocked = true;
    invokeMock.mockImplementation(async (cmd: string) => {
      if (cmd === "plugin:sync|sync_person_status") {
        return {
          enrolled: true,
          identity_unlocked: unlocked,
          person_id_hex: "11".repeat(16),
          identity_code: "MYNE-PERSON-1:deadbeef",
          sealed_keypair_present: true,
        };
      }
      return syncPanelCommandRouter({ syncState: "idle" })(cmd);
    });
    // A held, unlocked identity implies the shared store is seeded.
    setPersonIdentityState({ ready: true, ownerCode: "MYNE-PERSON-1:deadbeef" });
    renderSyncPanel();
    await waitFor(() => expect(screen.getByTestId("sync.panel.identity-unlocked")).toBeTruthy());

    unlocked = false;
    await act(async () => {
      setPersonIdentityState({ ready: false, ownerCode: null });
    });

    await waitFor(() => expect(screen.getByTestId("sync.panel.identity-locked")).toBeTruthy());
    expect(screen.getByTestId("sync.panel.identity-unlock.open")).toBeTruthy();
  });
});

// 2026-10-23. Registration was reachable only from the identity home, which
// renders at ZERO vaults. A user sitting in a vault therefore had no door, and
// the publish row's own refusal sent them to that screen.
describe("the identity block's register door", () => {
  it("offers registration for a reserved identity, with the shared 24-cell grid", async () => {
    setActiveSettingsTopic("sync", "connection");
    invokeMock.mockImplementation(
      syncPanelCommandRouter({
        person: { state: "reserved", sealed_keypair_present: true, identity_code: "code" },
      }),
    );
    renderSyncPanel();
    fireEvent.click(await screen.findByTestId("sync.panel.register-cta"));
    expect(await screen.findByTestId("sync.panel.register-phrase-grid")).toBeTruthy();
    // No endpoint is configured in the harness, so the address is asked for here
    // rather than in a Settings screen the user cannot reach without a vault.
    expect(await screen.findByTestId("sync.panel.register-server")).toBeTruthy();
  });

  it("does not offer it for an enrolled identity", async () => {
    setActiveSettingsTopic("sync", "connection");
    invokeMock.mockImplementation(
      syncPanelCommandRouter({
        person: { state: "enrolled", enrolled: true, identity_code: "code" },
      }),
    );
    renderSyncPanel();
    await waitFor(() => expect(screen.queryByTestId("sync.panel.register-cta")).toBeNull());
  });
});

// 2026-10-23 review: the Settings door's submit path used to be unexecuted
// (only its CTA and grid were asserted), so an empty body would have stayed
// green. One click through the shared form.
describe("the Settings register door submits", () => {
  it("writes the address and then registers, in that order", async () => {
    setActiveSettingsTopic("sync", "connection");
    const calls: string[] = [];
    invokeMock.mockImplementation(async (cmd: string, args?: Record<string, unknown>) => {
      if (cmd === "plugin:sync|sync_person_register") {
        calls.push(`register:${String(args?.phrase ?? "").split(" ").length}`);
        return {};
      }
      if (cmd === "plugin:sync|sync_set_endpoint") {
        calls.push("endpoint");
        return { pin_source: "platform_trust_store" };
      }
      return syncPanelCommandRouter({
        person: { state: "reserved", sealed_keypair_present: true, identity_code: "code" },
      })(cmd);
    });
    renderSyncPanel();
    fireEvent.click(await screen.findByTestId("sync.panel.register-cta"));
    const grid = await screen.findByTestId("sync.panel.register-phrase-grid");
    for (let i = 0; i < 24; i += 1) {
      const id =
        i === 0 ? "sync.panel.register-phrase" : `sync.panel.register-phrase-cell-${i + 1}`;
      fireEvent.change(screen.getByTestId(id), { target: { value: `word${i + 1}` } });
    }
    fireEvent.change(await screen.findByTestId("sync.panel.register-server"), {
      target: { value: "https://sync.example" },
    });
    fireEvent.click(screen.getByTestId("sync.panel.register-submit"));
    await waitFor(() => expect(calls).toEqual(["endpoint", "register:24"]));
    expect(grid).toBeTruthy();
  });
});
