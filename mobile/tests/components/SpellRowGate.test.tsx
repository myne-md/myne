// @vitest-environment jsdom
//
// The spell row is gated, and states its own absence (myne-md/myne#880).
//
// # The failure this pins
//
// `mobile/src/editor-host.ts` installs no `spell` slot, because this client
// ships no dictionary, so `getHost().spell` resolves to `undefined` and no
// squiggle can ever be drawn. The settings row was nonetheless rendered,
// tappable and inert: it wrote `spell_enabled`, the write succeeded, the value
// synced, and the editor applied nothing. A control that shows up and does
// nothing is worse than one that says it does not work here.
//
// # What is asserted, and why each half is needed
//
// Written the way `mobile/tests/developer-mode-absent.test.ts` asserts its own
// absent surface: a source scan, because the defect is a MISSING or mis-set
// prop and no compiler reports one. But the scan alone would be satisfied by
// spelling `disabled` at a switch that ignores it, so the behavioural half
// renders the shared `Switch` and proves `disabled` really blocks a toggle, in
// both directions.
//
// The third assertion is the one the mobile AGENTS.md gotcha demands: a copy
// assertion that never reaches `locales/en/common.json` is an assertion about a
// test double. So the helper key is read from the catalog rather than trusted.

import { readFileSync } from "node:fs";
import { join } from "node:path";

import { cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { Switch } from "../../src/components/inputs";
import { spellCheckingAvailable } from "../../src/lib/spellSupport";

afterEach(cleanup);

// `process.cwd()` rather than `import.meta.url`: under the jsdom environment
// the module URL is not a `file:` URL, and `fileURLToPath` throws on it. The
// mobile suite runs with the client as its working directory, which is how
// `mobile/tests/developer-mode-absent.test.ts` reaches the tree too.
const settingsSheet: string = readFileSync(
  join(process.cwd(), "src/app/flows/SettingsSheet.tsx"),
  "utf8",
);

const editorHost: string = readFileSync(join(process.cwd(), "src/editor-host.ts"), "utf8");

const catalog: Record<string, unknown> = JSON.parse(
  readFileSync(join(process.cwd(), "../locales/en/common.json"), "utf8"),
) as Record<string, unknown>;

/** Strip comments: prose about the absent backend is not an installed backend. */
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
}

/** The `<ToggleRow …>` element whose title is the spell row's. */
function spellRow(): string {
  const rows = [...settingsSheet.matchAll(/<ToggleRow[\s\S]*?\/>/g)].map((m) => m[0]);
  const row = rows.find((r) => r.includes('t("settings.spell.label")'));
  expect(row, "no ToggleRow titled settings.spell.label, so nothing below checked anything").toBeDefined();
  return row!;
}

/** A dotted key read out of the catalog, so a renamed key fails here. */
function catalogValue(key: string): string {
  let node: unknown = catalog;
  for (const part of key.split(".")) {
    node = (node as Record<string, unknown>)?.[part];
  }
  return typeof node === "string" ? node : "";
}

describe("the mobile spell row is gated, not inert", () => {
  it("reports spell checking as unavailable on this client", () => {
    expect(spellCheckingAvailable()).toBe(false);
  });

  it("agrees with the host, which installs no spell slot", () => {
    // The gate and the wiring cannot part company in either direction: the
    // predicate must be false while the host omits the slot, and the day the
    // slot lands this assertion fails until the predicate is flipped with it.
    expect(stripComments(editorHost)).not.toMatch(/\bspell\s*:/);
    expect(spellCheckingAvailable()).toBe(false);
  });

  it("disables the row's switch and states the reason", () => {
    const row = spellRow();
    expect(row).toContain("disabled={!spellAvailable}");
    expect(row).toContain('"settings.spell.mobileUnavailable"');
    // And the predicate it reads is the one under test above, not a second
    // literal: the two lines above are only a claim about THIS row if the value
    // they read is the client-wide answer.
    expect(settingsSheet).toMatch(/const spellAvailable = spellCheckingAvailable\(\)/);
  });

  it("has the helper sentence in the catalog, non-empty", () => {
    const copy = catalogValue("settings.spell.mobileUnavailable");
    expect(copy.length).toBeGreaterThan(0);
    // It must name the absence rather than imply parity, which is the whole
    // point of gating instead of hiding.
    expect(copy.toLowerCase()).toContain("not available");
  });

  it("cannot be toggled while disabled, and can when not", () => {
    // The behavioural half. `disabled` is what makes the gate real; a source
    // scan would pass on a switch that ignored it.
    const onToggle = vi.fn();
    const { getByRole, unmount } = render(<Switch on={false} onToggle={onToggle} disabled />);
    fireEvent.click(getByRole("switch"));
    expect(onToggle).not.toHaveBeenCalled();
    expect(getByRole("switch").getAttribute("aria-disabled")).toBe("true");
    unmount();

    const live = vi.fn();
    const { getByRole: get2 } = render(<Switch on={false} onToggle={live} />);
    fireEvent.click(get2("switch"));
    expect(live).toHaveBeenCalledTimes(1);
  });
});
