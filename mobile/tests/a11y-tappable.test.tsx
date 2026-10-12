// @vitest-environment jsdom
//
// Mobile's tappable rows are real controls (myne-md/myne#728, task 16).
//
// The flows were built from `<div onClick=…>`. On a touchscreen that works
// perfectly, which is exactly why it survived every hand-test: the row is
// tappable and looks tappable. To VoiceOver and TalkBack it is a piece of
// text: not announced as actionable, unresponsive to the activation gesture,
// and unreachable by an external keyboard, so the flow ends at the first row.
//
// Two tiers here. The `tappable` helper's own behaviour, and a SWEEP over
// `mobile/src/app` for any clickable element that still carries no role, with
// a reasoned exemption list compared both ways. The sweep is the half that
// matters over time: twenty sites were fixed and the twenty-first will be
// written by someone who has not read this file.

import { afterEach, describe, expect, it, vi } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { tappable } from "../src/app/a11y/tappable";

afterEach(cleanup);

describe("the tappable helper", () => {
  it("makes a div announce and behave as a button", () => {
    const onActivate = vi.fn();
    render(
      <div {...tappable({ onActivate })} data-testid="row">
        A note
      </div>,
    );
    const row = screen.getByTestId("row");
    expect(row.getAttribute("role")).toBe("button");
    expect(row.getAttribute("tabindex")).toBe("0");
    // The name comes from CONTENTS. An `aria-label` here would replace the
    // row's own text, which is usually richer.
    expect(screen.getByRole("button", { name: "A note" })).toBe(row);
  });

  it("answers Enter and Space", () => {
    const onActivate = vi.fn();
    render(<div {...tappable({ onActivate })} data-testid="row" />);
    const row = screen.getByTestId("row");
    fireEvent.keyDown(row, { key: "Enter" });
    fireEvent.keyDown(row, { key: " " });
    expect(onActivate).toHaveBeenCalledTimes(2);
  });

  it("swallows Space's default, which would scroll the list", () => {
    // A real <button> gets this from the browser; a div with role=button does
    // not, so without it the row activates AND the page jumps a screen.
    render(<div {...tappable({ onActivate: vi.fn() })} data-testid="row" />);
    const scrolled = fireEvent.keyDown(screen.getByTestId("row"), { key: " " });
    expect(scrolled).toBe(false);
  });

  it("ignores every other key", () => {
    const onActivate = vi.fn();
    render(<div {...tappable({ onActivate })} data-testid="row" />);
    for (const key of ["a", "Tab", "ArrowDown", "Escape"]) {
      fireEvent.keyDown(screen.getByTestId("row"), { key });
    }
    expect(onActivate).not.toHaveBeenCalled();
  });

  it("is NOT a control when there is nothing to activate", () => {
    // A static settings row must not announce a button that does nothing.
    expect(tappable({ onActivate: undefined })).toBeNull();
  });

  it("labels only when asked, for the icon-only case", () => {
    expect(tappable({ onActivate: vi.fn() })?.["aria-label"]).toBeUndefined();
    expect(tappable({ onActivate: vi.fn(), label: "Preview" })?.["aria-label"]).toBe(
      "Preview",
    );
  });

  it("reports pressed and expanded state when given", () => {
    // `aria-selected` is not valid on a button, so a chosen row is `pressed`;
    // a disclosure row is `expanded`. Both are states a screen reader has no
    // other way to learn: the app draws them as colour and a CSS rotation.
    expect(tappable({ onActivate: vi.fn(), pressed: true })?.["aria-pressed"]).toBe(true);
    expect(tappable({ onActivate: vi.fn(), expanded: false })?.["aria-expanded"]).toBe(
      false,
    );
    expect(tappable({ onActivate: vi.fn() })?.["aria-pressed"]).toBeUndefined();
  });
});

// ── the sweep ────────────────────────────────────────────────────────────

/**
 * Clickable elements that are deliberately NOT controls, with the reason.
 * Keyed by file, because a line number goes stale on the next edit.
 */
const NOT_CONTROLS: Record<string, string> = {
  "mobile/src/app/flows/AiHistorySheet.tsx":
    "The row div keeps a plain onClick as a touch convenience; the CONTROL is its title button, because the row also contains the three-dot trigger whose menu holds Rename and Delete, a control inside a control is nested-interactive and would swallow those labels into the row's name (myne-md/myne#848). Same split as ViewsSheet and the note row.",

  "mobile/src/app/flows/editor/sheets/ViewsSheet.tsx":
    "The row div keeps a plain onClick as a touch convenience; the CONTROL is its text block, because the row also contains an Edit button and a control inside a control is nested-interactive. Same split as the note row.",
  "mobile/src/app/flows/CreateVaultFlow.tsx":
    "Two acknowledgement sentences beside a real `aria-pressed` button holding the checkbox glyph. The sentence is the button's accessible name (aria-labelledby) and stays clickable as a touch convenience; making it a SECOND control would announce the same toggle twice.",
  "mobile/src/app/flows/IdentityFlow.tsx":
    "Same shape as CreateVaultFlow's AckRow: the phrase and forget acknowledgements are sentences beside a real `aria-pressed` button holding the checkbox glyph (its `AckRow`). The sentence is the button's accessible name (aria-labelledby) and stays clickable as a touch convenience; a second control would announce the same toggle twice.",
};

/**
 * Both trees, and the second one is the point. The first version walked
 * `src/app` alone, which left the SHARED row primitives in `src/components`
 * outside the denominator while the flows rendered them: `ListRow` (the vault
 * picker's rows), the sync settings rows and the MarkdownView wikilink were
 * all unfixed and the sweep printed clean over them. A denominator blind to
 * the tree that holds the reusable rows is the `check-prefs-nonce.mjs` blind
 * spot the root AGENTS.md records.
 */
const SCAN_ROOTS = ["src/app", "src/components"] as const;

function tsxUnder(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) tsxUnder(full, out);
    else if (full.endsWith(".tsx")) out.push(full);
  }
  return out;
}

/** Opening tags of div/span/li that carry an onClick, with their file. */
function clickableTags(): Array<{ file: string; tag: string }> {
  const found: Array<{ file: string; tag: string }> = [];
  for (const file of SCAN_ROOTS.flatMap((root) => tsxUnder(root))) {
    const src = readFileSync(file, "utf8");
    for (const m of src.matchAll(/<(div|span|li)\b/g)) {
      const start = m.index ?? 0;
      let depth = 0;
      let end = -1;
      for (let i = start; i < Math.min(src.length, start + 3000); i++) {
        const c = src[i];
        if (c === "{") depth++;
        else if (c === "}") depth--;
        else if (c === ">" && depth === 0) {
          end = i;
          break;
        }
      }
      if (end === -1) continue;
      const tag = src.slice(start, end + 1);
      // `tappable(...)` counts as clickable too: the fixed sites no longer
      // spell `onClick` in the tag, and counting only the unfixed ones would
      // shrink the denominator every time this pass succeeded, which is how a
      // non-vacuity floor comes to guard nothing.
      if (tag.includes("onClick") || tag.includes("tappable(")) {
        found.push({ file: `mobile/${file}`, tag });
      }
    }
  }
  return found;
}

describe("a tappable does not also fire the row it sits in", () => {
  // The review of this pass found the defect this describes, and it is worse
  // than a double call. `useHold`'s `consumeHeldClick()` is ONE-SHOT: the
  // inner control consumed the flag and returned, the click bubbled to the
  // row, the row's own call saw `false`, and the note opened out from under
  // the action sheet the long-press had just opened. So the long-press guard
  // was defeated by the accessibility fix that introduced the inner control.

  function nested(onActivate: () => void, onRowClick: () => void) {
    return render(
      <div onClick={onRowClick} data-testid="row">
        <div {...tappable({ onActivate })} data-testid="inner">
          A note
        </div>
      </div>,
    );
  }

  it("a tap on the control runs the control, not the row", () => {
    const onActivate = vi.fn();
    const onRowClick = vi.fn();
    nested(onActivate, onRowClick);
    fireEvent.click(screen.getByTestId("inner"));
    expect(onActivate).toHaveBeenCalledTimes(1);
    expect(onRowClick).not.toHaveBeenCalled();
  });

  it("Enter and Space on the control do not reach the row either", () => {
    for (const key of ["Enter", " "]) {
      const onActivate = vi.fn();
      const onRowClick = vi.fn();
      nested(onActivate, onRowClick);
      fireEvent.keyDown(screen.getByTestId("inner"), { key });
      expect(onActivate).toHaveBeenCalledTimes(1);
      expect(onRowClick).not.toHaveBeenCalled();
      cleanup();
    }
  });

  it("the row still handles a tap on its own padding", () => {
    // The outer handler is a touch convenience and must survive: a row is
    // wider than its text, and dead padding on a touch client is a
    // regression of its own.
    const onActivate = vi.fn();
    const onRowClick = vi.fn();
    nested(onActivate, onRowClick);
    fireEvent.click(screen.getByTestId("row"));
    expect(onRowClick).toHaveBeenCalledTimes(1);
    expect(onActivate).not.toHaveBeenCalled();
  });

  it("the one-shot held-click flag is consumed exactly once per tap", () => {
    // The shape of the real bug, with the real flag semantics: a counter that
    // returns true on its first call only. Two consumers means the second
    // sees false and acts.
    let held = true;
    const consumeHeldClick = (): boolean => {
      if (!held) return false;
      held = false;
      return true;
    };
    const opened = vi.fn();
    const open = (): void => {
      if (consumeHeldClick()) return; // this click was the long-press tail
      opened();
    };
    render(
      <div onClick={open} data-testid="row">
        <div {...tappable({ onActivate: open })} data-testid="inner">
          A note
        </div>
      </div>,
    );
    fireEvent.click(screen.getByTestId("inner"));
    expect(opened, "the long-press tail must not open the note").not.toHaveBeenCalled();
  });
});

describe("no clickable element in the mobile flows is left unannounced", () => {
  it("finds the clickables at all", () => {
    // Non-vacuity: a scan that stops matching reports a clean tree.
    expect(clickableTags().length).toBeGreaterThanOrEqual(15);
  });

  it("every clickable is a control, or is exempt with a reason", () => {
    const bare = clickableTags().filter(
      ({ tag }) => !tag.includes("role=") && !tag.includes("tappable("),
    );
    const unexplained = [...new Set(bare.map((b) => b.file))].filter(
      (f) => !(f in NOT_CONTROLS),
    );
    expect(
      unexplained,
      `Clickable but not announced as anything. Spread \`tappable({ onActivate })\`, or add the file to NOT_CONTROLS with the reason it is not a control.\n${unexplained.join("\n")}`,
    ).toEqual([]);
  });

  it("an exemption does not outlive its clickable", () => {
    const bare = new Set(
      clickableTags()
        .filter(({ tag }) => !tag.includes("role=") && !tag.includes("tappable("))
        .map((b) => b.file),
    );
    const stale = Object.keys(NOT_CONTROLS).filter((f) => !bare.has(f));
    expect(stale, stale.join("\n")).toEqual([]);
  });

  it("every exemption states why", () => {
    for (const [file, why] of Object.entries(NOT_CONTROLS)) {
      expect(why.length, file).toBeGreaterThan(60);
    }
  });

  it("no tappable row swallows a control", () => {
    // The rule the first version was missing, and it cost a real defect: the
    // note row was made a `role="button"` while CONTAINING the unstar button
    // and the trash list's Restore / Delete actions. That is the same
    // `nested-interactive` shape the desktop tab strip removed, and it
    // swallows those buttons' labels into the row's name. The sweep above
    // only asked whether every clickable IS a control; it never asked whether
    // one is inside another.
    //
    // Structural, deliberately: a JSX-shape scan cannot resolve `{actions}`
    // to the buttons a caller passes. It asserts the CHOICE instead, which is
    // the thing a reviewer has to make anyway: a `tappable` spread and a
    // `<button` in one file are only safe when they are siblings, so a file
    // with both is listed here with the reason.
    const BOTH_IS_FINE: Record<string, string> = {
      "mobile/src/app/flows/SnapshotsSheet.tsx":
        "The Restore button lives in the expanded preview block, which is a SIBLING of the tappable summary row rather than inside it.",
      "mobile/src/app/flows/editor/sheets/SortSheet.tsx":
        "The only button is the sheet header's Done; the tappable rows hold a check glyph and nothing else.",
      "mobile/src/app/flows/editor/sheets/VaultSwitcher.tsx":
        "Close, Create and Join are sheet-level buttons outside the vault rows; each row's tappable contains only its label and icon.",
      "mobile/src/app/flows/editor/sheets/ViewsSheet.tsx":
        "The Edit button is a SIBLING of the tappable text block, not a descendant. It was a descendant until this rule caught it, which is why the rule exists.",
      "mobile/src/components/SyncSettingsPanels.tsx":
        "The panel's action buttons sit outside its Row primitive; a Row that is given an onClick contains only its label and trailing text.",
      "mobile/src/app/flows/editor/chrome/NoteRow.tsx":
        "The tappable is the TEXT BLOCK; the unstar button and the `actions` node are its siblings, not its descendants. Making the row itself the control is the defect this rule exists to catch, and it was caught in review here.",
      "mobile/src/app/flows/AttachmentsSheet.tsx":
        "Same shape: the thumbnail and the filename block are each their own control, and the row's action buttons sit beside them rather than inside either.",
      "mobile/src/app/flows/SettingsSheet.tsx":
        "The Row primitive is a control only when it is given an onClick, and the rows that hold a Switch or a button are the ones that do not take one.",
      "mobile/src/app/flows/editor/sheets/FilterSheet.tsx":
        "The tappable rows carry an inline check glyph (an svg), never a control; the sheet's own buttons are outside the rows.",
    };
    const offenders: string[] = [];
    for (const root of SCAN_ROOTS) {
      for (const file of tsxUnder(root)) {
        const src = readFileSync(file, "utf8");
        if (!src.includes("tappable(")) continue;
        if (!/<button[\s>]/.test(src)) continue;
        const key = `mobile/${file}`;
        if (!(key in BOTH_IS_FINE)) offenders.push(key);
      }
    }
    expect(
      offenders,
      `This file spreads \`tappable\` AND renders a <button>. That is fine only when they are SIBLINGS: a control inside a control is nested-interactive, and the outer one's name swallows the inner one's label. Confirm the shape, then record it in BOTH_IS_FINE with the reason.\n${offenders.join("\n")}`,
    ).toEqual([]);

    // Both ways, so an entry cannot outlive the file it describes.
    const present = new Set(
      SCAN_ROOTS.flatMap((root) => tsxUnder(root))
        .filter((f) => {
          const src = readFileSync(f, "utf8");
          return src.includes("tappable(") && /<button[\s>]/.test(src);
        })
        .map((f) => `mobile/${f}`),
    );
    const stale = Object.keys(BOTH_IS_FINE).filter((f) => !present.has(f));
    expect(stale, stale.join("\n")).toEqual([]);
  });
});

describe("mobile state changes are announced", () => {
  // Audited rather than built: mobile already had these. The test is what
  // keeps a later refactor from quietly dropping the role and leaving a
  // silent toast.
  const LIVE_REGIONS: ReadonlyArray<[file: string, what: string]> = [
    ["src/components/ToastHost.tsx", "every transient message the app raises"],
    ["src/components/SyncBanners.tsx", "sync reconcile, staleness and integrity"],
    ["src/components/SnapshotFailedBanner.tsx", "a snapshot that did not capture"],
    ["src/app/flows/ShareImportToast.tsx", "a file arriving from the share sheet"],
    ["src/app/flows/CreateVaultFlow.tsx", "the copy / save-to-file result"],
  ];

  it.each(LIVE_REGIONS)("%s announces (%s)", (file) => {
    const src = readFileSync(file, "utf8");
    expect(src).toMatch(/role="(status|alert)"/);
  });
});
