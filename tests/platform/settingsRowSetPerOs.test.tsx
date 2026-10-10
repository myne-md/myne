// @vitest-environment jsdom
//
// "The Settings row set is identical on the three desktop OSes" — myne-md/myne#557,
// the `settings.panel.privacy` bullet, made machine-checkable.
//
// This retires a three-OS manual walk, and it retires it by CONSTRUCTION rather
// than by observation on three machines. The argument has two halves and both
// have to hold, because either alone is gameable:
//
// 1. **The descriptor cannot branch on the OS.** `src/platform/capabilities.ts`
//    answers `has()` from a frozen set with no runtime probe in it — that is the
//    whole point of the seam (a build-time constant, not an `await`). If a
//    descriptor started reading `navigator.platform`, every row gated on `has()`
//    would silently become per-OS and no other check in the tree would say so.
// 2. **No row's PRESENCE is gated on a platform predicate either.** A descriptor
//    with no branching proves nothing if a panel reaches around it and asks
//    `isMacPlatform()` itself. So the panel is rendered three times, once per
//    desktop `navigator.platform` value, and the rendered testid sets compared.
//
// The one platform-conditioned control in Settings is the Touch ID setup BUTTON
// (`QuickUnlockSettings.tsx`), and it is recorded here rather than excused: it
// is a control INSIDE a row that renders on every OS, offered only where a
// provider exists (Linux and Windows answer `HardwareUnavailable`). The row set
// is unchanged by it, which is exactly what the roster row claimed and nobody
// checked. A NEW platform gate that removed or added a row fails test 3 by name;
// a new platform CALL SITE anywhere under `src/components/settings/` fails test
// 2 by name, even in a panel this file never renders.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { readFileSync, existsSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const invokeMock = vi.fn();
vi.mock("../../src/platform/core", () => ({
  invoke: (...a: unknown[]) => invokeMock(...(a as [])),
}));

const { PrivacyPanel } = await import("../../src/components/settings/PrivacyPanel");

// `process.cwd()`, not `import.meta.url`: under the jsdom environment Vitest
// serves modules through its `/@fs/…` URL space, so a URL-derived path resolves
// to a directory that does not exist and every source scan below would fail by
// ENOENT rather than by finding. Vitest runs from the repo root.
const REPO_ROOT = process.cwd();

// ── 1. The descriptors carry no per-OS branching ────────────────────────────

/**
 * Tokens that would make a descriptor answer differently on two desktop OSes.
 *
 * Deliberately a plain source scan rather than a runtime probe: a runtime probe
 * can only observe the OS the test happens to run on, which is the very thing
 * this file exists to stop relying on.
 */
const OS_BRANCH_TOKENS: readonly string[] = [
  "navigator.platform",
  "navigator.userAgent",
  "userAgentData",
  "process.platform",
  "isMacPlatform",
  "@tauri-apps/plugin-os",
  "os.type(",
  "os.platform(",
];

/** Every `platform/capabilities.ts` in the tree, relative to the repo root. */
function descriptorFiles(): string[] {
  const roots = ["src", "web/src", "mobile/src"];
  const found: string[] = [];
  for (const root of roots) {
    const p = join(REPO_ROOT, root, "platform", "capabilities.ts");
    if (existsSync(p)) found.push(relative(REPO_ROOT, p));
  }
  return found;
}

/** Strip `//` and block comments so prose about platforms is not a finding. */
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
}

describe("capability descriptors do not branch on the OS", () => {
  it("finds the descriptors it claims to check", () => {
    const files = descriptorFiles();
    // A glob that silently matched nothing would report ok forever. Both
    // known descriptors are named so their disappearance is a failure here,
    // not a smaller walk.
    expect(files).toContain("src/platform/capabilities.ts");
    expect(files).toContain("web/src/platform/capabilities.ts");
  });

  it.each(descriptorFiles())("%s answers without consulting the OS", (rel) => {
    const code = stripComments(readFileSync(join(REPO_ROOT, rel), "utf8"));
    for (const token of OS_BRANCH_TOKENS) {
      expect(
        code.includes(token),
        `${rel} reaches for \`${token}\`. A capability descriptor is a ` +
          `build-time constant (see its own header); an OS probe here makes ` +
          `every row gated on has() silently per-OS.`,
      ).toBe(false);
    }
  });
});

// ── 2. The platform-predicate call sites under Settings are a closed roster ──

/**
 * Every `isMacPlatform` (or equivalent) call site allowed under
 * `src/components/settings/`, with the reason it is not a row gate.
 *
 * Compared in BOTH directions: an unrecorded call site fails, and a recorded
 * entry whose file no longer holds one fails as stale. A roster compared in one
 * direction is a roster that quietly stops describing anything.
 */
const SETTINGS_PLATFORM_CALL_SITES: ReadonlyArray<{ file: string; why: string }> = [
  {
    file: "src/components/settings/QuickUnlockSettings.tsx",
    why:
      "the Touch ID SETUP BUTTON, inside the quick-unlock row. macOS is the " +
      "only desktop OS with a provider; Linux and Windows answer " +
      "HardwareUnavailable. The row itself renders everywhere.",
  },
  {
    file: "src/components/settings/HotkeysPanel.tsx",
    why:
      "chord GLYPH rendering (Cmd/Opt/Shift/Ctrl against Ctrl/Alt/Shift). " +
      "Chooses how a binding is drawn, never whether its row exists.",
  },
  {
    file: "src/components/settings/MemberPasswordSettings.tsx",
    why:
      "the Touch ID BUTTON inside the shared-vault unlock row (decisions/protocol/0653). " +
      "macOS is the only desktop OS with a biometric provider; Linux and Windows " +
      "answer HardwareUnavailable. The row itself renders everywhere (it self-gates " +
      "on memberVaultStatus, not on the OS).",
  },
];

function settingsSources(): string[] {
  const dir = join(REPO_ROOT, "src/components/settings");
  const out: string[] = [];
  const walk = (d: string) => {
    for (const name of readdirSync(d)) {
      const p = join(d, name);
      if (statSync(p).isDirectory()) walk(p);
      else if (/\.tsx?$/.test(name)) out.push(relative(REPO_ROOT, p));
    }
  };
  walk(dir);
  return out;
}

describe("platform predicates under Settings are a closed, reasoned roster", () => {
  const PREDICATE = /\bisMacPlatform\s*\(|navigator\.platform|navigator\.userAgent/;

  it("every call site is recorded", () => {
    const unrecorded = settingsSources().filter((rel) => {
      if (SETTINGS_PLATFORM_CALL_SITES.some((e) => e.file === rel)) return false;
      return PREDICATE.test(stripComments(readFileSync(join(REPO_ROOT, rel), "utf8")));
    });
    expect(
      unrecorded,
      "a new platform predicate under src/components/settings/. If it decides " +
        "whether a ROW renders, the row set stops being identical across the " +
        "desktop OSes; if it only decides how a control is drawn, record it in " +
        "SETTINGS_PLATFORM_CALL_SITES with that reason.",
    ).toEqual([]);
  });

  it("no recorded entry has gone stale", () => {
    for (const entry of SETTINGS_PLATFORM_CALL_SITES) {
      const p = join(REPO_ROOT, entry.file);
      expect(existsSync(p), `${entry.file} is recorded but does not exist`).toBe(true);
      expect(
        PREDICATE.test(stripComments(readFileSync(p, "utf8"))),
        `${entry.file} is recorded as holding a platform predicate and no longer does`,
      ).toBe(true);
      expect(entry.why.length, `${entry.file} needs a stated reason`).toBeGreaterThan(30);
    }
  });
});

// ── 3. The rendered row set is identical on the three desktop OSes ──────────

/** `navigator.platform` as each desktop host reports it. */
const DESKTOP_PLATFORMS: ReadonlyArray<[label: string, value: string]> = [
  ["macOS", "MacIntel"],
  ["Windows", "Win32"],
  ["Linux", "Linux x86_64"],
];

function setPlatform(value: string) {
  Object.defineProperty(window.navigator, "platform", {
    value,
    configurable: true,
  });
}

function stubIpc(over: Record<string, () => Promise<unknown>> = {}) {
  invokeMock.mockImplementation((cmd: string) => {
    const o = over[cmd];
    if (o) return o();
    switch (cmd) {
      case "plugin:vault-label|hide_vault_names":
        return Promise.resolve({ hidden: false });
      case "plugin:vault-label|vault_label_keychain_status":
        return Promise.resolve({ available: true });
      case "plugin:prefs|prefs_read":
        return Promise.resolve({});
      case "plugin:quick-unlock|quick_unlock_status":
        // The backend answer is the SAME on every desktop OS: quick-unlock is
        // not configured. Anything per-OS in the render must therefore come
        // from the frontend, which is what this test is looking for.
        return Promise.resolve({ configured: false, method: null, available: true });
      default:
        return Promise.reject(new Error(`unstubbed command: ${cmd}`));
    }
  });
}

/** Every `data-testid` rendered by the panel, sorted. */
function renderedTestIds(container: HTMLElement): string[] {
  return Array.from(container.querySelectorAll("[data-testid]"))
    .map((el) => el.getAttribute("data-testid")!)
    .sort();
}

async function mountUnder(platform: string): Promise<HTMLElement> {
  setPlatform(platform);
  stubIpc();
  const { container } = render(<PrivacyPanel />);
  // The quick-unlock row resolves its status asynchronously; without waiting
  // the comparison would be between three EMPTY sets, which agree trivially.
  await screen.findByTestId("settings.quick-unlock-toggle");
  return container;
}

const ORIGINAL_PLATFORM = window.navigator.platform;

beforeEach(() => {
  invokeMock.mockReset();
});

afterEach(() => {
  cleanup();
  setPlatform(ORIGINAL_PLATFORM);
});

describe("the Privacy row set does not vary by desktop OS", () => {
  it("renders a non-trivial row set (the comparison has something in it)", async () => {
    const container = await mountUnder("Linux x86_64");
    const ids = renderedTestIds(container);
    // A floor, so three empty sets can never pass by agreeing.
    expect(ids.length).toBeGreaterThanOrEqual(3);
    expect(ids).toContain("settings.quick-unlock-toggle");
  });

  it.each(DESKTOP_PLATFORMS)(
    "%s renders the same testids as every other desktop OS",
    async (_label, value) => {
      const mine = renderedTestIds(await mountUnder(value));
      cleanup();
      const linux = renderedTestIds(await mountUnder("Linux x86_64"));
      expect(mine).toEqual(linux);
    },
  );

  it("the one platform-conditioned control is a BUTTON inside a row every OS renders", async () => {
    // Open the PIN setup, which is where the Touch ID button lives.
    const openSetup = async (platform: string) => {
      const container = await mountUnder(platform);
      fireEvent.click(screen.getByTestId("settings.quick-unlock-toggle"));
      await screen.findByTestId("settings.quick-unlock-setup-pin");
      return container;
    };

    const macIds = renderedTestIds(await openSetup("MacIntel"));
    cleanup();
    const winIds = renderedTestIds(await openSetup("Win32"));

    const macOnly = macIds.filter((id) => !winIds.includes(id));
    const winOnly = winIds.filter((id) => !macIds.includes(id));

    // Exactly one difference, and it is the recorded one.
    expect(macOnly).toEqual(["settings.quick-unlock-setup-biometric"]);
    expect(winOnly).toEqual([]);
    // …and the ROW that holds it is on both, which is the claim the roster
    // row made: the row SET is identical, only a control inside one differs.
    expect(winIds).toContain("settings.quick-unlock-toggle");
    expect(winIds).toContain("settings.quick-unlock-setup-pin");
  });
});

// ── 4. Absent, not disabled ────────────────────────────────────────────────
//
// `decisions.md` 2026-07-26 makes omission normative: an unavailable feature is
// omitted, never greyed out. On Windows the Touch ID button must not exist in
// any form — a disabled one would be an offer the platform cannot honour.

describe("a platform without a biometric provider offers nothing, disabled or otherwise", () => {
  it("renders no Hello/Touch ID control on Windows, in any state", async () => {
    setPlatform("Win32");
    stubIpc({
      // The Windows backend's honest answer.
      "plugin:quick-unlock|quick_unlock_status": () =>
        Promise.resolve({ configured: false, method: null, available: false }),
    });
    const { container } = render(<PrivacyPanel />);
    fireEvent.click(await screen.findByTestId("settings.quick-unlock-toggle"));
    await screen.findByTestId("settings.quick-unlock-setup-pin");

    expect(screen.queryByTestId("settings.quick-unlock-setup-biometric")).toBeNull();
    // …and not merely hidden or disabled: the node is absent from the DOM.
    expect(
      container.querySelectorAll("[data-testid*='biometric']").length,
      "a disabled Touch ID button is still an offer the platform cannot honour",
    ).toBe(0);
    // The PIN path, which IS portable, still renders.
    expect(screen.getByTestId("settings.quick-unlock-setup-pin")).toBeTruthy();
  });

  it("offers the biometric control on macOS, so the negative above is not vacuous", async () => {
    setPlatform("MacIntel");
    stubIpc();
    render(<PrivacyPanel />);
    fireEvent.click(await screen.findByTestId("settings.quick-unlock-toggle"));
    await waitFor(() =>
      expect(screen.getByTestId("settings.quick-unlock-setup-biometric")).toBeTruthy(),
    );
  });
});
