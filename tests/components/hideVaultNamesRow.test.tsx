// @vitest-environment jsdom
//
// Settings → Privacy → "Hide vault names on the lock screen" (myne-md/myne#411).
//
// Four things are worth a test here, and "does the switch flip" is not one of
// them.
//
// 1. **The row is reachable by the person who needs it.** The option's honesty
//    depends on being set BEFORE a first unlock ever writes a name, because
//    cryptographic erase cannot reach a snapshot taken earlier. So it may not
//    be developer-gated, and the assertion is written against the settings
//    search index as well as the panel. Search resolves straight to a panel
//    id, so a `developerGated` tag there would hide the row from the one
//    surface a user reaches for when they cannot find a setting.
// 2. **The disclosure is complete and unclickable-away.** The two bounds (what
//    enabling destroys, and the copy it cannot reach) render without any
//    interaction. A bound behind a disclosure toggle is a bound most readers
//    never see, and "erases" read on its own means more than it does.
// 3. **A failed probe is not an unavailable keychain.** The backend's
//    unavailable case is a VALUE (`{ available: false }`) and never a rejection
//    (`core/src/vault_label/commands.rs`), so a rejection means the question
//    went unanswered. Reading it as "unavailable" would put a false
//    explanation on screen, and it is the exact shape a plaintext fallback
//    would later hide behind.
// 4. **A partial erase does not leave the row claiming an erase.**
//    `EraseIncomplete` means a key survived the sweep and the flag was
//    deliberately NOT persisted, so the switch must stay off and the notice
//    must say the names are still readable.
//
// Copy is asserted through the catalog rather than pasted, so the wording stays
// the catalog's business; what is pinned is the bound, which no translation may
// cross either.

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

const invokeMock = vi.fn();
vi.mock("../../src/platform/core", () => ({
  invoke: (...a: unknown[]) => invokeMock(...(a as [])),
}));

const { PrivacyPanel, hideNamesWriteNotice, hideVaultNamesErrorKind } = await import(
  "../../src/components/settings/PrivacyPanel"
);
const { SETTINGS_SEARCH_INDEX, visibleSettingsIndex } = await import(
  "../../src/components/settings/search/settingsSearchIndex"
);
const { searchSettings } = await import(
  "../../src/components/settings/search/searchSettings"
);
const i18n = (await import("../../src/i18n")).default;

const ENTRY_ID = "privacy.hide-vault-names";

/** Resolve an i18n key against the real English catalog. */
const t = (key: string): string => i18n.t(key);

/**
 * Drive the panel's IPC by command name.
 *
 * `usePrefs` mounts alongside this row and reads `vault.prefs`, so the stub has
 * to answer that too; anything unrecognised rejects loudly rather than
 * resolving `undefined`, which is how a renamed command would otherwise pass
 * every test in this file.
 */
function mountPanel(
  overrides: Partial<Record<string, () => Promise<unknown>>> = {},
) {
  invokeMock.mockImplementation((cmd: string) => {
    const override = overrides[cmd];
    if (override) return override();
    switch (cmd) {
      case "plugin:vault-label|hide_vault_names":
        return Promise.resolve({ hidden: false });
      case "plugin:vault-label|vault_label_keychain_status":
        return Promise.resolve({ available: true });
      case "plugin:prefs|prefs_read":
        return Promise.resolve({});
      default:
        return Promise.reject(new Error(`unstubbed command: ${cmd}`));
    }
  });
  render(<PrivacyPanel />);
}

afterEach(() => {
  cleanup();
  invokeMock.mockReset();
});

describe("hide vault names: reachable without Developer mode", () => {
  it("renders with the developer-mode preference off", async () => {
    // `usePrefs` defaults `developer_mode` to false on an empty prefs read, so
    // this mount IS the mode-off case. A row that only appeared behind the gate
    // would be missing here.
    mountPanel();
    expect(await screen.findByTestId("settings.hide-vault-names")).toBeTruthy();
  });

  it("is in the settings search index, capability-tagged and NOT developer-gated", () => {
    const entry = SETTINGS_SEARCH_INDEX.find((e) => e.id === ENTRY_ID);
    expect(entry, `no settings-search entry for ${ENTRY_ID}`).toBeDefined();
    expect(entry!.panelId).toBe("privacy");
    expect(
      entry!.developerGated,
      "the option must be findable by someone who has never opened Developer mode",
    ).toBeUndefined();
    // The two gates are independent, and only one of them applies here. The
    // capability tag has to match the panel's own condition or search would
    // navigate to an anchor that was never rendered.
    expect(
      entry!.capability,
      "PrivacyPanel omits the row where `lockedVaultNames` is absent",
    ).toBe("lockedVaultNames");
  });

  it("search finds it with Developer mode OFF", () => {
    const found = searchSettings(t("settings.privacy.hideVaultNamesLabel"), t, false).map(
      (e) => e.id,
    );
    expect(found).toContain(ENTRY_ID);
    // …and the list-everything query keeps it too, which is the path a
    // `developerGated` tag would silently remove it from.
    expect(searchSettings("", t, false).map((e) => e.id)).toContain(ENTRY_ID);
    expect(visibleSettingsIndex(false).map((e) => e.id)).toContain(ENTRY_ID);
  });

  it("its search title and description are the strings the row renders", () => {
    // Search text cannot drift from the UI if it IS the UI's keys.
    const entry = SETTINGS_SEARCH_INDEX.find((e) => e.id === ENTRY_ID)!;
    expect(entry.titleKey).toBe("settings.privacy.hideVaultNamesLabel");
    expect(entry.descriptionKey).toBe("settings.privacy.hideVaultNamesHelper");
  });
});

describe("hide vault names: the disclosure", () => {
  it("shows both bounds with no interaction", async () => {
    mountPanel();
    const disclosure = await screen.findByTestId("settings.hide-vault-names-disclosure");
    expect(disclosure.textContent).toContain(t("settings.privacy.hideVaultNamesErases"));
    expect(disclosure.textContent).toContain(t("settings.privacy.hideVaultNamesResidue"));
  });

  it("says what enabling destroys and that nothing further is written", () => {
    const copy = t("settings.privacy.hideVaultNamesErases").toLowerCase();
    expect(copy).toContain("destroys the keys");
    expect(copy).toContain("no further name is written");
  });

  it("names the copy erase cannot reach, rather than implying it reaches everything", () => {
    const copy = t("settings.privacy.hideVaultNamesResidue").toLowerCase();
    expect(copy).toContain("cannot reach");
    // The two carriers the decision entry names: a full-system backup and a
    // filesystem snapshot. A residue sentence that mentioned neither would be a
    // caveat with nothing in it.
    expect(copy).toMatch(/backup/);
    expect(copy).toMatch(/snapshot/);
  });

  it("claims no more than the threat model allows", () => {
    // The row is about a locally stored NAME. Words that would turn it into a
    // whole-device or whole-account promise.
    const forbidden = ["anonymous", "untraceable", "everywhere", "all your devices"];
    for (const key of [
      "settings.privacy.hideVaultNamesLabel",
      "settings.privacy.hideVaultNamesHelper",
      "settings.privacy.hideVaultNamesErases",
      "settings.privacy.hideVaultNamesResidue",
      "settings.privacy.hideVaultNamesUnavailable",
    ]) {
      const copy = t(key).toLowerCase();
      for (const word of forbidden) {
        expect(copy, `${key} must not say "${word}"`).not.toContain(word);
      }
    }
  });

  it("tells the reader the placeholder number stays with the vault", () => {
    // Task 5 made `Vault N` stable per vault rather than positional, so the row
    // is now allowed to say so, and a helper that promised a stable number
    // before that landed would have been false.
    const copy = t("settings.privacy.hideVaultNamesHelper").toLowerCase();
    expect(copy).toContain("placeholder");
    expect(copy).toContain("stays with the vault");
  });
});

describe("hide vault names: the keychain state", () => {
  it("says the option cannot work here when the probe reports unavailable", async () => {
    mountPanel({
      "plugin:vault-label|vault_label_keychain_status": () =>
        Promise.resolve({ available: false }),
    });
    const row = await screen.findByTestId("settings.hide-vault-names");
    await waitFor(() => expect(row.getAttribute("data-keychain")).toBe("unavailable"));
    expect(screen.getByTestId("settings.hide-vault-names-unavailable").textContent).toBe(
      t("settings.privacy.hideVaultNamesUnavailable"),
    );
  });

  it("treats a FAILED probe as unknown, never as unavailable", async () => {
    // The probe's `Result` exists for IPC-contract uniformity only: its
    // unavailable answer is a value, so a rejection means the question went
    // unanswered. Rendering "this device has no keychain" over a dev context,
    // an unported client or a transport hiccup would be a false explanation.
    mountPanel({
      "plugin:vault-label|vault_label_keychain_status": () =>
        Promise.reject(new Error("no host")),
    });
    const row = await screen.findByTestId("settings.hide-vault-names");
    await waitFor(() => expect(row.getAttribute("data-keychain")).toBe("unknown"));
    expect(screen.queryByTestId("settings.hide-vault-names-unavailable")).toBeNull();
  });

  it("keeps the switch interactive with no keychain, so the option can still be turned OFF", async () => {
    // Turning it off touches no keychain at all, which is what lets it succeed
    // on a device that has none. A disabled control would strand a user whose
    // keychain went away after they turned the option on.
    const setCalls: unknown[] = [];
    mountPanel({
      "plugin:vault-label|hide_vault_names": () => Promise.resolve({ hidden: true }),
      "plugin:vault-label|vault_label_keychain_status": () =>
        Promise.resolve({ available: false }),
      "plugin:vault-label|set_hide_vault_names": () => {
        setCalls.push("called");
        return Promise.resolve({ hidden: false });
      },
    });
    const row = await screen.findByTestId("settings.hide-vault-names");
    await waitFor(() => expect(row.getAttribute("data-hidden")).toBe("true"));

    fireEvent.click(screen.getByTestId("settings.hide-vault-names-toggle"));
    await waitFor(() => expect(setCalls.length).toBe(1));
  });

  it("a KeychainUnavailable rejection explains the device instead of reporting a failed save", async () => {
    mountPanel({
      "plugin:vault-label|vault_label_keychain_status": () =>
        Promise.reject(new Error("no host")),
      "plugin:vault-label|set_hide_vault_names": () =>
        Promise.reject({ kind: "KeychainUnavailable" }),
    });
    const row = await screen.findByTestId("settings.hide-vault-names");
    fireEvent.click(screen.getByTestId("settings.hide-vault-names-toggle"));

    await waitFor(() => expect(row.getAttribute("data-keychain")).toBe("unavailable"));
    expect(screen.getByTestId("settings.hide-vault-names-unavailable")).toBeTruthy();
    expect(screen.queryByTestId("settings.hide-vault-names-notice")).toBeNull();
    // The flag was deliberately not persisted, so the switch must not move.
    expect(row.getAttribute("data-hidden")).toBe("false");
  });
});

describe("hide vault names: failure reporting", () => {
  it("an incomplete erase leaves the switch off and says the names are still readable", async () => {
    mountPanel({
      "plugin:vault-label|set_hide_vault_names": () =>
        Promise.reject({ kind: "EraseIncomplete" }),
    });
    const row = await screen.findByTestId("settings.hide-vault-names");
    fireEvent.click(screen.getByTestId("settings.hide-vault-names-toggle"));

    await waitFor(() =>
      expect(screen.getByTestId("settings.hide-vault-names-notice").textContent).toBe(
        t("settings.privacy.hideVaultNamesErrorErase"),
      ),
    );
    expect(row.getAttribute("data-hidden")).toBe("false");
    expect(t("settings.privacy.hideVaultNamesErrorErase").toLowerCase()).toContain(
      "left off",
    );
  });

  it("an unreadable flag says so instead of asserting a position", async () => {
    mountPanel({
      "plugin:vault-label|hide_vault_names": () => Promise.reject({ kind: "Parse" }),
    });
    await waitFor(() =>
      expect(screen.getByTestId("settings.hide-vault-names-notice").textContent).toBe(
        t("settings.privacy.hideVaultNamesErrorRead"),
      ),
    );
  });

  it("classifies each backend failure apart from the others", () => {
    expect(hideNamesWriteNotice("EraseIncomplete")).toBe("erase");
    // Not a notice: the device's standing state has its own line on the row.
    expect(hideNamesWriteNotice("KeychainUnavailable")).toBeNull();
    expect(hideNamesWriteNotice("Io")).toBe("save");
    expect(hideNamesWriteNotice("Parse")).toBe("save");
    // An unrecognised rejection is a failed save, never a silent success.
    expect(hideNamesWriteNotice(null)).toBe("save");
  });

  it("narrows only the four tags the backend can send", () => {
    for (const kind of ["Io", "Parse", "KeychainUnavailable", "EraseIncomplete"]) {
      expect(hideVaultNamesErrorKind({ kind })).toBe(kind);
    }
    expect(hideVaultNamesErrorKind({ kind: "SomethingElse" })).toBeNull();
    expect(hideVaultNamesErrorKind(new Error("boom"))).toBeNull();
    expect(hideVaultNamesErrorKind(null)).toBeNull();
  });

  it("a save failure does not claim nothing happened", async () => {
    // The backend erases FIRST and persists second, so a failed write can leave
    // keys destroyed and the flag off. Copy reading "nothing changed" would be
    // false in the direction that matters.
    const copy = t("settings.privacy.hideVaultNamesErrorSave").toLowerCase();
    expect(copy).not.toContain("nothing changed");
    expect(copy).toContain("may already have been destroyed");
  });
});

describe("hide vault names: absent where the picker and the keychain are", () => {
  // Asserted against the WEB descriptor itself rather than an invented absent
  // set, so this cannot pass while the real client still renders the row. What
  // it pins is the pairing the two files owe each other: the dispatcher answers
  // `Unsupported` for `vault-label` (`web/wasm/src/capability.rs`), and a
  // refusal with the affordance still on screen is the broken-control failure
  // the capability descriptor exists to prevent.
  async function mountWebPanel() {
    const web = await import("../../web/src/platform/capabilities");
    vi.resetModules();
    vi.doMock("../../src/platform/capabilities", () => ({
      has: web.has,
      ALL_CAPABILITIES: web.ALL_CAPABILITIES,
    }));
    const { PrivacyPanel: WebPrivacyPanel } = await import(
      "../../src/components/settings/PrivacyPanel"
    );
    invokeMock.mockImplementation((cmd: string) =>
      cmd === "plugin:prefs|prefs_read"
        ? Promise.resolve({})
        : Promise.reject(new Error(`unstubbed command: ${cmd}`)),
    );
    render(<WebPrivacyPanel />);
  }

  afterEach(() => {
    vi.doUnmock("../../src/platform/capabilities");
    vi.resetModules();
  });

  it("renders no row on a client without `lockedVaultNames`", async () => {
    await mountWebPanel();
    // The panel itself mounted, so this is an absent ROW rather than an absent
    // panel: screen-capture protection is the row directly above it.
    await waitFor(() =>
      expect(screen.queryByTestId("settings.hide-vault-names")).toBeNull(),
    );
    expect(screen.queryByTestId("settings.hide-vault-names-toggle")).toBeNull();
  });

  it("issues none of the three vault-label commands there", async () => {
    // The defect this closes was three probes rejecting behind a rendered row.
    // Absence has to reach the IPC layer, not only the DOM.
    await mountWebPanel();
    await waitFor(() => expect(invokeMock).toHaveBeenCalled());
    const called = invokeMock.mock.calls.map((c) => c[0] as string);
    expect(called.filter((c) => c.startsWith("plugin:vault-label|"))).toEqual([]);
  });

  it("search cannot navigate to a row that was never rendered", async () => {
    const web = await import("../../web/src/platform/capabilities");
    vi.resetModules();
    vi.doMock("../../src/platform/capabilities", () => ({
      has: web.has,
      ALL_CAPABILITIES: web.ALL_CAPABILITIES,
    }));
    const { visibleSettingsIndex: webVisible } = await import(
      "../../src/components/settings/search/settingsSearchIndex"
    );
    expect(webVisible(true).map((e) => e.id)).not.toContain(ENTRY_ID);
  });
});
