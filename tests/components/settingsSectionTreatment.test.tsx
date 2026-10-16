// @vitest-environment jsdom
//
// One section treatment, and it is `SettingsSection` (myne-md/myne#885).
//
// The requester's complaint was that "how one section hands over to the next is
// unreadable" and that every settings tab solved it differently. The Editor tab
// was the one they read as correct, and the reason is mechanical rather than
// atmospheric: it was the one tab that composed the SHARED component for every
// group. The other panels either hand-rolled the same idea with their own values
// (`AiPanel`'s `GROUP_HEADING_*`, `HotkeysPanel`'s `GROUP_HEADING_STYLE`) or drew
// no seam at all.
//
// The hand-rolled copies are gone, and this is the machine half of "they stay
// gone": a third private one arriving unnoticed is exactly the failure a shared
// component is supposed to prevent, and nothing else in the tree can see it.
// `scripts/check-token-adoption.mjs` counts literals, not idioms; a review reads
// one diff, not the next one.
//
// WHAT A SECTION TREATMENT IS, precisely. It is the PAIR the shared component
// declares: a heading in the group-heading vocabulary (uppercase, tracked) and a
// rule that runs to the panel edge (`height: 1` plus a `var(--line-1)` or
// `var(--accent)` background, `flex: 1 1 auto`). Either half alone is a different
// and legitimate pattern: `SettingsSearchResults` and `HotkeysPanel` before this
// change had a heading with no rule, `NetworkPanel`'s posture label and
// `EditorPanel`'s preview caption are sub-labels, and `AccountPanel`'s
// `DIVIDER_STYLE` is a bare `<hr>`. What this catches is a file that draws the
// whole seam itself, which is the shape that drifted.
//
// THE LIMIT, stated rather than left to be discovered: a file that copies the
// heading half alone passes here, because the detector is about the seam and a
// heading-only group is not a seam. That is a deliberate narrowing, and the
// direction it narrows is the one a review can still see.

import { describe, expect, it } from "vitest";
import { cleanup, render } from "@testing-library/react";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import {
  SettingsSection,
  SettingsSectionCounter,
} from "../../src/components/settings/SettingsSection";

// `process.cwd()`, not `import.meta.url`: under the jsdom environment Vitest
// gives `import.meta.url` no `file:` scheme, so `fileURLToPath` throws. The same
// choice and the same reason as `tests/platform/settingsRowSetPerOs.test.tsx`,
// which this file now shares an environment with because it renders the tone.
const ROOT = process.cwd();
const COMPONENTS = join(ROOT, "src", "components");
const SHARED = join("settings", "SettingsSection.tsx");

/** The group-heading half: uppercase type with tracking. */
function hasGroupHeading(text: string): boolean {
  return /textTransform:\s*"uppercase"/.test(text) && /letterSpacing:/.test(text);
}

/** The seam half: a 1px rule that runs to the panel edge, in line or accent. */
function hasSeamRule(text: string): boolean {
  return (
    /height:\s*1\b/.test(text) &&
    /background:\s*"var\(--(?:line-1|accent)\)"/.test(text)
  );
}

/** A file that declares BOTH halves draws a section seam of its own. */
export function declaresSectionTreatment(text: string): boolean {
  return hasGroupHeading(text) && hasSeamRule(text);
}

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (name.endsWith(".tsx")) out.push(full);
  }
  return out;
}

describe("the section treatment is declared in exactly one place", () => {
  it("only SettingsSection.tsx draws the heading and the seam rule", () => {
    const files = walk(COMPONENTS);
    // A scan that silently covers less than it claims is the failure this
    // guards against, so the denominator is asserted rather than assumed.
    expect(files.length, "the component scan found almost nothing").toBeGreaterThan(40);

    const offenders = files.filter(
      (f) =>
        f !== join(COMPONENTS, SHARED) &&
        declaresSectionTreatment(readFileSync(f, "utf8")),
    );
    expect(
      offenders.map((f) => f.slice(COMPONENTS.length + 1)),
      "a second file declares its own section treatment; compose SettingsSection instead",
    ).toEqual([]);

    // Non-vacuity: the shared component MUST match, or the detector is broken
    // and the empty offender list above proves nothing.
    const shared = readFileSync(join(COMPONENTS, SHARED), "utf8");
    expect(declaresSectionTreatment(shared), "SettingsSection no longer matches").toBe(true);
  });

  it("every settings panel composes the shared treatment", () => {
    // The rail roster, read off disk rather than restated, so a thirteenth panel
    // cannot arrive without the seam. Every one of the twelve rail panels groups
    // its controls, and the point of this change is that they group them the
    // same way.
    const settings = join(COMPONENTS, "settings");
    const panels = readdirSync(settings)
      .filter((f: string) => f.endsWith("Panel.tsx"))
      .sort();
    expect(panels.length, "the panel scan found almost nothing").toBeGreaterThanOrEqual(12);

    const silent = panels.filter(
      (f: string) => !/<SettingsSection[\s>]/.test(readFileSync(join(settings, f), "utf8")),
    );
    expect(silent, "a settings panel draws no section seam at all").toEqual([]);
  });

  it("keeps the seam one idiom when the danger tone is used", () => {
    // The tone (myne-md/myne#885) moves the HEADING only, so the accent seam is
    // still the single idiom rather than one per tone. This is the half a render
    // cannot see: a `tone` that quietly grew its own red rule would still draw a
    // seam, and every other assertion here would stay green.
    const shared = readFileSync(join(COMPONENTS, SHARED), "utf8");
    const seamBackgrounds = [...shared.matchAll(/background:\s*"var\(--([a-z0-9-]+)\)"/g)].map(
      (m) => m[1],
    );
    expect(
      seamBackgrounds.filter((token) => token === "accent").length,
      "the shared seam rule no longer paints the accent",
    ).toBeGreaterThan(0);
    expect(
      seamBackgrounds.filter((token) => token === "danger").length,
      "the danger tone grew its own seam rule; the seam is one idiom",
    ).toBe(0);
  });

  it("colours the heading for the danger tone and leaves the rule the accent", () => {
    // The requester's own ask: the danger heading keeps its red so the warning
    // reads at the heading again, while the seam stays the accent every other
    // section draws.
    const danger = render(
      <SettingsSection title="Danger zone" tone="danger">
        body
      </SettingsSection>,
    );
    const dangerHeading = danger.container.querySelector("h3") as HTMLElement;
    const dangerRule = danger.container.querySelector('span[aria-hidden="true"]') as HTMLElement;
    expect(dangerHeading.style.color).toBe("var(--danger)");
    expect(dangerRule.style.background).toBe("var(--accent)");
    cleanup();

    const plain = render(<SettingsSection title="Vault">body</SettingsSection>);
    expect((plain.container.querySelector("h3") as HTMLElement).style.color).toBe("var(--accent)");
    cleanup();
  });

  it("the detector names a hand-rolled treatment when one is present", () => {
    // Proves the rule fires, so the green run above is about the tree rather
    // than about a regex that matches nothing.
    const handRolled = [
      "const GROUP_HEADING_STYLE = { textTransform: \"uppercase\", letterSpacing: \"0.06em\" };",
      "const RULE_STYLE = { flex: \"1 1 auto\", height: 1, background: \"var(--line-1)\" };",
    ].join("\n");
    expect(declaresSectionTreatment(handRolled)).toBe(true);
    // ...and each half alone is not a treatment.
    expect(
      declaresSectionTreatment("const X = { textTransform: \"uppercase\", letterSpacing: \"0.06em\" };"),
    ).toBe(false);
    expect(
      declaresSectionTreatment("const X = { height: 1, background: \"var(--line-1)\" };"),
    ).toBe(false);
  });
});

// A topic whose body is one section has its name twice, the tab and the heading,
// with a seam that separates the topic from nothing (myne-md/myne#885 visual
// pass). Driven through the counter itself so all three directions are checked:
// alone hides, two show, and no topic (a single-screen panel) shows.
describe("a section alone in its topic draws no heading", () => {
  it("hides the heading and rule when it is the topic's only section", () => {
    const { container } = render(
      <SettingsSectionCounter>
        <SettingsSection title="Tasks">body</SettingsSection>
      </SettingsSectionCounter>,
    );
    expect(container.querySelector("h3")).toBeNull();
    const section = container.querySelector("section") as HTMLElement;
    // Still a named group for assistive technology.
    expect(section.getAttribute("aria-label")).toBe("Tasks");
    expect(section.textContent).toBe("body");
    cleanup();
  });

  it("keeps both headings when the topic holds two sections", () => {
    const { container } = render(
      <SettingsSectionCounter>
        <SettingsSection title="One">a</SettingsSection>
        <SettingsSection title="Two">b</SettingsSection>
      </SettingsSectionCounter>,
    );
    expect([...container.querySelectorAll("h3")].map((h) => h.textContent)).toEqual([
      "One",
      "Two",
    ]);
    cleanup();
  });

  it("keeps the heading outside a topic, where nothing names the section", () => {
    const { container } = render(<SettingsSection title="Version">x</SettingsSection>);
    expect(container.querySelector("h3")?.textContent).toBe("Version");
    cleanup();
  });
});
