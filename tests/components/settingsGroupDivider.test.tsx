// @vitest-environment jsdom
//
// "An empty group with a visible heading" — myne-md/myne#557, the
// `settings.block.developer-mode` bullet.
//
// `SettingsModal.tsx` records that the Developer divider is DERIVED rather than
// declared: it renders only where a developer-group panel survived the
// capability + preference filter. That claim has three ways to go wrong and only
// one of them is visible in a desktop hand-walk:
//
// - the divider renders with no panel behind it (a heading over nothing),
// - it renders more than once (one per developer panel instead of one per
//   boundary),
// - it renders on a build whose developer panels are ALL capability-absent —
//   which is the web build, and no desktop walk can see it at all.
//
// So the assertion is written as an INVARIANT over the rail rather than as a
// screenshot of one configuration: every rendered group header is followed by at
// least one panel of that group, under every combination of the preference and
// the two developer capabilities. That is what makes the empty-group case fail
// by name instead of being a thing somebody notices.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";

/** Developer-mode preference, flipped per test. */
let developerMode = false;
/** Capabilities this simulated build has. Absence is the interesting case. */
let present = new Set<string>(["localAi", "torRouting"]);

vi.mock("../../src/hooks/usePrefs", () => ({
  usePrefs: () => ({
    prefs: { developer_mode: developerMode },
    setDeveloperMode: vi.fn(),
  }),
}));

vi.mock("../../src/platform/capabilities", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/platform/capabilities")>();
  return { ...actual, has: (cap: string) => present.has(cap) };
});

// Panels are stubbed to markers: this file is about the RAIL, not the panels,
// and a real panel would drag its own IPC in.
vi.mock("../../src/components/settings/AccountPanel", () => ({
  AccountPanel: () => <div data-testid="panel.account">account</div>,
}));
vi.mock("../../src/components/settings/PrivacyPanel", () => ({
  PrivacyPanel: () => <div data-testid="panel.privacy">privacy</div>,
}));
vi.mock("../../src/components/settings/EditorPanel", () => ({
  EditorPanel: () => <div data-testid="panel.editor">editor</div>,
}));
vi.mock("../../src/components/settings/AppearancePanel", () => ({
  AppearancePanel: () => <div data-testid="panel.appearance">appearance</div>,
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

const { SettingsModal } = await import("../../src/components/SettingsModal");

/** The two panels that live in the Developer group. */
const DEVELOPER_TABS = ["settings.tab-ai", "settings.tab-network"] as const;
const GROUP_HEADER = "settings.developer-group";

function mount() {
  render(
    <SettingsModal
      open
      vaultId="00000000-0000-7000-8000-000000000000"
      onClose={vi.fn()}
      onDeleteVaultSuccess={vi.fn()}
    />,
  );
}

/**
 * The rail's own nav element.
 *
 * Scoped rather than `screen.getByRole("tablist")` because that query is now
 * ambiguous: since myne-md/myne#885 a settings panel with topics renders its own
 * `role="tablist"` inside the content column, so a bare query finds two and
 * throws. The rail is the one that is a `<nav>`, and a missing rail has to fail
 * by name rather than as a null dereference.
 */
function railNav(): HTMLElement {
  const nav = document.querySelector("nav[role='tablist']");
  expect(nav, "the settings rail is not in the document").not.toBeNull();
  return nav as HTMLElement;
}

/**
 * The rail, read in DOM order as a flat list of `header` and `tab` entries.
 *
 * Reading ORDER rather than mere presence is what lets the invariant below be
 * about "followed by", which is the actual claim. A test that only counted
 * headers and panels would pass on a rail that rendered the heading last.
 */
function railSequence(): Array<{ kind: "header" | "tab"; id: string }> {
  const nav = railNav();
  return Array.from(nav.querySelectorAll("[data-testid]")).map((el) => {
    const id = el.getAttribute("data-testid")!;
    return { kind: id === GROUP_HEADER ? ("header" as const) : ("tab" as const), id };
  });
}

beforeEach(() => {
  developerMode = false;
  present = new Set(["localAi", "torRouting"]);
});

afterEach(cleanup);

describe("the Developer divider is derived from what survived the filter", () => {
  it("renders once, at the boundary, with developer panels behind it", () => {
    developerMode = true;
    mount();
    const seq = railSequence();
    const headers = seq.filter((e) => e.kind === "header");
    expect(headers.length, "one divider per boundary, not one per panel").toBe(1);

    const at = seq.findIndex((e) => e.kind === "header");
    const after = seq.slice(at + 1);
    expect(after.length, "a heading with nothing after it is a heading over nothing")
      .toBeGreaterThan(0);
    expect(after.every((e) => DEVELOPER_TABS.includes(e.id as never))).toBe(true);
    // …and nothing from the group leaked ABOVE the divider.
    expect(
      seq.slice(0, at).some((e) => DEVELOPER_TABS.includes(e.id as never)),
      "a developer panel rendered before the divider that announces the group",
    ).toBe(false);
  });

  it("renders no divider and no developer panel when the preference is off", () => {
    developerMode = false;
    mount();
    expect(screen.queryByTestId(GROUP_HEADER)).toBeNull();
    for (const id of DEVELOPER_TABS) expect(screen.queryByTestId(id)).toBeNull();
    // The core rail is still there, so the negative is not vacuous.
    expect(screen.getByTestId("settings.tab-account")).toBeTruthy();
  });

  it("renders no divider on a build where EVERY developer panel is capability-absent", () => {
    // The web build: `localAi` and `torRouting` are both absent, so Developer
    // mode being on leaves the group empty. A declared divider would render a
    // heading over nothing here, and no desktop walk could ever see it.
    developerMode = true;
    present = new Set();
    mount();
    expect(
      screen.queryByTestId(GROUP_HEADER),
      "Developer mode is on but no panel in the group survived the capability " +
        "filter, so the group is empty and its heading must not render",
    ).toBeNull();
    for (const id of DEVELOPER_TABS) expect(screen.queryByTestId(id)).toBeNull();
    expect(screen.getByTestId("settings.tab-account")).toBeTruthy();
  });

  it("still renders the divider when only ONE developer panel survives", () => {
    // The partial case, which the all-or-nothing pair above cannot reach: the
    // divider is a boundary marker, so one surviving panel is enough for it and
    // is still exactly one heading.
    developerMode = true;
    present = new Set(["localAi"]);
    mount();
    expect(screen.getAllByTestId(GROUP_HEADER).length).toBe(1);
    expect(screen.getByTestId("settings.tab-ai")).toBeTruthy();
    expect(screen.queryByTestId("settings.tab-network")).toBeNull();
  });
});

describe("the rail invariant: no heading without members", () => {
  const CASES: ReadonlyArray<[label: string, dev: boolean, caps: string[]]> = [
    ["developer off, everything present", false, ["localAi", "torRouting"]],
    ["developer on, everything present", true, ["localAi", "torRouting"]],
    ["developer on, ai only", true, ["localAi"]],
    ["developer on, tor only", true, ["torRouting"]],
    ["developer on, nothing present", true, []],
    ["developer off, nothing present", false, []],
  ];

  it.each(CASES)("%s: every rendered heading is followed by a member", (_l, dev, caps) => {
    developerMode = dev;
    present = new Set(caps);
    mount();
    const seq = railSequence();
    seq.forEach((entry, i) => {
      if (entry.kind !== "header") return;
      const next = seq[i + 1];
      expect(next, "a group heading is the last thing in the rail").toBeDefined();
      expect(
        next!.kind === "tab" && DEVELOPER_TABS.includes(next!.id as never),
        `the heading at index ${i} is followed by ${next?.id ?? "nothing"}, ` +
          `which is not a member of the group it announces`,
      ).toBe(true);
    });
    // The sweep must have rendered something in every case, or "no heading
    // without members" would hold trivially on an empty rail.
    expect(seq.filter((e) => e.kind === "tab").length).toBeGreaterThan(0);
  });
});
