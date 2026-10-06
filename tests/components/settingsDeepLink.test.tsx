// @vitest-environment jsdom
//
// "Customize ribbon…" must land ON the ribbon setting, not merely in the panel
// that contains it (myne-md/myne#773).
//
// The Appearance panel is nine blocks tall. Opening it at the top and leaving
// the user to find the one block they asked for is the failure a deep link
// exists to prevent — and the machinery to finish the job was already in the
// shell, with exactly one caller: the settings search box. So this is not new
// behaviour so much as a second caller for behaviour that was already there,
// which is why the test is about the SHELL honouring the request rather than
// about scrolling.
//
// The real anchor's existence on the real block is a separate claim, asserted
// at the bottom against the search index, because a deep link to an id nothing
// carries degrades silently to a plain panel switch — which is exactly the
// behaviour being replaced, arriving again with no error anywhere.

import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, screen } from "@testing-library/react";

vi.mock("../../src/components/settings/AccountPanel", () => ({
  AccountPanel: () => <div data-testid="panel.account">account</div>,
}));
vi.mock("../../src/components/settings/PrivacyPanel", () => ({
  PrivacyPanel: () => <div data-testid="panel.privacy">privacy</div>,
}));
vi.mock("../../src/components/settings/EditorPanel", () => ({
  EditorPanel: () => <div data-testid="panel.editor">editor</div>,
}));
vi.mock("../../src/components/settings/StoragePanel", () => ({
  StoragePanel: () => <div data-testid="panel.storage">storage</div>,
}));
vi.mock("../../src/components/settings/AboutPanel", () => ({
  AboutPanel: () => <div data-testid="panel.about">about</div>,
}));
vi.mock("../../src/components/settings/AiPanel", () => ({
  AiPanel: () => <div data-testid="panel.ai">ai</div>,
}));
vi.mock("../../src/components/settings/NetworkPanel", () => ({
  NetworkPanel: () => <div data-testid="panel.network">network</div>,
}));
// The Appearance panel stands in for itself, carrying only the thing under
// test: a settings row bearing the anchor the deep link names. The real panel
// would drag nine blocks of IPC in and none of it decides this.
vi.mock("../../src/components/settings/AppearancePanel", () => ({
  AppearancePanel: () => (
    <div data-testid="panel.appearance">
      <div data-setting-row="true" data-setting-anchor="appearance.language">
        language
      </div>
      <div data-setting-row="true" data-setting-anchor="appearance.ribbon">
        ribbon
      </div>
    </div>
  ),
}));

const { SettingsModal } = await import("../../src/components/SettingsModal");
const { SETTINGS_SEARCH_INDEX } = await import(
  "../../src/components/settings/search/settingsSearchIndex"
);

const VAULT = "00000000-0000-7000-8000-000000000000";

/** jsdom implements neither; the shell calls both on the row it lands on. */
function captureScrolls(): string[] {
  const seen: string[] = [];
  Element.prototype.scrollIntoView = function scrollIntoView(this: Element) {
    seen.push((this as HTMLElement).dataset.settingAnchor ?? "?");
  };
  return seen;
}

async function open(anchor?: string) {
  render(
    <SettingsModal
      open
      vaultId={VAULT}
      initialPanel="appearance"
      initialAnchor={anchor}
      onClose={vi.fn()}
      onDeleteVaultSuccess={vi.fn()}
    />,
  );
  // The scroll runs in a rAF so the just-mounted panel can lay out first.
  await act(async () => {
    await new Promise((r) => requestAnimationFrame(() => r(null)));
  });
}

afterEach(cleanup);

describe("a deep link lands on the setting", () => {
  it("scrolls to and flashes the anchored row", async () => {
    const seen = captureScrolls();
    await open("appearance.ribbon");
    expect(await screen.findByTestId("panel.appearance")).not.toBeNull();
    expect(seen, "the shell must scroll the named row into view").toEqual([
      "appearance.ribbon",
    ]);
    expect(
      document
        .querySelector('[data-setting-anchor="appearance.ribbon"]')
        ?.getAttribute("data-setting-flash"),
      "and flash it, or the landing is indistinguishable from a scroll position",
    ).toBe("true");
  });

  it("opens the panel and scrolls nowhere when no anchor is asked for", async () => {
    // Every other entry point into Settings passes none, and must keep landing
    // at the top of the panel rather than wherever the last deep link went.
    const seen = captureScrolls();
    await open(undefined);
    expect(await screen.findByTestId("panel.appearance")).not.toBeNull();
    expect(seen).toEqual([]);
  });

  it("degrades to a plain panel switch for an id nothing carries", async () => {
    const seen = captureScrolls();
    await open("appearance.not-a-setting");
    expect(await screen.findByTestId("panel.appearance")).not.toBeNull();
    expect(seen).toEqual([]);
  });
});

describe("the id the ribbon asks for is an id something answers", () => {
  it("is registered in the settings index", () => {
    // A deep link to an unregistered id is silent: the shell finds no entry,
    // scrolls nowhere, and the user gets the top-of-panel landing this change
    // exists to replace — with nothing reporting it. The literal is duplicated
    // between `Editor.tsx` and `RibbonCustomizeSettings.tsx`, so this is the
    // one place the pair is compared to the registry.
    expect(
      SETTINGS_SEARCH_INDEX.find((e) => e.id === "appearance.ribbon")?.panelId,
    ).toBe("appearance");
  });
});
