// @vitest-environment jsdom
//
// The colour-groups row on mobile (myne-md/myne#727, writable here by
// myne-md/myne#880).
//
// # What this pins, and the one assertion that carries it
//
// `color_groups` is SHARED with the discipline `WholeValueLww`: the caller sends
// the COMPLETE list and the backend replaces it. A per-group upsert would be
// wrong in both directions, and both are silent: a reorder is unexpressible, and
// a concurrent desktop edit to a DIFFERENT group is lost rather than
// last-writer-wins.
//
// So the payload assertion is the point. "Something was written" would pass over
// a per-group merge, and asserting the resulting VALUE would too, because the
// merge and the replace agree on the value the caller already holds. What
// separates them is the SHAPE of what crossed the wire, which is what
// `withGroupPatched` and the recorded command both expose.
//
// The graph half (a new group repaints without a vault re-unlock) is asserted
// separately: every write goes through the prefs chokepoint, which bumps the
// nonce, and `WikiGraph`'s overlay memo is keyed on `prefs.color_groups`.

import { readFileSync } from "node:fs";
import { join } from "node:path";

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const invoke = vi.fn();

vi.mock("../../src/platform/core", () => ({
  invoke: (...args: unknown[]) => invoke(...args),
}));

vi.mock("react-i18next", () => ({
  // `src/notes/decorations.ts` (imported for `LABEL_SLOTS`) pulls the shared
  // i18n runtime, which calls `initReactI18next` at module load, so a mock that
  // replaced the whole module would fail before any assertion.
  initReactI18next: { type: "3rdParty", init: () => {} },
  useTranslation: () => ({ t: (key: string) => key }),
}));

import { ColorGroupsBlock, withGroupPatched } from "../../src/components/ColorGroupsBlock";
import type { ColorGroup } from "../../src/lib/prefs";

function group(id: string, name: string, color: string, enabled = true): ColorGroup {
  return { id, name, color, enabled, filter: { kind: "hasTag", tag: "work" } };
}

const GROUPS: ColorGroup[] = [group("g1", "Work", "moss"), group("g2", "Personal", "plum")];

function writes(): { cmd: string; groups: ColorGroup[] }[] {
  return invoke.mock.calls
    .map((c) => c as [string, { groups?: ColorGroup[] }])
    .filter(([cmd]) => cmd === "plugin:prefs|set_color_groups")
    .map(([, args]) => ({ cmd: "set_color_groups", groups: args.groups ?? [] }));
}

beforeEach(() => {
  invoke.mockReset();
  invoke.mockImplementation(async () => undefined);
});

afterEach(cleanup);

describe("mobile colour-groups row", () => {
  it("sends the WHOLE list when one group's colour changes", async () => {
    render(<ColorGroupsBlock groups={GROUPS} />);
    fireEvent.click(screen.getByTestId("settings.colorGroups.color-g1-ochre"));

    await waitFor(() => expect(writes()).toHaveLength(1));
    const payload = writes()[0].groups;
    // The whole sequence, in order, with the untouched sibling verbatim: this is
    // the assertion a per-group merge cannot satisfy.
    expect(payload).toHaveLength(2);
    expect(payload[0]).toEqual(group("g1", "Work", "ochre"));
    expect(payload[1]).toEqual(GROUPS[1]);
  });

  it("sends the whole list when a group is renamed", async () => {
    render(<ColorGroupsBlock groups={GROUPS} />);
    const name = screen.getByTestId("settings.colorGroups.name-g2") as HTMLInputElement;
    fireEvent.change(name, { target: { value: "Private" } });
    fireEvent.keyDown(name, { key: "Enter" });

    await waitFor(() => expect(writes()).toHaveLength(1));
    expect(writes()[0].groups.map((g) => g.name)).toEqual(["Work", "Private"]);
    // The order is precedence, so it must survive the edit untouched.
    expect(writes()[0].groups.map((g) => g.id)).toEqual(["g1", "g2"]);
  });

  it("carries the group's filter through untouched", async () => {
    // The filter is authored on a computer and this block does not edit it, so
    // a write must pass it through rather than dropping it. Dropping it would
    // turn every group into a rule that matches nothing, silently.
    render(<ColorGroupsBlock groups={GROUPS} />);
    fireEvent.click(screen.getByTestId("settings.colorGroups.color-g1-slate"));
    await waitFor(() => expect(writes()).toHaveLength(1));
    expect(writes()[0].groups[0].filter).toEqual({ kind: "hasTag", tag: "work" });
  });

  it("toggles a group's enabled flag without touching its siblings", async () => {
    render(<ColorGroupsBlock groups={GROUPS} />);
    fireEvent.click(screen.getAllByRole("switch")[0]);
    await waitFor(() => expect(writes()).toHaveLength(1));
    expect(writes()[0].groups[0].enabled).toBe(false);
    expect(writes()[0].groups[1]).toEqual(GROUPS[1]);
  });

  it("does not write when the name was not edited", async () => {
    render(<ColorGroupsBlock groups={GROUPS} />);
    const name = screen.getByTestId("settings.colorGroups.name-g1") as HTMLInputElement;
    fireEvent.keyDown(name, { key: "Enter" });
    await Promise.resolve();
    expect(writes()).toEqual([]);
  });

  it("states the absence rather than offering an Add button it cannot finish", () => {
    render(<ColorGroupsBlock groups={[]} />);
    expect(screen.getByTestId("settings.colorGroups.empty").textContent).toContain(
      "notes.graph.colorGroups.mobileEmptyBody",
    );
    // And no name field, no swatch: nothing that would look like a control.
    expect(screen.queryByTestId("settings.colorGroups.shared-notice")).toBeNull();
  });

  it("states which client's value it changes when there are groups", () => {
    render(<ColorGroupsBlock groups={GROUPS} />);
    expect(screen.getByTestId("settings.colorGroups.shared-notice").textContent).toContain(
      "notes.graph.colorGroups.mobileSharedNotice",
    );
  });

  it("reports a failed write and puts the name draft back on disk truth", async () => {
    // The list and the swatches read from `groups`, which a failed write leaves
    // unchanged, so the surface already shows disk truth. The NAME draft does
    // not: it is local state, and the re-seed effect only fires when `groups`
    // moves. Both halves are asserted, because a toast alone would leave the
    // field showing a name the vault does not hold.
    invoke.mockImplementation(async () => {
      throw new Error("write failed");
    });
    const onToast = vi.fn();
    render(<ColorGroupsBlock groups={GROUPS} onToast={onToast} />);
    const field = screen.getByTestId("settings.colorGroups.name-g1") as HTMLInputElement;
    fireEvent.change(field, { target: { value: "Renamed" } });
    fireEvent.keyDown(field, { key: "Enter" });

    await waitFor(() => expect(onToast).toHaveBeenCalledWith("settings.saveSettingError"));
    await waitFor(() => expect(field.value).toBe("Work"));
  });
});

describe("withGroupPatched", () => {
  it("replaces exactly one entry and preserves order and length", () => {
    const out = withGroupPatched(GROUPS, 1, { color: "stone" });
    expect(out.map((g) => g.id)).toEqual(["g1", "g2"]);
    expect(out[0]).toBe(GROUPS[0]);
    expect(out[1]).toEqual({ ...GROUPS[1], color: "stone" });
  });
});

describe("the graph repaints without a vault re-unlock", () => {
  it("keys the overlay memo on prefs.color_groups", () => {
    // The chain is: write -> writePref -> bumpPrefsNonce -> every mounted
    // `usePrefs` re-reads -> `WikiGraph`'s memo recomputes. The first two links
    // are `prefs-nonce.test.ts`'s subject and the last is this assertion; if the
    // dep list loses `prefs.color_groups` the row writes and the graph does not
    // move, which is exactly the inert-control shape this whole feature is
    // about.
    const src: string = readFileSync(join(process.cwd(), "src/components/WikiGraph.tsx"), "utf8");
    expect(src).toMatch(/\[builtModel, prefs\.color_groups, tags, members\]/);
  });
});
