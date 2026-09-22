// @vitest-environment jsdom
//
// Landmarks and the skip link (myne-md/myne#728, task 9; WCAG 2.4.1).
//
// The skip link is the piece with a real ordering constraint, and it is not a
// matter of taste: `ScreenCaptureEscape` must stay the FIRST focusable element
// on the page, because on Windows the window can be a black rectangle whose
// only way out is that control, and that is a data-loss path rather than only
// an accessibility one. So the test that matters here is the one that would
// fail if somebody put the skip link in front of it.
//
// The landmark half is asserted where it can be: `AttachmentsLibrary` renders
// inside the editor's centre column, and it used to be a second `<main>`. Two
// mains make "jump to main" ambiguous, and nothing in the tree reported it.

import { afterEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { SkipToContent } from "../../src/components/SkipToContent";
import { REGION_ATTR } from "../../src/lib/regions";

/**
 * Comments stripped before any source scan. Every one of these files EXPLAINS
 * the rule in prose right beside the code that follows it, so a scanner that
 * reads prose reports on prose: the first version of the attachments check
 * failed on the word `<main>` inside the comment saying it is no longer one.
 */
function code(path: string): string {
  return readFileSync(path, "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/.*$/gm, "$1")
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, "");
}

afterEach(() => {
  cleanup();
  document.body.innerHTML = "";
});

describe("the skip link", () => {
  it("is hidden until it takes focus, and then drawn", () => {
    render(<SkipToContent />);
    const link = screen.getByTestId("app.skip-to-content");
    // Clipped, NOT `display: none` / `visibility: hidden`: either of those
    // removes it from the accessibility tree and makes it unreachable by the
    // keyboard user it is for.
    expect(link.style.clipPath).toBe("inset(50%)");
    expect(link.style.display).not.toBe("none");
    expect(link.style.visibility).not.toBe("hidden");
    fireEvent.focus(link);
    expect(link.style.clipPath).toBe("none");
  });

  it("is in the Tab order rather than merely present", () => {
    render(<SkipToContent />);
    const link = screen.getByTestId("app.skip-to-content");
    // A <button> is focusable by default; an explicit -1 anywhere would make
    // the whole control unreachable while still rendering.
    expect(link.getAttribute("tabindex")).not.toBe("-1");
    expect(link.tagName).toBe("BUTTON");
  });

  it("moves focus into the editor region when activated", () => {
    // Deferred, like every other region entry: a synchronous move from inside
    // the click handler does not survive the button's own blur and re-render.
    // The real-render run is what found that (AK-4 timed out on the landing
    // with the ordering green), so the timers are advanced here rather than
    // the deferral being asserted away.
    vi.useFakeTimers();
    document.body.insertAdjacentHTML(
      "beforeend",
      `<div ${REGION_ATTR}="editor"><div class="cm-content" contenteditable="true" id="body"></div></div>`,
    );
    render(<SkipToContent />);
    fireEvent.click(screen.getByTestId("app.skip-to-content"));
    expect(document.activeElement?.id, "nothing has moved yet").not.toBe("body");
    vi.runAllTimers();
    expect(document.activeElement?.id).toBe("body");
    vi.useRealTimers();
  });

  it("targets the region, not a hard-coded element id", () => {
    // If it named an id, "skip to content" and F6's "focus the editor" would
    // be two definitions of the same place, free to drift apart.
    const source: string = code("src/components/SkipToContent.tsx");
    expect(source).toContain("enterRegion");
    expect(source).not.toMatch(/getElementById|querySelector\(/);
  });

  it("does nothing visible when there is no editor region to jump to", () => {
    vi.useFakeTimers();
    render(<SkipToContent />);
    const link = screen.getByTestId("app.skip-to-content");
    fireEvent.focus(link);
    expect(() => fireEvent.click(link)).not.toThrow();
    expect(() => vi.runAllTimers()).not.toThrow();
    // Un-drawn again rather than left hovering over the content.
    expect(link.style.clipPath).toBe("inset(50%)");
    vi.useRealTimers();
  });
});

// ── the ordering constraint, read from the source ────────────────────────
//
// Order is a property of `App.tsx`'s JSX, and rendering `App` in jsdom needs
// the whole stage machine plus its IPC doubles. The constraint is one line of
// that file, so it is asserted against the file: the capture escape must be
// mounted before the skip link, and both before the stage switch.

describe("the skip link is ordered after the capture escape", () => {
  const app: string = code("src/App.tsx");

  it("mounts ScreenCaptureEscape before SkipToContent", () => {
    const escape = app.indexOf("<ScreenCaptureEscape />");
    const skip = app.indexOf("<SkipToContent />");
    expect(escape, "ScreenCaptureEscape is not mounted").toBeGreaterThan(-1);
    expect(skip, "SkipToContent is not mounted").toBeGreaterThan(-1);
    expect(escape).toBeLessThan(skip);
  });

  it("keeps ScreenCaptureEscape unconditional", () => {
    // Its own header explains why: the three screens `Editor.tsx` returns
    // before `EditorChrome` mount no Settings, and one of them renders with
    // the vault locked and protection forced back on.
    const escape = app.indexOf("<ScreenCaptureEscape />");
    const line = app.slice(app.lastIndexOf("\n", escape), escape);
    expect(line.includes("&&")).toBe(false);
  });
});

describe("only one main per route", () => {
  it("the attachments library is not a second main", () => {
    // It renders INSIDE the editor's centre column, which carries `role=main`.
    const lib: string = code("src/components/attachments/AttachmentsLibrary.tsx");
    expect(lib).not.toMatch(/<main[\s>]/);
    expect(lib).not.toContain('role="main"');
  });

  it("the editor shell declares exactly one main and names its three landmarks", () => {
    const editor: string = code("src/screens/Editor.tsx");
    expect(editor.match(/role="main"/g) ?? []).toHaveLength(1);
    expect(editor).toContain('role={side === "left" ? "navigation" : "complementary"}');
    for (const key of [
      "editor.chrome.region.editor",
      "editor.chrome.region.sidebar",
      "editor.chrome.region.rightPanel",
    ]) {
      expect(editor, `${key} names its landmark`).toContain(key);
    }
  });
});

// Keeps `vi` imported in a file that otherwise only reads the DOM, so the
// linter and the reader agree about why it is here.
void vi;
