// @vitest-environment jsdom
//
// The local store went away underneath a live session (phase3-web-client task
// 22).
//
// Every assertion here is about honesty rather than about layout, because every
// way this screen can be wrong is a way of misleading someone at the worst
// possible moment:
//
//   * calling an eviction a corruption sends them looking for a backup of
//     something that is intact on the server (criterion 1);
//   * omitting the unsynced notes lets a real loss pass as a routine hiccup
//     (criterion 3);
//   * offering an erase button on a client whose local copy IS the vault would
//     destroy the only copy;
//   * and not saying that re-enrolling lands the browser PENDING turns a routine
//     recovery into a user who believes they are locked out (criterion 5).

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

const capabilities = { localOnlyVault: false };
vi.mock("../../src/platform/capabilities", () => ({
  has: (cap: string) => (capabilities as Record<string, boolean>)[cap] ?? true,
}));

import { StorageLost, type StorageLostProps } from "../../src/screens/StorageLost";

function renderScreen(over: Partial<StorageLostProps> = {}) {
  const props: StorageLostProps = {
    kind: "evicted",
    unsyncedTitles: [],
    onReDownload: vi.fn(),
    onLock: vi.fn(),
    ...over,
  };
  return { props, ...render(<StorageLost {...props} />) };
}

afterEach(() => {
  capabilities.localOnlyVault = false;
  cleanup();
});

describe("storage lost", () => {
  it("names an eviction as an eviction, never as corruption", () => {
    renderScreen({ kind: "evicted" });
    const root = screen.getByTestId("storage-lost.root");
    expect(root.getAttribute("data-kind")).toBe("evicted");
    const text = root.textContent ?? "";
    // The word this screen must not use for this condition. Nothing is damaged;
    // the browser reclaimed space.
    expect(text).not.toMatch(/corrupt/i);
    // And it must say the server copy is intact, or the user has no way to know.
    expect(text).toMatch(/server/i);
  });

  it("distinguishes an unreadable container from an evicted one", () => {
    // Both are "the local copy is unusable" and they are NOT the same event: one
    // is the browser reclaiming space, the other is bytes that will not parse.
    // Task 18 falls back from a torn buffer to its sibling, so reaching
    // `unopenable` means BOTH failed — a state task 18 is silent about and this
    // task refuses to leave as a dead end.
    renderScreen({ kind: "unopenable" });
    expect(screen.getByTestId("storage-lost.root").getAttribute("data-kind")).toBe("unopenable");
  });

  it("says plainly when nothing was lost, instead of leaving a gap", () => {
    renderScreen({ unsyncedTitles: [] });
    expect(screen.getByTestId("storage-lost.all-synced")).toBeTruthy();
    expect(screen.queryByTestId("storage-lost.unsynced-list")).toBeNull();
  });

  it("lists the notes that never reached the server", () => {
    renderScreen({ unsyncedTitles: ["Draft letter", "Tuesday notes"] });
    const items = screen.getAllByTestId("storage-lost.unsynced-item");
    expect(items.map((n) => n.textContent)).toEqual(["Draft letter", "Tuesday notes"]);
    // And says they are GONE — not "pending", not "will sync later". They were
    // never on the server and their only copy was the store that vanished.
    const intro = screen.getByTestId("storage-lost.unsynced-intro").textContent ?? "";
    expect(intro).toMatch(/gone/i);
    expect(screen.queryByTestId("storage-lost.all-synced")).toBeNull();
  });

  it("summarises past a dozen instead of rendering a wall", () => {
    renderScreen({ unsyncedTitles: Array.from({ length: 20 }, (_, i) => `Note ${i}`) });
    expect(screen.getAllByTestId("storage-lost.unsynced-item")).toHaveLength(12);
    expect(screen.getByTestId("storage-lost.unsynced-overflow").textContent).toContain("8");
  });

  it("offers re-download where the vault is server-held, and says re-enrolling waits for approval", () => {
    const onReDownload = vi.fn();
    renderScreen({ onReDownload });
    // The notice comes BEFORE the button in the DOM, which is the order it has
    // to be read in: finding out about the pending gate afterwards is how a
    // routine recovery turns into a user who thinks they are locked out.
    const notice = screen.getByTestId("storage-lost.reenrol-notice");
    const cta = screen.getByTestId("storage-lost.redownload-cta");
    expect(notice.compareDocumentPosition(cta) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(notice.textContent).toMatch(/approval|approve/i);
    fireEvent.click(cta);
    expect(onReDownload).toHaveBeenCalledTimes(1);
  });

  it("offers NO erase on a client whose local copy is the vault", () => {
    // The load-bearing negative. On a local-only client the same storage fault
    // means the notes are simply gone, and an "erase and re-download" button
    // would destroy what is left in exchange for nothing.
    capabilities.localOnlyVault = true;
    const onLock = vi.fn();
    renderScreen({ onLock });
    expect(screen.queryByTestId("storage-lost.redownload-cta")).toBeNull();
    expect(screen.queryByTestId("storage-lost.reenrol-notice")).toBeNull();
    fireEvent.click(screen.getByTestId("storage-lost.lock-cta"));
    expect(onLock).toHaveBeenCalledTimes(1);
  });

  it("announces itself to assistive tech — this is not a passive screen", () => {
    renderScreen();
    const root = screen.getByTestId("storage-lost.root");
    expect(root.getAttribute("role")).toBe("alert");
    expect(root.getAttribute("aria-live")).toBe("assertive");
  });
});
