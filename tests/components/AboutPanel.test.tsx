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

// The update row's two seams (myne-md/myne#1020): what a check answers, and the
// flush that has to land before the process is allowed to exit into an install.
// Mutable so each case drives its own arm.
const updateSeam = vi.hoisted(() => ({
  /** What the next manual check reports. */
  answer: { kind: "available", version: "0.13.0", notes: "Fixes a crash." } as
    | { kind: "available"; version: string; notes: string }
    | { kind: "up-to-date" },
  /** True when an open pane refuses to save, which must stop the install. */
  flushShouldReject: false,
  updateCheck: vi.fn(),
  updateInstall: vi.fn(),
  flushOpenPanes: vi.fn(),
}));
vi.mock("../../src/platform/update", () => ({
  updateCheck: updateSeam.updateCheck,
  updateInstall: updateSeam.updateInstall,
  getAutoCheck: () => Promise.resolve(true),
  setAutoCheck: () => Promise.resolve(),
  UPDATE_PROGRESS_EVENT: "update:progress",
}));
vi.mock("../../src/notes/renameFlushHook", () => ({
  renameFlushHooks: () => ({ flushOpenPanes: updateSeam.flushOpenPanes }),
}));

import { AboutPanel } from "../../src/components/settings/AboutPanel";

beforeEach(() => {
  localAiCapable = true;
  developerMode = false;
  language = "en";
  servedBuild.value = null;
  setDeveloperMode.mockClear();
  openUrl.mockClear();
  updateSeam.answer = { kind: "available", version: "0.13.0", notes: "Fixes a crash." };
  updateSeam.flushShouldReject = false;
  updateSeam.updateCheck.mockReset();
  updateSeam.updateInstall.mockReset();
  updateSeam.flushOpenPanes.mockReset();
  updateSeam.updateCheck.mockImplementation(() => Promise.resolve(updateSeam.answer));
  updateSeam.updateInstall.mockImplementation(() => Promise.resolve());
  updateSeam.flushOpenPanes.mockImplementation(() =>
    updateSeam.flushShouldReject
      ? Promise.reject(new Error("no"))
      : Promise.resolve(),
  );
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

describe("AboutPanel — legal document links (myne-ops#15)", () => {
  it("offers the privacy policy and nothing about the closed offering", () => {
    // One document. Terms, the DSA notice route and the law-enforcement page
    // described a service Myne was offering publicly, and it offers none
    // (`docs/decisions/sync/0696`). The absence assertions are the half that
    // fails if a row is added back without a decision.
    render(<AboutPanel />);
    expect(screen.getByTestId("about.legal-privacy")).toBeTruthy();
    for (const gone of [
      "about.legal-terms",
      "about.legal-notice",
      "about.legal-law-enforcement",
    ]) {
      expect(screen.queryByTestId(gone)).toBeNull();
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
    fireEvent.click(screen.getByTestId("about.legal-privacy"));
    expect(openUrl).toHaveBeenCalledWith("https://myne.md/datenschutz/");
  });

  it("treats a regional German tag as German", () => {
    language = "de-DE";
    render(<AboutPanel />);
    fireEvent.click(screen.getByTestId("about.legal-privacy"));
    expect(openUrl).toHaveBeenCalledWith("https://myne.md/datenschutz/");
  });

  it("falls back to English for a language with no edition of its own", () => {
    language = "tr";
    render(<AboutPanel />);
    fireEvent.click(screen.getByTestId("about.legal-privacy"));
    expect(openUrl).toHaveBeenCalledWith("https://myne.md/privacy/");
  });

  it("does not link the Impressum while its address is unpublished", () => {
    // myne-ops#9: the page exists and `legalUrl` can produce it, but an
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

describe("AboutPanel — the update row is one button (myne-md/myne#1020)", () => {
  // The row used to hold the check in its control slot and grow a SECOND primary
  // button underneath once a version was offered. The owner asked for one control
  // that becomes the install, and the reason it is worth a test is that the two
  // shapes render the same row: only an assertion on which button survives a
  // check distinguishes them, and the row's height not moving is the whole point
  // of the change.

  it("starts as the check, with no install affordance anywhere in the row", () => {
    render(<AboutPanel />);
    expect(screen.getByTestId("about.update-check")).toBeTruthy();
    expect(screen.queryByTestId("about.update-install")).toBeNull();
  });

  it("turns into the install in place when a check finds a version", async () => {
    render(<AboutPanel />);
    fireEvent.click(screen.getByTestId("about.update-check"));
    const install = await screen.findByTestId("about.update-install");
    // The check is GONE, not merely accompanied: a row holding both is the shape
    // the owner rejected.
    expect(screen.queryByTestId("about.update-check")).toBeNull();
    expect(install.textContent).toBe("settings.about.updateInstallButton");
  });

  it("stays the check when there is nothing to install", async () => {
    updateSeam.answer = { kind: "up-to-date" };
    render(<AboutPanel />);
    fireEvent.click(screen.getByTestId("about.update-check"));
    await act(async () => {
      await Promise.resolve();
    });
    expect(screen.getByTestId("about.update-check")).toBeTruthy();
    expect(screen.queryByTestId("about.update-install")).toBeNull();
  });

  it("flushes the open panes before installing", async () => {
    render(<AboutPanel />);
    fireEvent.click(screen.getByTestId("about.update-check"));
    fireEvent.click(await screen.findByTestId("about.update-install"));
    await act(async () => {
      await Promise.resolve();
    });
    expect(updateSeam.flushOpenPanes).toHaveBeenCalledTimes(1);
    expect(updateSeam.updateInstall).toHaveBeenCalledTimes(1);
  });

  it("does not exit into an install when a pane refuses to save, and says so on the row", async () => {
    updateSeam.flushShouldReject = true;
    render(<AboutPanel />);
    fireEvent.click(screen.getByTestId("about.update-check"));
    fireEvent.click(await screen.findByTestId("about.update-install"));
    await act(async () => {
      await Promise.resolve();
    });
    // The install exits the process. Refused flush, refused exit: the edits are
    // still only in memory and a restart would take them with it.
    expect(updateSeam.updateInstall).not.toHaveBeenCalled();
    expect(screen.getByTestId("about.update-blocked")).toBeTruthy();
    // The button stays pressable, so the retry after saving is the same button.
    expect(screen.getByTestId("about.update-install")).toBeTruthy();
  });

  it("clears the refusal once a press gets through", async () => {
    updateSeam.flushShouldReject = true;
    render(<AboutPanel />);
    fireEvent.click(screen.getByTestId("about.update-check"));
    fireEvent.click(await screen.findByTestId("about.update-install"));
    await act(async () => {
      await Promise.resolve();
    });
    expect(screen.getByTestId("about.update-blocked")).toBeTruthy();

    updateSeam.flushShouldReject = false;
    fireEvent.click(screen.getByTestId("about.update-install"));
    await act(async () => {
      await Promise.resolve();
    });
    expect(screen.queryByTestId("about.update-blocked")).toBeNull();
    expect(updateSeam.updateInstall).toHaveBeenCalledTimes(1);
  });
});
