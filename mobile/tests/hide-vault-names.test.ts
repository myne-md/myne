// @vitest-environment jsdom
//
// The mobile half of the hide-vault-names option (myne-md/myne#411).
//
// Three things are pinned here and each of them is invisible to `tsc`:
//
//  1. **The ACL mirror.** A Tauri command needs FOUR registration sites on this
//     client — `build.rs`'s `InlinedPlugin` list, the `[[permission]]` block,
//     the `[default]` roster that names it, and `generate_handler!` — plus the
//     capability grant. Miss any of them and the command fails CLOSED at
//     runtime, on a device, which is the most expensive place to find out.
//     `src-tauri/CLAUDE.md` records that dropping an identifier from a
//     `[default]` bundle compiles clean, so nothing but this test sees it.
//  2. **The three-state keychain status.** A rejected PROBE is `"unknown"`,
//     never `"unavailable"`. The backend reports unavailability as a VALUE, so a
//     rejection means the question went unanswered; reading it as "unavailable"
//     would put a false explanation on screen and is the shape a plaintext
//     fallback would later hide behind. `"unavailable"` is a live state here
//     (every Android device is in it today), which is exactly why the third
//     value has to stay distinct from it.
//  3. **The two bounds are on screen unconditionally.** They are the
//     disclosure, not decoration: "erases" read alone means more than it does.
//     A render with nothing resolved and nothing tapped must already show both.
//
// A component render via react-dom with `react-i18next` mocked to echo keys —
// mobile's convention (`tests/markdown-image-lightbox.test.ts`), no
// testing-library. `tests/` sits outside `tsc`'s `include: ["src"]`, so the node
// builtins here are untyped by design.

import { readFileSync } from "node:fs";
import { fileURLToPath, URL } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";

const invoke = vi.fn(async () => undefined as unknown);
vi.mock("@tauri-apps/api/core", () => ({ invoke: (...args: unknown[]) => invoke(...args) }));
vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (k: string) => k }),
}));

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
// leaves an implementation in place — which hung every test after it.
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

  it("reports 'unknown' — NEVER 'unavailable' — when the probe rejects", async () => {
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

  it("says nothing transient for KeychainUnavailable — the row has a standing line", () => {
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

describe("the Privacy row states its bounds without being asked", () => {
  it("shows BOTH bound sentences on a first render, with nothing tapped", () => {
    // Not behind a chevron, not shortened into the subtitle. The whole reason
    // the disclosure exists is that "erases" read alone means more than it does,
    // and a bound the reader has to tap for is one most readers never see.
    invoke.mockResolvedValue({ hidden: false, available: true });
    const container = renderBlock();
    expect(container.querySelector('[data-testid="settings.hide-vault-names-erases"]')?.textContent)
      .toBe("settings.privacy.hideVaultNamesErases");
    expect(container.querySelector('[data-testid="settings.hide-vault-names-residue"]')?.textContent)
      .toBe("settings.privacy.hideVaultNamesResidue");
  });

  it("carries exactly the desktop row's eight locale keys, and invents none", () => {
    // Byte-identical copy across the two clients is the point: they must not
    // come to disagree about what is private. A mobile-only shortened key would
    // be exactly how that starts, and the two bounds are the ones that would be
    // shortened first. (The feature's ninth key belongs to the desktop settings
    // SEARCH index, which mobile has no analogue of.)
    const mobile = read("../src/components/HideVaultNamesBlock.tsx");
    const desktop = read("../../src/components/settings/PrivacyPanel.tsx");
    const keys = (s: string) =>
      [
        ...new Set(
          [...s.matchAll(/t\("(settings\.privacy\.hideVaultNames[A-Za-z]*)"\)/g)].map((m) => m[1]),
        ),
      ].sort();
    expect(keys(mobile)).toHaveLength(8);
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

  it("keeps the switch interactive with no keychain — turning it OFF touches none", () => {
    // A disabled control would strand a user whose keychain disappeared after
    // they had turned the option on.
    const source = read("../src/components/HideVaultNamesBlock.tsx");
    expect(source).not.toMatch(/disabled=\{[^}]*keychain/);
    expect(source).toContain("onToggle={busy ? undefined : () => void toggle(!hidden)}");
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
    // The trap `src-tauri/CLAUDE.md` records: a `[[permission]]` block that no
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
});
