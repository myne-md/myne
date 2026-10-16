// @vitest-environment jsdom
//
// Component tests for `src/components/settings/AboutPanel.tsx`. Two focuses:
// the Developer mode toggle (developer-mode feature, MYND-593, task 6) — it
// reflects `prefs.developer_mode`, calls `setDeveloperMode` on click, and
// renders on every client including the web-shaped capability set, which used
// to hide it (#181) — and the build readout, which must show the SERVED
// commit where there is one and the compile-time define where there is not
// (myne-md/myne#458).

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";

const { openUrl } = vi.hoisted(() => ({
  openUrl: vi.fn(() => Promise.resolve()),
}));
vi.mock("@tauri-apps/plugin-opener", () => ({
  openUrl,
  openPath: vi.fn(),
  revealItemInDir: vi.fn(),
}));

// Mutable so the build-readout tests can drive both arms of the seam: `null` is
// desktop (no served bundle), a populated object is web. Every pre-existing case
// leaves it `null`, which is what the `beforeEach` reset restores.
const { servedBuild } = vi.hoisted(() => ({
  servedBuild: { value: null as { bundleHash: string; commit: string } | null },
}));
vi.mock("../../src/platform/build-info", () => ({
  servedBuildInfo: () => Promise.resolve(servedBuild.value),
}));

let localAiCapable = true;
vi.mock("../../src/platform/capabilities", () => ({
  has: (cap: string) => (cap === "localAi" ? localAiCapable : true),
}));

let developerMode = false;
const setDeveloperMode = vi.fn((next: boolean) => {
  developerMode = next;
  return Promise.resolve();
});
vi.mock("../../src/hooks/usePrefs", () => ({
  usePrefs: () => ({
    prefs: { developer_mode: developerMode },
    setDeveloperMode,
  }),
}));

// The interface language, which the legal links read to choose between the
// English and German editions of each document.
let language = "en";
vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key, i18n: { language } }),
}));

import { AboutPanel } from "../../src/components/settings/AboutPanel";

beforeEach(() => {
  localAiCapable = true;
  developerMode = false;
  language = "en";
  servedBuild.value = null;
  setDeveloperMode.mockClear();
  openUrl.mockClear();
});
afterEach(() => cleanup());

describe("AboutPanel — Developer mode toggle", () => {
  it("renders off by default, matching the device-local pref's false default", () => {
    render(<AboutPanel />);
    const toggle = screen.getByTestId("about.developer-mode-toggle");
    expect(toggle.getAttribute("aria-checked")).toBe("false");
  });

  it("reflects an already-enabled preference", () => {
    developerMode = true;
    render(<AboutPanel />);
    expect(
      screen.getByTestId("about.developer-mode-toggle").getAttribute("aria-checked"),
    ).toBe("true");
  });

  it("calls setDeveloperMode(true) when toggled on", () => {
    render(<AboutPanel />);
    fireEvent.click(screen.getByTestId("about.developer-mode-toggle"));
    expect(setDeveloperMode).toHaveBeenCalledWith(true);
  });

  it("calls setDeveloperMode(false) when toggled off", () => {
    developerMode = true;
    render(<AboutPanel />);
    fireEvent.click(screen.getByTestId("about.developer-mode-toggle"));
    expect(setDeveloperMode).toHaveBeenCalledWith(false);
  });

  it("still renders on a web-shaped capability set, where the Developer rail group is empty", () => {
    // The inverse of this used to hold: no `localAi` meant no toggle, on the
    // theory that a gate with nothing behind it should not be offered. #181
    // broke that theory — the mode now also hides settings inside core panels
    // (the Vim toggle), and those ship on every client. Withholding the switch
    // here would strand them, since `developer_mode` is device-local and so
    // cannot arrive by sync from a desktop that has one.
    localAiCapable = false;
    render(<AboutPanel />);
    expect(screen.getByTestId("about.developer-mode-toggle")).toBeTruthy();
  });

  it("is still operable on a web-shaped capability set", () => {
    localAiCapable = false;
    render(<AboutPanel />);
    fireEvent.click(screen.getByTestId("about.developer-mode-toggle"));
    expect(setDeveloperMode).toHaveBeenCalledWith(true);
  });
});

describe("AboutPanel — legal document links (operations#15)", () => {
  it("offers all four published documents", () => {
    render(<AboutPanel />);
    for (const id of [
      "about.legal-privacy",
      "about.legal-terms",
      "about.legal-notice",
      "about.legal-law-enforcement",
    ]) {
      expect(screen.getByTestId(id)).toBeTruthy();
    }
  });

  it("opens the English edition on a non-German interface", () => {
    render(<AboutPanel />);
    fireEvent.click(screen.getByTestId("about.legal-privacy"));
    expect(openUrl).toHaveBeenCalledWith("https://myne.md/privacy/");
  });

  it("opens the German edition on a German interface", () => {
    // Not a translation of the English page — a separate text at a separate
    // slug, and the binding one for a German reader.
    language = "de";
    render(<AboutPanel />);
    fireEvent.click(screen.getByTestId("about.legal-terms"));
    expect(openUrl).toHaveBeenCalledWith("https://myne.md/nutzungsbedingungen/");
  });

  it("treats a regional German tag as German", () => {
    language = "de-DE";
    render(<AboutPanel />);
    fireEvent.click(screen.getByTestId("about.legal-law-enforcement"));
    expect(openUrl).toHaveBeenCalledWith("https://myne.md/behoerdenanfragen/");
  });

  it("falls back to English for a language with no edition of its own", () => {
    language = "tr";
    render(<AboutPanel />);
    fireEvent.click(screen.getByTestId("about.legal-notice"));
    expect(openUrl).toHaveBeenCalledWith("https://myne.md/notice/");
  });

  it("does not link the Impressum while its address is unpublished", () => {
    // operations#9: the page exists and `legalUrl` can produce it, but an
    // incomplete Impressum is a worse position in Germany than none at all,
    // because it reads as compliant. This assertion is what makes the omission
    // deliberate rather than forgotten — it fails the day someone adds the row
    // without closing #9.
    render(<AboutPanel />);
    expect(screen.queryByTestId("about.legal-impressum")).toBeNull();
  });
});

describe("AboutPanel — build readout", () => {
  // myne-md/myne#458. The web config pins `__BUILD_COMMIT__`
  // to a literal so the bundle takes no commit from its build environment, and
  // the real commit arrives at runtime in `version.json`. These two cases are
  // what keep the panel honest about which of the two it is showing.

  it("shows the served commit, sliced, when a bundle identifies itself", async () => {
    servedBuild.value = {
      bundleHash: "sha256:1d8ccfeb4e673113ebc3f92da257c31a2fd62e70263af75387337f40832cad4d",
      commit: "fd8d23c1041351c196bdac274f956fe2fcaa8107",
    };
    render(<AboutPanel />);
    // The fetch is a promise the effect resolves, so the first paint carries the
    // define; await the element that only appears once it lands.
    await screen.findByTestId("about.bundle-hash");
    // Sliced to 9, matching what the desktop `--short=9` define renders, rather
    // than 40 hex characters across a settings row.
    expect(screen.getByTestId("about.build-commit").textContent).toBe("fd8d23c10");
  });

  it("falls back to the compile-time define where nothing is served", async () => {
    // Desktop: the seam answers `null` by construction, so the installer's own
    // identity is what the row shows. `vitest.config.ts` pins the define here.
    //
    // AWAITED, and that is the whole test. Asserting synchronously observes only
    // the FIRST paint, which carries the define whatever the seam is about to
    // resolve to, so the assertion passed under both arms of the branch it
    // claims to discriminate: populating a served bundle here left it green.
    // It is the only guard on the fallback the design rests on.
    render(<AboutPanel />);
    // Let the effect's promise settle, so what is asserted is the RESOLVED
    // `null` rather than the pre-effect render.
    await act(async () => {
      await Promise.resolve();
    });
    expect(screen.getByTestId("about.build-commit").textContent).toBe("test");
    expect(screen.queryByTestId("about.bundle-hash")).toBeNull();
  });
});

describe("AboutPanel — diagnostics report blocks (myne-md/myne#860)", () => {
  it("wraps the read-only preview rather than reusing the multi-line field shape", () => {
    render(<AboutPanel />);
    const preview = screen.getByTestId("about.diagnostic-block-preview");
    // The longest line in the block is a 64-hex bundle hash, which has no break
    // opportunity. `white-space: pre-wrap` plus `overflow-wrap: anywhere` is what
    // folds it inside the narrow dialog the panel supports. The multi-line field
    // shape's `resize` would be inert on a `<pre>`, so it is deliberately absent.
    expect(preview.style.whiteSpace).toBe("pre-wrap");
    expect(preview.style.overflowWrap).toBe("anywhere");
    expect(preview.style.resize).toBe("");
  });

  it("keeps the preview's settings-search anchor on the canon block root", () => {
    // The block moved from the local `Block` wrapper to `ControlBlock`, whose
    // anchor prop is `anchorId` rather than a raw `data-setting-anchor`. If that
    // prop were dropped the anchor would vanish and the scroll target would go
    // with it, while every other assertion here stayed green.
    render(<AboutPanel />);
    const preview = screen.getByTestId("about.diagnostic-block-preview");
    expect(preview.closest("[data-setting-anchor]")?.getAttribute("data-setting-anchor")).toBe(
      "about.diagnostic-report",
    );
  });
});
