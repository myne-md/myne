// @vitest-environment jsdom
//
// The publish row's DURABLE state (myne-md/myne#911 task 8).
//
// The panel used to learn "published" from its own last click, which is a fact
// about this session rather than about the vault: after a restart a published
// vault read "device only" again, and nothing outside the panel could carry the
// answer at all. These cases pin the three things that replaced it.
//
//  1. The row is gated on the READ, not on the identity. A client that cannot
//     answer `sync_published_state` cannot publish either (the browser refuses
//     both commands; mobile has no person plane yet), so it must not offer a
//     button that fails.
//  2. The recorded state is what the helper shows on mount, with no click.
//  3. A person-born vault does not get the legacy "add this device" form. That
//     form is the VAULT ACCOUNT flow (account number + password) and a vault born
//     under an identity has no such account, so it would be asking for a number
//     that does not exist.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, screen, waitFor } from "@testing-library/react";

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

// The publish row lives on the panel's CONNECTION topic, in the account section
// directly under the identity and the server (2026-10-25). It used to sit under
// "Enrolled devices", which read as a device operation: it is an identity act,
// and its refusals are `PersonSessionRequired` and `PersonNotRegistered`. Only
// the active topic body is mounted, so selecting the topic is what a user does to
// reach the row and the spec does the same rather than reaching into the
// component. `it("is not on the devices topic")` below holds the placement.
function mount(
  route: Parameters<typeof syncPanelCommandRouter>[0],
  topic: "connection" | "devices" = "connection",
): void {
  setActiveSettingsTopic("sync", topic);
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

describe("the publish row", () => {
  it("says device only for a vault that has never been published", async () => {
    mount({ syncState: "not_enrolled", publishState: { published: false, person_born: true } });
    await waitFor(() => expect(screen.getByTestId("sync.panel.publish")).toBeTruthy());
    expect(screen.getByTestId("sync.panel.publish-state").textContent).toContain(
      "exists only on this device",
    );
    expect((screen.getByTestId("sync.panel.publish") as HTMLButtonElement).textContent).toBe(
      "Publish this vault",
    );
  });

  it("reports a published vault from disk, with no click behind it", async () => {
    mount({
      syncState: "not_enrolled",
      publishState: { published: true, person_born: true, namespace_hex: "ab".repeat(16) },
    });
    await waitFor(() => expect(screen.getByTestId("sync.panel.publish")).toBeTruthy());
    expect(screen.getByTestId("sync.panel.publish-state").textContent).toContain(
      "This vault is on your sync server",
    );
    expect((screen.getByTestId("sync.panel.publish") as HTMLButtonElement).textContent).toBe(
      "Publish again",
    );
  });

  it("offers nothing when the state cannot be read", async () => {
    // The browser and mobile answer this command with a refusal, so the row is
    // absent rather than present-and-broken.
    mount({ syncState: "not_enrolled" });
    await waitFor(() => expect(screen.getByTestId("settings.sync-topic-connection")).toBeTruthy());
    expect(screen.queryByTestId("sync.panel.publish")).toBeNull();
  });

  // 2026-10-25. The row sat under "Enrolled devices", so a published vault's
  // first sight of it was a devices heading over a vault-publishing action. The
  // placement is a fact about the panel and nothing else asserted it, so this
  // fails on the section the row actually renders in rather than on a comment.
  it("is not on the devices topic, which is about devices", async () => {
    invokeMock.mockImplementation(
      syncPanelCommandRouter({ syncState: "not_enrolled", publishState: { published: true } }),
    );
    setActiveSettingsTopic("sync", "devices");
    renderSyncPanel();
    await waitFor(() => expect(screen.getByTestId("settings.sync-topic-devices")).toBeTruthy());
    expect(screen.queryByTestId("sync.panel.publish")).toBeNull();
  });

  // The record carries `published_at_ms` and the panel used to render "Published."
  // and nothing else, so the one fact that turns the claim into a record reached
  // no surface. `useTick` keeps it honest while the panel stays open.
  it("says WHEN it was published, from the recorded ms", async () => {
    mount({
      syncState: "not_enrolled",
      publishState: {
        published: true,
        person_born: true,
        namespace_hex: "ab".repeat(16),
        published_at_ms: Date.now() - 3 * 60_000,
      },
    });
    await waitFor(() => expect(screen.getByTestId("sync.panel.publish")).toBeTruthy());
    const helper = screen.getByTestId("sync.panel.publish-state").textContent ?? "";
    expect(helper).toContain("Published");
    expect(helper).toMatch(/min(t)? ago/);
  });

  it("cannot publish with no endpoint configured", async () => {
    // `disabled` is a device with nowhere to publish TO; the Server section is
    // the remedy, so the button is not offered as a way to fail.
    mount({ syncState: "disabled", publishState: { published: false } });
    await waitFor(() => expect(screen.getByTestId("settings.sync-topic-connection")).toBeTruthy());
    expect(screen.queryByTestId("sync.panel.publish")).toBeNull();
  });

  it("re-reads the durable record after a publish, so the row and the vault row agree", async () => {
    let published = false;
    invokeMock.mockImplementation(async (cmd: string) => {
      if (cmd === "plugin:sync|sync_publish_vault") {
        published = true;
        return { namespace_hex: "ab".repeat(16), newly_published: true };
      }
      if (cmd === "plugin:sync|sync_published_state") {
        return {
          published,
          namespace_hex: published ? "ab".repeat(16) : null,
          published_at_ms: published ? 1_700_000_000_000 : null,
          person_born: true,
        };
      }
      return syncPanelCommandRouter({ syncState: "not_enrolled" })(cmd);
    });
    setActiveSettingsTopic("sync", "connection");
    renderSyncPanel();
    await waitFor(() => expect(screen.getByTestId("sync.panel.publish")).toBeTruthy());
    fireEvent.click(screen.getByTestId("sync.panel.publish"));
    await waitFor(() =>
      expect(screen.getByTestId("sync.panel.publish-state").textContent).toContain(
        "This vault is on your sync server",
      ),
    );
    expect(published).toBe(true);
  });
});

describe("the legacy add-device form", () => {
  it("is offered for a legacy vault with no token", async () => {
    // The add-device form is the DEVICES topic's, which is the point: this row
    // stayed where it belongs when the publish row moved out from above it.
    mount(
      { syncState: "not_enrolled", publishState: { published: false, person_born: false } },
      "devices",
    );
    await waitFor(() => expect(screen.getByTestId("sync.enroll")).toBeTruthy());
  });

  it("is not offered for a person-born vault", async () => {
    mount({ syncState: "not_enrolled", publishState: { published: false, person_born: true } });
    await waitFor(() => expect(screen.getByTestId("sync.panel.publish")).toBeTruthy());
    expect(screen.queryByTestId("sync.enroll")).toBeNull();
  });
});

// 2026-10-23. A refused publish used to REPLACE the row's muted helper with
// another muted sentence: no alert, no colour, nothing announced. Reported as
// "clicking does nothing", which is what it looked like. The refusal is an error
// now, and the readout keeps saying what the vault actually is.
describe("the publish refusal", () => {
  it("is announced as an error, and leaves the readout intact", async () => {
    invokeMock.mockImplementation(async (cmd: string) => {
      if (cmd === "plugin:sync|sync_publish_vault") throw { kind: "PersonNotRegistered" };
      if (cmd === "plugin:sync|sync_published_state") {
        return {
          published: false,
          namespace_hex: null,
          published_at_ms: null,
          person_born: true,
        };
      }
      return syncPanelCommandRouter({ syncState: "not_enrolled" })(cmd);
    });
    setActiveSettingsTopic("sync", "connection");
    renderSyncPanel();
    await waitFor(() => expect(screen.getByTestId("sync.panel.publish")).toBeTruthy());
    fireEvent.click(screen.getByTestId("sync.panel.publish"));

    const message = await screen.findByText(/Register your identity first/);
    expect(message.getAttribute("role")).toBe("alert");
    expect(screen.getByTestId("sync.panel.publish-state").textContent).toContain(
      "exists only on this device",
    );
    // The control stays enabled: the retry is the same button.
    expect((screen.getByTestId("sync.panel.publish") as HTMLButtonElement).disabled).toBe(false);
  });
});
