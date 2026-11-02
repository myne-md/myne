// @vitest-environment jsdom
//
// Publishing is not a control (myne-md/myne#974).
//
// Settings → Sync used to carry a "Publish to your server" row with a button, and
// that button was the ONLY way a person-born vault could reach a server: the
// command had exactly one call site, and a user who never found the row sat on a
// vault their other devices could not see (`GET /b2b/vaults` lists bindings, and
// publish is what creates one).
//
// The cycle now publishes on its own the first time it has an endpoint, a
// registered identity and a person session
// (`core/src/plugins/sync/publish.rs::publish_if_due`), so the row and its
// "Publish again" repair are gone. These cases hold the absence, because the
// failure mode this replaces was not a wrong control but a MISSING act: putting a
// button back would re-introduce the "press this or nothing syncs" shape, and a
// test that only checked the happy path would not notice.
//
// What is deliberately NOT asserted here: that the vault gets published. That is
// the cycle's behaviour, held in Rust against the four preconditions, and a panel
// test can only observe what the panel draws.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, screen, waitFor } from "@testing-library/react";

const invokeMock = vi.fn();

vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => invokeMock(...args),
}));
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(() => Promise.resolve(() => {})),
}));
vi.mock("@tauri-apps/plugin-clipboard-manager", () => ({
  writeText: vi.fn(() => Promise.resolve()),
}));

import { resetPersonIdentityState } from "../../src/components/sync/personIdentityState";
import { resetToasts } from "../../src/components/toast/toastStore";
import {
  resetSettingsTopics,
  setActiveSettingsTopic,
} from "../../src/components/settings/SettingsTabs";
import { renderSyncPanel, syncPanelCommandRouter } from "./_syncPanelHarness";

function mount(route: Parameters<typeof syncPanelCommandRouter>[0]): void {
  setActiveSettingsTopic("sync", "connection");
  invokeMock.mockImplementation(syncPanelCommandRouter(route));
  renderSyncPanel();
}

beforeEach(() => {
  invokeMock.mockReset();
  resetPersonIdentityState();
  resetToasts();
  resetSettingsTopics();
});
afterEach(() => {
  cleanup();
  resetPersonIdentityState();
  resetSettingsTopics();
  vi.clearAllMocks();
});

describe("the sync panel offers no publish control", () => {
  it("for a vault that is still device only", async () => {
    mount({
      syncState: "not_enrolled",
      publishState: { published: false, person_born: true },
    });
    await waitFor(() => expect(screen.getByTestId("sync.endpoint-config")).toBeTruthy());
    expect(screen.queryByTestId("sync.panel.publish")).toBeNull();
    expect(screen.queryByTestId("sync.panel.publish-row")).toBeNull();
    // The claim the row used to make is still made, in the place that can act on
    // it: the sync status row names the identity's state.
    expect(screen.queryByText(/exists only on this device/)).toBeNull();
  });

  it("for a published vault, where the old row drew a permanent repair button", async () => {
    mount({
      syncState: "idle",
      publishState: { published: true, person_born: true, namespace_hex: "ab".repeat(16) },
    });
    await waitFor(() => expect(screen.getByTestId("sync.status-indicator")).toBeTruthy());
    expect(screen.queryByTestId("sync.panel.publish")).toBeNull();
    expect(screen.queryByText(/Publish again/)).toBeNull();
  });

  it("for a device with no endpoint, where publishing had nowhere to go", async () => {
    mount({ syncState: "disabled", publishState: { published: false } });
    await waitFor(() => expect(screen.getByTestId("settings.sync-topic-connection")).toBeTruthy());
    expect(screen.queryByTestId("sync.panel.publish")).toBeNull();
  });

  it("when the publish state cannot be read at all", async () => {
    // The browser answers `sync_published_state` with a refusal, so a client that
    // cannot answer the question must not draw a control about it.
    mount({ syncState: "not_enrolled" });
    await waitFor(() => expect(screen.getByTestId("settings.sync-topic-connection")).toBeTruthy());
    expect(screen.queryByTestId("sync.panel.publish")).toBeNull();
  });
});
