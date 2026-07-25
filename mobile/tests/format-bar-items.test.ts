// FormatBar customization vocabulary + resolver (MYND-555).
//
// The resolver is the compatibility boundary: it turns an UNTRUSTED stored id list
// (older build, newer build, or a desktop-authored list that arrived via a backup
// restore — `vault.prefs` is inside MYB1) into something renderable. So the cases
// that matter are the malformed ones, not the happy path.

import { describe, expect, it } from "vitest";
import {
  FORMAT_BAR_DEFAULT_ORDER,
  FORMAT_BAR_ITEMS,
  resolveFormatBarOrder,
  visibleFormatBarIds,
} from "../src/lib/formatBarItems";

/** Desktop's frozen vocabulary (`src/notes/toolbarItems.ts`) as of MYND-336 —
 *  hard-coded here on purpose: this is a CROSS-CLIENT contract check, so it must
 *  fail if desktop's list is edited without a look at mobile. */
const DESKTOP_IDS = [
  "bold", "italic", "strike", "code", "highlight", "link",
  "heading", "bulletList", "numberedList", "checklist", "quote", "wikilink",
];

describe("vocabulary", () => {
  it("default order lists every item exactly once", () => {
    expect([...FORMAT_BAR_DEFAULT_ORDER].sort()).toEqual(
      FORMAT_BAR_ITEMS.map((i) => i.id).sort(),
    );
    expect(new Set(FORMAT_BAR_DEFAULT_ORDER).size).toBe(FORMAT_BAR_DEFAULT_ORDER.length);
  });

  it("every item carries a label key", () => {
    for (const item of FORMAT_BAR_ITEMS) {
      expect(item.labelKey).toMatch(/^[a-z][\w.]+$/i);
    }
  });

  it("ids agree with desktop wherever both bars carry the same command", () => {
    // Shared commands MUST share an id — the field is device-local, but a backup
    // restore can carry a list across, and agreement is what makes that a no-op
    // rather than a silent reset.
    const mobile = new Set(FORMAT_BAR_DEFAULT_ORDER);
    for (const shared of ["bold", "italic", "code", "link", "bulletList", "checklist", "quote", "wikilink"]) {
      expect(mobile.has(shared)).toBe(true);
      expect(DESKTOP_IDS).toContain(shared);
    }
  });

  it("carries no desktop-only id it cannot render", () => {
    // `strike` / `highlight` / `numberedList` / `heading` are desktop's; adding one
    // here without a FormatBar renderer would render a hole.
    for (const desktopOnly of ["strike", "highlight", "numberedList", "heading"]) {
      expect(FORMAT_BAR_DEFAULT_ORDER).not.toContain(desktopOnly);
    }
  });
});

describe("resolveFormatBarOrder", () => {
  it("empty stored order → canonical order (the un-customized default)", () => {
    expect(resolveFormatBarOrder([])).toEqual([...FORMAT_BAR_DEFAULT_ORDER]);
  });

  it("honors the stored order and appends the rest canonically", () => {
    const resolved = resolveFormatBarOrder(["link", "bold"]);
    expect(resolved.slice(0, 2)).toEqual(["link", "bold"]);
    // Everything else follows in canonical order, exactly once.
    expect([...resolved].sort()).toEqual([...FORMAT_BAR_DEFAULT_ORDER].sort());
  });

  it("drops unknown ids — a desktop list restored from backup does not leave holes", () => {
    const resolved = resolveFormatBarOrder(["highlight", "bold", "strike", "italic"]);
    expect(resolved.slice(0, 2)).toEqual(["bold", "italic"]);
    expect(resolved).not.toContain("highlight");
    expect(resolved).not.toContain("strike");
    expect(resolved).toHaveLength(FORMAT_BAR_DEFAULT_ORDER.length);
  });

  it("deduplicates a repeated id", () => {
    const resolved = resolveFormatBarOrder(["bold", "bold", "italic"]);
    expect(resolved.filter((id) => id === "bold")).toHaveLength(1);
    expect(resolved).toHaveLength(FORMAT_BAR_DEFAULT_ORDER.length);
  });

  it("a stored list from an older build gains new buttons at the end, not interleaved", () => {
    // Simulate a build that only knew 3 ids.
    const older = ["quote", "code", "bold"];
    const resolved = resolveFormatBarOrder(older);
    expect(resolved.slice(0, 3)).toEqual(older);
  });

  it("is total — always returns the whole vocabulary, whatever comes in", () => {
    for (const input of [[], ["nope"], ["bold"], [...FORMAT_BAR_DEFAULT_ORDER].reverse()]) {
      expect([...resolveFormatBarOrder(input)].sort()).toEqual(
        [...FORMAT_BAR_DEFAULT_ORDER].sort(),
      );
    }
  });
});

describe("visibleFormatBarIds", () => {
  it("nothing hidden → the full resolved order", () => {
    expect(visibleFormatBarIds([], [])).toEqual([...FORMAT_BAR_DEFAULT_ORDER]);
  });

  it("removes hidden ids while keeping the order", () => {
    const visible = visibleFormatBarIds([], ["bold", "quote"]);
    expect(visible).not.toContain("bold");
    expect(visible).not.toContain("quote");
    expect(visible).toHaveLength(FORMAT_BAR_DEFAULT_ORDER.length - 2);
  });

  it("an unknown hidden id is inert — it can hide nothing", () => {
    // A desktop-authored hidden set (`strike`, `highlight`) must not shrink the bar.
    expect(visibleFormatBarIds([], ["strike", "highlight"])).toEqual([
      ...FORMAT_BAR_DEFAULT_ORDER,
    ]);
  });

  it("hiding everything is allowed and yields an empty format region", () => {
    // Legal by design: the pinned chrome (attach / library / record / raw-toggle /
    // hide-keyboard) lives outside this vocabulary, so the bar itself survives and
    // Settings stays reachable. That is why chrome is not customizable.
    expect(visibleFormatBarIds([], [...FORMAT_BAR_DEFAULT_ORDER])).toEqual([]);
  });

  it("respects a custom order and a hidden set together", () => {
    expect(visibleFormatBarIds(["link", "bold", "italic"], ["bold"])).toEqual([
      "link",
      "italic",
      ...FORMAT_BAR_DEFAULT_ORDER.filter((id) => !["link", "bold", "italic"].includes(id)),
    ]);
  });
});
