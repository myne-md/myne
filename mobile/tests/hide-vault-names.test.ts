// @vitest-environment jsdom
//
// The mobile half of the hide-vault-names option (myne-md/myne#411).
//
// Three things are pinned here and each of them is invisible to `tsc`:
//
//  1. **The ACL mirror.** A Tauri command needs FOUR registration sites on this
//     client (`build.rs`'s `InlinedPlugin` list, the `[[permission]]` block,
//     the `[default]` roster that names it, and `generate_handler!`), plus the
//     capability grant. Miss any of them and the command fails CLOSED at
//     runtime, on a device, which is the most expensive place to find out.
//     `src-tauri/AGENTS.md` records that dropping an identifier from a
//     `[default]` bundle compiles clean, so nothing but this test sees it.
//  2. **The three-state keychain status.** A rejected PROBE is `"unknown"`,
//     never `"unavailable"`. The backend reports unavailability as a VALUE, so a
//     rejection means the question went unanswered; reading it as "unavailable"
//     would put a false explanation on screen and is the shape a plaintext
//     fallback would later hide behind. `"unavailable"` is a live state here
//     (every Android device is in it today), which is exactly why the third
//     value has to stay distinct from it.
//  3. **The destructive sentence is on the row; both bounds are one press away.**
//     They are the disclosure, not decoration: "erases" read alone means more
//     than it does. Until myne-md/myne#960 that meant all three paragraphs sat
//     under the row, unconditionally. The owner's decision is now the desktop's
//     shape (#885): the sentence that says what the switch does stays beside it,
//     the mechanics and both bounds open in an info sheet. What this file still
//     pins, and must keep pinning, is that the sheet really carries all three
//     sentences. A trigger that opened nothing would otherwise pass, which is
//     exactly the vacuous shape this repository keeps finding.
//
// A component render via react-dom with `react-i18next` mocked to echo keys.
// mobile's convention (`tests/markdown-image-lightbox.test.ts`), no
// testing-library. `tests/` sits outside `tsc`'s `include: ["src"]`, so the node
// builtins here are untyped by design.

import { readFileSync } from "node:fs";
import { fileURLToPath, URL } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";

const invoke = vi.fn(async () => undefined as unknown);
vi.mock("@tauri-apps/api/core", () => ({ invoke: (...args: unknown[]) => invoke(...args) }));
// `useTranslation` echoes keys so the component assertions read as keys. The
// `initReactI18next` stub is not decoration: `src/lib/vault-label.ts` now
// resolves its fallback through the shared `@myne/i18n` runtime, whose module
// body calls `i18n.use(initReactI18next)`, and a mock without it throws on
// import. The stub is the shape i18next's `use()` accepts for a 3rd-party
// module, and it leaves `i18n.t` itself real, which is what the language test
// below needs.
vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (k: string) => k }),
  initReactI18next: { type: "3rdParty", init: () => {} },
}));

// React 19 refuses to flush an async update outside `act` unless it is told the
// environment supports it. Two of the tests below drive a promise across a
// render, which is exactly what needs the flush.
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

import {
  hideNamesWriteNotice,
  hideVaultNamesErrorKind,
  readHideVaultNames,
  readKeychainStatus,
  setHideVaultNames,
  vaultDisplayLabel,
} from "../src/lib/vault-label";
import { stableVaultNumber } from "../src/lib/vault-list";
import { HideVaultNamesBlock } from "../src/components/HideVaultNamesBlock";
import type { VaultSummary } from "../src/types/vault-summary";

const sib = (p: string) => fileURLToPath(new URL(p, import.meta.url));
const read = (p: string) => readFileSync(sib(p), "utf8");

const THE_THREE = ["hide_vault_names", "set_hide_vault_names", "vault_label_keychain_status"];

// `mockReset`, not `mockClear`: one test below installs a never-resolving
// implementation to hold the row in its pre-probe state, and `clearAllMocks`
// leaves an implementation in place, which hung every test after it.
beforeEach(() => {
  invoke.mockReset();
  invoke.mockResolvedValue(undefined as unknown);
});
afterEach(() => {
  document.body.replaceChildren();
});

// ── The WebView↔Rust contract ───────────────────────────────────────────────

describe("the hide-vault-names command wrappers", () => {
  it("readHideVaultNames → plugin:vault-label|hide_vault_names", async () => {
    invoke.mockResolvedValueOnce({ hidden: true });
    expect(await readHideVaultNames()).toBe(true);
    expect(invoke).toHaveBeenCalledWith("plugin:vault-label|hide_vault_names");
  });

  it("setHideVaultNames → plugin:vault-label|set_hide_vault_names { hidden }", async () => {
    invoke.mockResolvedValueOnce({ hidden: true });
    expect(await setHideVaultNames(true)).toBe(true);
    expect(invoke).toHaveBeenCalledWith("plugin:vault-label|set_hide_vault_names", {
      hidden: true,
    });
  });

  it("readKeychainStatus → plugin:vault-label|vault_label_keychain_status", async () => {
    invoke.mockResolvedValueOnce({ available: true });
    expect(await readKeychainStatus()).toBe("available");
    expect(invoke).toHaveBeenCalledWith("plugin:vault-label|vault_label_keychain_status");
  });

  it("no wrapper here takes or returns a label", () => {
    // The whole family's guarantee: the only value crossing either way is a
    // boolean. A wrapper that grew a `label` argument would be a name leaving
    // the encrypted envelope through the one seam nobody watches.
    const lib = read("../src/lib/vault-label.ts");
    const wrappers = lib.slice(lib.indexOf("readHideVaultNames"));
    expect(wrappers).not.toMatch(/label\s*[:,)]/);
  });
});

// ── The three-state status ─────────────────────────────────────────────────

describe("a failed probe is not an unavailable keychain", () => {
  it("reports 'available' when the facility answers and holds a keychain", async () => {
    invoke.mockResolvedValueOnce({ available: true });
    expect(await readKeychainStatus()).toBe("available");
  });

  it("reports 'unavailable' only when the backend SAYS so, as a value", async () => {
    // This is a live state on mobile rather than an exotic one: `platform_keychain`
    // has an Apple backend and returns `UnavailableKeychain` on every other
    // target, so every Android device lands here today.
    invoke.mockResolvedValueOnce({ available: false });
    expect(await readKeychainStatus()).toBe("unavailable");
  });

  it("reports 'unknown', NEVER 'unavailable', when the probe rejects", async () => {
    // A rejection means the question went unanswered (no host, an ACL entry that
    // never landed), not that the device has no keychain. Collapsing the two
    // would put a false explanation on screen, and on the one client where most
    // devices really ARE unavailable it would be unfalsifiable.
    invoke.mockRejectedValueOnce(new Error("no such command"));
    expect(await readKeychainStatus()).toBe("unknown");
  });

  it("does not treat a rejected FLAG read as a keychain verdict either", async () => {
    invoke.mockRejectedValueOnce({ kind: "Io", detail: { io_error_kind: "Other" } });
    await expect(readHideVaultNames()).rejects.toBeTruthy();
  });
});

describe("what a failed write says", () => {
  it("maps EraseIncomplete to its own notice, not a generic save failure", () => {
    // The backend erases FIRST and persists second, so a surviving key means the
    // flag was deliberately not written and the names are still readable. That
    // is the one fact the user needs and a generic "couldn't save" drops it.
    expect(hideNamesWriteNotice("EraseIncomplete")).toBe("erase");
  });

  it("says nothing transient for KeychainUnavailable: the row has a standing line", () => {
    expect(hideNamesWriteNotice("KeychainUnavailable")).toBeNull();
  });

  it("falls back to the save notice for Io, Parse and an unrecognised rejection", () => {
    expect(hideNamesWriteNotice("Io")).toBe("save");
    expect(hideNamesWriteNotice("Parse")).toBe("save");
    expect(hideNamesWriteNotice(null)).toBe("save");
  });

  it("narrows only the four tags the backend enum declares", () => {
    expect(hideVaultNamesErrorKind({ kind: "EraseIncomplete" })).toBe("EraseIncomplete");
    expect(hideVaultNamesErrorKind({ kind: "Whatever" })).toBeNull();
    expect(hideVaultNamesErrorKind(null)).toBeNull();
    expect(hideVaultNamesErrorKind("boom")).toBeNull();
  });
});

// ── The row itself ─────────────────────────────────────────────────────────

function renderBlock(): HTMLElement {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  flushSync(() => root.render(createElement(HideVaultNamesBlock)));
  return container;
}

/** The same mount, but awaited, so a resolved probe has reached the DOM. */
async function renderBlockAsync(props: Record<string, unknown> = {}): Promise<HTMLElement> {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(createElement(HideVaultNamesBlock, props));
  });
  return container;
}

const rowEl = (c: HTMLElement): HTMLElement =>
  c.querySelector('[data-testid="settings.hide-vault-names"]') as HTMLElement;

const switchEl = (c: HTMLElement): HTMLElement =>
  c.querySelector('[role="switch"], [aria-disabled]') as HTMLElement;

async function click(el: HTMLElement): Promise<void> {
  await act(async () => {
    el.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
}

describe("the Privacy row states its bounds, one press away", () => {
  it("keeps the destructive sentence on the row and puts all three in the sheet", async () => {
    // The row sentence is the one a reader cannot miss, and it is the reason the
    // switch can be understood without opening anything. The three explanatory
    // sentences are NOT deleted: they are the bounds, and both of them have to
    // survive the move: "erases" read alone means more than it does.
    invoke.mockResolvedValue({ hidden: false, available: true });
    const container = await renderBlockAsync();

    // On the row, unconditionally: the destructive sentence.
    expect(rowEl(container).textContent).toContain("settings.privacy.hideVaultNamesInline");

    // Not painted anywhere before the press: no standing grey paragraphs.
    expect(container.querySelector('[data-testid="settings.hide-vault-names-erases"]')).toBeNull();
    expect(container.querySelector('[data-testid="settings.hide-vault-names-residue"]')).toBeNull();

    const trigger = container.querySelector(
      '[data-testid="settings.hide-vault-names-trigger"]',
    ) as HTMLElement;
    expect(trigger.getAttribute("aria-expanded")).toBe("false");
    expect(trigger.getAttribute("aria-label")).toBe("settings.helperDisclosureLabel");

    await click(trigger);

    const sheet = container.querySelector(
      '[data-testid="settings.hide-vault-names-sheet"]',
    ) as HTMLElement;
    expect(sheet.textContent).toContain("settings.privacy.hideVaultNamesHelper");
    expect(sheet.textContent).toContain("settings.privacy.hideVaultNamesErases");
    expect(sheet.textContent).toContain("settings.privacy.hideVaultNamesResidue");
  });

  it("carries exactly the desktop row's nine locale keys, and invents none", () => {
    // Byte-identical copy across the two clients is the point: they must not
    // come to disagree about what is private. A mobile-only shortened key would
    // be exactly how that starts, and the two bounds are the ones that would be
    // shortened first.
    //
    // The count moved 8 -> 9 with myne-md/myne#885, which split the row's copy:
    // the destructive sentence became `hideVaultNamesInline` on the row and the
    // rest moved behind the desktop's question mark. The desktop's panel now
    // names nine of these keys and mobile names the same nine, which is what the
    // equality below checks. (The feature's search-index key lives in
    // `settingsSearchIndex.ts`, not in the panel, so the regex never sees it.)
    const mobile = read("../src/components/HideVaultNamesBlock.tsx");
    const desktop = read("../../src/components/settings/PrivacyPanel.tsx");
    const keys = (s: string) =>
      [
        ...new Set(
          [...s.matchAll(/t\("(settings\.privacy\.hideVaultNames[A-Za-z]*)"\)/g)].map((m) => m[1]),
        ),
      ].sort();
    expect(keys(mobile)).toHaveLength(9);
    expect(keys(mobile)).toEqual(keys(desktop));
  });

  it("says nothing about the keychain until the probe has answered", () => {
    // "unknown" must render no explanation at all: an unanswered question is not
    // a verdict about the device.
    invoke.mockImplementation(() => new Promise(() => {}));
    const container = renderBlock();
    expect(
      container.querySelector('[data-testid="settings.hide-vault-names-unavailable"]'),
    ).toBeNull();
    expect(
      container.querySelector('[data-testid="settings.hide-vault-names"]')
        ?.getAttribute("data-keychain"),
    ).toBe("unknown");
  });

  it("keeps the switch interactive with no keychain: turning it OFF touches none", () => {
    // A disabled control would strand a user whose keychain disappeared after
    // they had turned the option on.
    const source = read("../src/components/HideVaultNamesBlock.tsx");
    expect(source).not.toMatch(/disabled=\{[^}]*keychain/);
  });
});

// ── The switch is still a switch while the erase runs ──────────────────────

describe("the busy switch keeps its role, its state and its disabled look", () => {
  it("stays role=switch with an aria-checked and an aria-disabled while writing", async () => {
    // The erase destroys per-vault keys across EVERY vault on the device, so
    // this window is not instantaneous. Mobile's `Switch` renders
    // `role={onToggle ? "switch" : undefined}` and
    // `aria-checked={onToggle ? on : undefined}` (`src/components/inputs.tsx`),
    // so withholding the handler took the control's role and its state away
    // from assistive technology for the whole operation, and left it at full
    // opacity looking live while ignoring taps. `disabled` is the prop that
    // says "not now" on all three axes at once.
    invoke.mockImplementation((cmd: unknown) =>
      cmd === "plugin:vault-label|set_hide_vault_names"
        ? new Promise(() => {})
        : Promise.resolve(
            cmd === "plugin:vault-label|hide_vault_names"
              ? { hidden: false }
              : { available: true },
          ),
    );
    const container = await renderBlockAsync();
    const sw = switchEl(container);
    expect(sw.getAttribute("role")).toBe("switch");

    await click(sw);

    // Mid-write: still announced, still carrying its state, and now visibly off.
    expect(sw.getAttribute("role")).toBe("switch");
    expect(sw.getAttribute("aria-checked")).toBe("false");
    expect(sw.getAttribute("aria-disabled")).toBe("true");
    expect(sw.style.opacity).toBe("0.5");
    expect(sw.style.cursor).toBe("default");
  });

  it("ignores a second tap while the first write is in flight", async () => {
    const calls: unknown[] = [];
    invoke.mockImplementation((cmd: unknown) => {
      if (cmd === "plugin:vault-label|set_hide_vault_names") {
        calls.push(cmd);
        return new Promise(() => {});
      }
      return Promise.resolve(
        cmd === "plugin:vault-label|hide_vault_names" ? { hidden: false } : { available: true },
      );
    });
    const container = await renderBlockAsync();
    const sw = switchEl(container);
    await click(sw);
    await click(sw);
    expect(calls).toHaveLength(1);
  });
});

// ── The mount reads never overwrite a write ────────────────────────────────

describe("a mount read that lands after a write is dropped", () => {
  it("does not flip the switch back to the pre-write value", async () => {
    // The two are unordered and `alive` does not order them: it only says the
    // block is still mounted. A read that started at mount and answers after
    // the write reports the value from BEFORE the write, and applying it
    // silently flips the switch back, which misreports whether a destructive
    // erase took effect.
    let resolveRead!: (view: { hidden: boolean }) => void;
    const lateRead = new Promise<{ hidden: boolean }>((res) => {
      resolveRead = res;
    });
    invoke.mockImplementation((cmd: unknown) => {
      if (cmd === "plugin:vault-label|hide_vault_names") return lateRead;
      if (cmd === "plugin:vault-label|set_hide_vault_names") return Promise.resolve({ hidden: true });
      return Promise.resolve({ available: true });
    });
    const container = await renderBlockAsync();
    await click(switchEl(container));
    expect(rowEl(container).getAttribute("data-hidden")).toBe("true");

    resolveRead({ hidden: false });
    await act(async () => {
      await lateRead;
    });
    expect(rowEl(container).getAttribute("data-hidden")).toBe("true");
  });

  it("does not report the stale pair through onResolved either", async () => {
    let resolveRead!: (view: { hidden: boolean }) => void;
    const lateRead = new Promise<{ hidden: boolean }>((res) => {
      resolveRead = res;
    });
    invoke.mockImplementation((cmd: unknown) => {
      if (cmd === "plugin:vault-label|hide_vault_names") return lateRead;
      if (cmd === "plugin:vault-label|set_hide_vault_names") return Promise.resolve({ hidden: true });
      return Promise.resolve({ available: true });
    });
    const resolved: unknown[] = [];
    const container = await renderBlockAsync({ onResolved: (s: unknown) => resolved.push(s) });
    await click(switchEl(container));

    resolveRead({ hidden: false });
    await act(async () => {
      await lateRead;
    });
    expect(resolved).toEqual([]);
  });
});

// ── The four registration sites ────────────────────────────────────────────

describe("the vault-label ACL is mirrored, not half-mirrored", () => {
  it("registers all three commands at every backend site", () => {
    const sites = [
      "../src-tauri/build.rs",
      "../src-tauri/permissions/vault-label/default.toml",
      "../src-tauri/src/plugins/vault_label/mod.rs",
    ];
    for (const site of sites) {
      const source = read(site);
      for (const command of THE_THREE) {
        expect(source, `${site} must register ${command}`).toContain(command);
      }
    }
  });

  it("names every identifier in the [default] roster", () => {
    // The trap `src-tauri/AGENTS.md` records: a `[[permission]]` block that no
    // `[default]` entry names grants nothing, and dropping one from the bundle
    // compiles clean on both sides.
    const toml = read("../src-tauri/permissions/vault-label/default.toml");
    const declared = [...toml.matchAll(/identifier = "([a-z-]+)"/g)].map((m) => m[1]).sort();
    const bundled = [...toml.matchAll(/^\s+"(allow-[a-z-]+)",$/gm)].map((m) => m[1]).sort();
    expect(declared).toEqual([
      "allow-hide-vault-names",
      "allow-set-hide-vault-names",
      "allow-vault-label-keychain-status",
    ]);
    // Both directions: an identifier with no bundle entry is dead, and a bundle
    // entry with no identifier fails the ACL resolver.
    expect(bundled).toEqual(declared);
  });

  it("grants vault-label:default to the main window", () => {
    const caps = JSON.parse(read("../src-tauri/capabilities/default.json"));
    expect(caps.permissions).toContain("vault-label:default");
    expect(caps.windows).toEqual(["main"]);
  });

  it("registers the plugin on the builder, so the handler is reachable at all", () => {
    // An `InlinedPlugin` + permissions + capability entry with no `.plugin(…)`
    // call is a fully-authorized command nothing serves.
    expect(read("../src-tauri/src/lib.rs")).toContain("plugins::vault_label::init()");
    expect(read("../src-tauri/src/plugins/mod.rs")).toContain("pub mod vault_label;");
  });
});

// ── Vault N ────────────────────────────────────────────────────────────────

const vault = (id: string, last_unlock: number | null = null): VaultSummary => ({
  id,
  status: { kind: "Exists" },
  label: null,
  icon: null,
  last_unlock,
});

describe("Vault N is the vault's number, not the row's", () => {
  const A = "00000000-0000-7000-8000-00000000000a";
  const B = "00000000-0000-7000-8000-00000000000b";
  const C = "00000000-0000-7000-8000-00000000000c";

  it("gives the same vault the same number whatever order the list arrives in", () => {
    // The defect this replaces: the list is ordered by last unlock, so opening a
    // vault renumbered every row. The identifier a user is asked to remember
    // must not move as they use the app.
    const byId = [vault(A), vault(B), vault(C)];
    const byRecency = [vault(C), vault(A), vault(B)];
    for (const [id, n] of [[A, 1], [B, 2], [C, 3]] as const) {
      expect(stableVaultNumber(byId, id)).toBe(n);
      expect(stableVaultNumber(byRecency, id)).toBe(n);
    }
  });

  it("never gives two vaults the same number", () => {
    // A rank over a set of distinct ids is an injection, which is why this is
    // not a hash folded into a small range.
    const list = [vault(C), vault(A), vault(B)];
    const numbers = list.map((v) => stableVaultNumber(list, v.id));
    expect(new Set(numbers).size).toBe(list.length);
    expect([...numbers].sort()).toEqual([1, 2, 3]);
  });

  it("keeps 1..n dense, so no copy changes", () => {
    const list = [vault(A), vault(B), vault(C)];
    expect(list.map((v) => stableVaultNumber(list, v.id)).sort()).toEqual([1, 2, 3]);
  });

  it("agrees with the desktop helper by construction", () => {
    // Twin modules; a drift here shows one vault two different numbers on two
    // devices looking at the same account.
    const body = (s: string) => {
      const from = s.indexOf("export function stableVaultNumber");
      const to = s.indexOf("\n}\n", from);
      expect(from, "stableVaultNumber must exist in both trees").toBeGreaterThan(-1);
      return s.slice(from, to).replace(/\s+/g, " ");
    };
    expect(body(read("../src/lib/vault-list.ts"))).toBe(
      body(read("../../src/lib/vault-list.ts")),
    );
  });

  it("is what the picker and the switcher both render", () => {
    // Fixing only the picker would make one vault read `Vault 1` there and
    // `Vault 2` in the switcher within a single session.
    for (const surface of [
      "../src/app/flows/PickerFlow.tsx",
      "../src/app/flows/editor/sheets/VaultSwitcher.tsx",
    ]) {
      const source = read(surface);
      expect(source, `${surface} must use the stable number`).toContain("stableVaultNumber(");
      expect(source, `${surface} must not number rows by position`).not.toMatch(
        /vaultDisplayLabel\([^)]*,\s*i\s*\+\s*1\)/,
      );
    }
  });

  it("still falls back to a bare 'Vault' when no number is offered", () => {
    // The single-vault surfaces (header, Settings) name the active vault and
    // have no list to rank against; the fallback there is unchanged.
    expect(vaultDisplayLabel(null)).toBe("Vault");
    expect(vaultDisplayLabel(null, 2)).toBe("Vault 2");
    expect(vaultDisplayLabel("Personal", 2)).toBe("Personal");
  });

  it("renders the fallback in the ACTIVE language, not in English", async () => {
    // This is the primary rendering on this client, not a rare one: the hide
    // option erases every stored name at once, and on Android
    // `platform_keychain` returns `UnavailableKeychain` unconditionally, so
    // every row is a fallback always. A hardcoded literal meant a Turkish user
    // read "Vault 2" on the phone and "Kasa 2" on the laptop, which is the
    // split `src/lib/vault-list.ts`'s own docstring calls worse than the defect
    // it replaces. `scripts/check-i18n.mjs` cannot see a literal, so nothing
    // else here would say so.
    const i18n = (await import("@myne/i18n")).default;
    const { setLanguage } = await import("@myne/i18n");
    expect(await setLanguage("tr")).toBe(true);
    try {
      expect(vaultDisplayLabel(null, 2)).toBe("Kasa 2");
      expect(vaultDisplayLabel(null)).toBe("Kasa");
      // A real name is still whatever the user typed, in every language.
      expect(vaultDisplayLabel("Personal", 2)).toBe("Personal");
    } finally {
      await i18n.changeLanguage("en");
    }
    expect(vaultDisplayLabel(null, 2)).toBe("Vault 2");
  });

  it("resolves at call time, so a language switch reaches an already-imported module", async () => {
    // A module-level constant would freeze the boot language forever
    // (`src/AGENTS.md`, "Module-level data ... resolve with `t()` at the
    // render/usage consumer"), and the freeze is invisible until someone
    // changes language mid-session.
    const i18n = (await import("@myne/i18n")).default;
    const before = vaultDisplayLabel(null, 1);
    const { setLanguage } = await import("@myne/i18n");
    await setLanguage("tr");
    try {
      expect(vaultDisplayLabel(null, 1)).not.toBe(before);
    } finally {
      await i18n.changeLanguage("en");
    }
    expect(vaultDisplayLabel(null, 1)).toBe(before);
  });
});
