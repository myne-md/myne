// @vitest-environment jsdom
//
// The two by-design walls (task 40) and the reload expectation (task 42).
//
// Both are copy surfaces, so what is worth asserting is not that they render —
// it is the three things each criterion actually asks for: that the REASON is
// present and not just the restriction, that the handoff exists, and (for the
// reload note) that it is shown once and never nags.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

const openUrl = vi.fn();
vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl: (u: string) => openUrl(u) }));

import { NATIVE_DOWNLOAD_URL, WebNoAccount } from "../../src/screens/WebNoAccount";
import { RELOAD_NOTICE_KEY, WebReloadNotice } from "../../src/components/WebReloadNotice";

/**
 * This jsdom environment provides NO `localStorage` (the harness reported it as
 * unavailable), which is itself worth knowing: the component has to survive a
 * browser where it is missing or denied, and it does — every access is guarded.
 * The tests that are about persistence install a minimal in-memory stand-in;
 * the last one removes it again on purpose.
 */
function installStorage(): void {
  const map = new Map<string, string>();
  Object.defineProperty(window, "localStorage", {
    configurable: true,
    value: {
      getItem: (k: string) => map.get(k) ?? null,
      setItem: (k: string, v: string) => void map.set(k, v),
      removeItem: (k: string) => void map.delete(k),
      clear: () => map.clear(),
    },
  });
}

beforeEach(() => {
  openUrl.mockReset();
  installStorage();
});

afterEach(() => {
  cleanup();
});

describe("no-account / no-sync walls", () => {
  it("both states render, and each states a REASON rather than only the restriction", () => {
    for (const wall of ["no-account", "no-sync"] as const) {
      cleanup();
      render(<WebNoAccount wall={wall} />);
      // One selector, and the VARIANT read off a discriminator attribute (task
      // 100) — the shape `src/CLAUDE.md` asks for, and the shape that lets the
      // testid guard reject an interpolated `data-*` on a pre-unlock screen.
      const body = screen.getByTestId("web.wall");
      expect(body.getAttribute("data-wall")).toBe(wall);
      expect(body.textContent?.length ?? 0).toBeGreaterThan(20);

      // The reason paragraph is what turns a dead end into a boundary. Asserted
      // by its content, not its presence: a second empty <p> would pass a
      // presence check.
      const card = body.parentElement as HTMLElement;
      const paragraphs = [...card.querySelectorAll("p")].map((p) => p.textContent ?? "");
      expect(paragraphs.length).toBeGreaterThanOrEqual(2);
      expect(paragraphs[1].length).toBeGreaterThan(40);
    }
  });

  it("the no-account reason names the phrase, which is WHY the browser refuses", () => {
    render(<WebNoAccount wall="no-account" />);
    // Not decorative: the restriction is only defensible because creation shows
    // the recovery phrase, and a user who is not told that reads the wall as
    // arbitrary.
    expect(document.body.textContent).toContain("recovery phrase");
  });

  it("the no-sync reason says the browser keeps no vault of its own", () => {
    render(<WebNoAccount wall="no-sync" />);
    expect(document.body.textContent).toContain("no vault of its own");
  });

  it("hands off to the native clients", () => {
    render(<WebNoAccount wall="no-account" />);
    fireEvent.click(screen.getByTestId("web.wall.native-link"));
    expect(openUrl).toHaveBeenCalledWith(NATIVE_DOWNLOAD_URL);
  });
});

describe("reload expectation notice", () => {
  it("appears for a browser that has not seen it", () => {
    render(<WebReloadNotice />);
    expect(screen.getByTestId("web.reload-notice")).toBeTruthy();
  });

  it("implies no faster path — no 'for now', no 'soon'", () => {
    render(<WebReloadNotice />);
    const text = (screen.getByTestId("web.reload-notice").textContent ?? "").toLowerCase();
    // Quick-unlock on web is unscheduled (MYND-578). Any of these words would
    // make this release promise something it does not.
    for (const hint of ["for now", "soon", "yet", "temporar"]) {
      expect(text).not.toContain(hint);
    }
  });

  it("does not nag: dismissed once, gone for this browser", () => {
    const first = render(<WebReloadNotice />);
    fireEvent.click(screen.getByTestId("web.reload-notice.dismiss"));
    expect(screen.queryByTestId("web.reload-notice")).toBeNull();
    expect(window.localStorage.getItem(RELOAD_NOTICE_KEY)).toBe("1");

    // A fresh mount is the next session; it must stay gone.
    first.unmount();
    render(<WebReloadNotice />);
    expect(screen.queryByTestId("web.reload-notice")).toBeNull();
  });

  it("shows up when storage is denied rather than disappearing silently", () => {
    // A private window can throw on `localStorage`, and some environments do not
    // define it at all — this one does not, which is how the guard got tested
    // for real. Showing the note twice is a far smaller cost than never showing
    // it, so any storage failure reads as "not seen".
    Object.defineProperty(window, "localStorage", { configurable: true, value: undefined });
    render(<WebReloadNotice />);
    expect(screen.getByTestId("web.reload-notice")).toBeTruthy();

    // And dismissing still works — the write failure must not swallow the click.
    fireEvent.click(screen.getByTestId("web.reload-notice.dismiss"));
    expect(screen.queryByTestId("web.reload-notice")).toBeNull();
  });
});
