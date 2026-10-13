// @vitest-environment jsdom
//
// Task 3 (settings-search) — render evidence for the search UI leaf components,
// exercised with the REAL i18n instance (setup-i18n) so the new
// `settings.search.*` keys resolve to their English strings. Covers: input
// placeholder + onChange, grouped result rows with the right testids/data-attrs,
// selection callback, and the explicit empty state echoing the query.

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { SettingsSearch } from "../../src/components/settings/search/SettingsSearch";
import { SettingsSearchResults } from "../../src/components/settings/search/SettingsSearchResults";
import {
  WRITABILITY_NONE,
  type SettingsIndexEntry,
} from "../../src/components/settings/search/settingsSearchIndex";

afterEach(cleanup);

const ENTRIES: SettingsIndexEntry[] = [
  { id: "privacy.screen-capture", panelId: "privacy", titleKey: "settings.privacy.screenCaptureLabel" , agentWritability: WRITABILITY_NONE },
  { id: "privacy.auto-lock", panelId: "privacy", titleKey: "settings.privacy.autoLockLabel" , agentWritability: WRITABILITY_NONE },
  { id: "appearance.theme", panelId: "appearance", titleKey: "settings.appearance.themeLabel" , agentWritability: WRITABILITY_NONE },
];

describe("SettingsSearch input", () => {
  it("renders the search input with placeholder and reports typing", () => {
    const onQueryChange = vi.fn();
    render(<SettingsSearch query="" onQueryChange={onQueryChange} />);
    const input = screen.getByTestId("settings.search-input") as HTMLInputElement;
    expect(input.placeholder).toBe("Search settings…");
    fireEvent.change(input, { target: { value: "theme" } });
    expect(onQueryChange).toHaveBeenCalledWith("theme");
  });
});

describe("SettingsSearchResults", () => {
  it("groups rows by panel and tags each with its setting id + panel", () => {
    render(
      <SettingsSearchResults results={ENTRIES} query="a" onSelect={() => {}} />,
    );
    const rows = screen.getAllByTestId("settings.search-result");
    expect(rows).toHaveLength(3);
    // Panel grouping is stable in first-appearance order: privacy (2) then appearance (1).
    expect(rows.map((r) => r.getAttribute("data-panel"))).toEqual([
      "privacy",
      "privacy",
      "appearance",
    ]);
    expect(rows[0].getAttribute("data-setting-id")).toBe("privacy.screen-capture");
    // Two group headings (Privacy, Appearance) resolve to real English labels.
    expect(screen.getByText("Privacy")).toBeTruthy();
    expect(screen.getByText("Appearance")).toBeTruthy();
  });

  it("fires onSelect with the clicked entry", () => {
    const onSelect = vi.fn();
    render(
      <SettingsSearchResults results={ENTRIES} query="a" onSelect={onSelect} />,
    );
    fireEvent.click(screen.getAllByTestId("settings.search-result")[2]);
    expect(onSelect).toHaveBeenCalledWith(ENTRIES[2]);
  });

  it("marks the keyboard-active row (activeId) for AT + styling", () => {
    render(
      <SettingsSearchResults
        results={ENTRIES}
        query="a"
        activeId="appearance.theme"
        onSelect={() => {}}
      />,
    );
    const rows = screen.getAllByTestId("settings.search-result");
    const active = rows.find((r) => r.getAttribute("data-setting-id") === "appearance.theme")!;
    expect(active.getAttribute("data-active")).toBe("true");
    expect(active.getAttribute("aria-selected")).toBe("true");
    // Non-active rows are not selected.
    const other = rows.find((r) => r.getAttribute("data-setting-id") === "privacy.auto-lock")!;
    expect(other.getAttribute("aria-selected")).toBe("false");
  });

  it("shows the empty state echoing the query when there are no results", () => {
    render(<SettingsSearchResults results={[]} query="zzz" onSelect={() => {}} />);
    const empty = screen.getByTestId("settings.search-empty");
    expect(empty.textContent).toContain("zzz");
    expect(screen.queryByTestId("settings.search-results")).toBeNull();
  });
});
