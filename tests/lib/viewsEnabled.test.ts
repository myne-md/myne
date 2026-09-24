// @vitest-environment jsdom
//
// The Views toggle is device-local and does not travel with the vault —
// myne-md/myne#555's `settings.block.views-toggle` bullet.
//
// The roster row asked a person to flip the toggle on one machine, sync, and
// confirm the other machine did not follow. Two devices, one release cycle, one
// observation that is a NEGATIVE — "the other machine did not change" reads the
// same whether the property holds or the sync simply had not arrived yet.
//
// The module makes it a local question. `viewsEnabled.ts` stores the flag in
// `localStorage` under `myne.viewsEnabled` and says why in its own header: it is
// "a DEVICE-LOCAL UI preference (localStorage, like the display language)", kept
// off `vault.prefs` so it stays off the MYP1 byte codec. So the claim under test
// is not "the sync did not carry it" — it is "nothing ever put it anywhere the
// sync could reach", which is checkable in one process.
//
// This file had NO coverage at all, and the derived default is the part most
// worth having: the effective state is `storedPref ?? hasViews`, computed at the
// use site and never persisted, so a user who has never touched the toggle keeps
// tracking their live view count. Persisting the derived value would freeze it —
// a user whose last view is deleted would keep an entry pointing at nothing, and
// a user who creates their first view would not get the entry.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  readViewsEnabledPref,
  viewsEnabled,
  writeViewsEnabled,
  VIEWS_ENABLED_EVENT,
} from "../../src/lib/viewsEnabled";

const KEY = "myne.viewsEnabled";

/**
 * A working Storage stand-in when the ambient one is unusable.
 *
 * CI's vitest step runs `image: node:25`, which exposes a global `localStorage`
 * WITHOUT `clear`/`getItem` (incomplete experimental storage; often paired with
 * `--localstorage-file was provided without a valid path`). That global shadows
 * what `@vitest-environment jsdom` would otherwise provide, so the bare
 * `localStorage` binding in this file is the broken one and every test dies in
 * `beforeEach` with `TypeError: localStorage.clear is not a function` — while
 * the same file passes on local Node 22, which has no such global and lets
 * jsdom win. Same posture as `tests/screens/web-walls.test.tsx`: install a
 * minimal in-memory store over `window.localStorage` when the ambient one
 * cannot answer.
 */
function ensureUsableStorage(): void {
  const s = globalThis.localStorage as Storage | undefined;
  if (s && typeof s.clear === "function" && typeof s.getItem === "function") return;
  const map = new Map<string, string>();
  Object.defineProperty(window, "localStorage", {
    configurable: true,
    value: {
      getItem: (k: string) => map.get(k) ?? null,
      setItem: (k: string, v: string) => void map.set(k, String(v)),
      removeItem: (k: string) => void map.delete(k),
      clear: () => map.clear(),
      key: (i: number) => [...map.keys()][i] ?? null,
      get length() {
        return map.size;
      },
    },
  });
}

beforeEach(() => {
  ensureUsableStorage();
  localStorage.clear();
});

afterEach(() => {
  ensureUsableStorage();
  localStorage.clear();
  vi.restoreAllMocks();
});

describe("the stored preference", () => {
  it("is null until the user touches the toggle", () => {
    expect(readViewsEnabledPref()).toBeNull();
  });

  it("round-trips both explicit values", () => {
    writeViewsEnabled(true);
    expect(readViewsEnabledPref()).toBe(true);
    writeViewsEnabled(false);
    expect(readViewsEnabledPref()).toBe(false);
  });

  it("stores under the one documented key and nowhere else", () => {
    // The key is what makes this device-local rather than vault content, so it
    // is worth pinning by name. A second key would be a second source of truth.
    writeViewsEnabled(true);
    expect(localStorage.getItem(KEY)).toBe("1");
    expect(Object.keys(localStorage)).toEqual([KEY]);
  });

  it("reads an unrecognised stored value as untouched, not as false", () => {
    // The two are different: `false` suppresses the entry for a user WITH views,
    // `null` lets the back-compat default keep it. A corrupted or
    // future-version value must not silently hide a feature.
    for (const junk of ["", "yes", "true", "2", "null"]) {
      localStorage.setItem(KEY, junk);
      expect(readViewsEnabledPref(), junk).toBeNull();
    }
  });
});

describe("the derived default: storedPref ?? hasViews", () => {
  it("follows the live view count while untouched", () => {
    expect(viewsEnabled(false)).toBe(false);
    expect(viewsEnabled(true)).toBe(true);
  });

  it("stops following it the moment the user is explicit, in both directions", () => {
    // An existing views user who turns it OFF keeps it off…
    writeViewsEnabled(false);
    expect(viewsEnabled(true)).toBe(false);
    // …and a user with no views who turns it ON keeps it on.
    writeViewsEnabled(true);
    expect(viewsEnabled(false)).toBe(true);
  });

  it("persists nothing derived, so the default keeps tracking", () => {
    // The failure this prevents: writing the derived value on read would freeze
    // it. Reading the effective state for a vault WITH views must not leave
    // `true` behind, or a user who then deletes their last view keeps a
    // sidebar entry pointing at nothing.
    expect(viewsEnabled(true)).toBe(true);
    expect(localStorage.getItem(KEY)).toBeNull();
    expect(viewsEnabled(false)).toBe(false);
  });
});

describe("it does not travel with the vault", () => {
  it("the module names no vault-prefs writer at all", async () => {
    // The claim is not "the sync dropped it" but "nothing ever put it where the
    // sync could see it". `vault.prefs` writes go through `writePref`
    // (`scripts/check-prefs-nonce.mjs` holds that chokepoint), and this module
    // must reach none of it.
    const fs = await import("node:fs");
    const src: string = fs.readFileSync("src/lib/viewsEnabled.ts", "utf8");
    for (const forbidden of ["writePref", "prefsRead", "plugin:prefs", "invoke"]) {
      expect(
        src.includes(forbidden),
        `viewsEnabled.ts reaches for ${forbidden}. The toggle would then be ` +
          `vault content and WOULD travel — which is a legitimate change (the ` +
          `header calls it "a later cross-stack change"), but it is a change ` +
          `to what this setting IS, not a refactor.`,
      ).toBe(false);
    }
    expect(src).toContain("localStorage");
  });

  it("a second device sees its own storage, not the first device's", () => {
    // Two "devices" in one process: the storage IS the device boundary here, so
    // clearing it is exactly what arriving on another machine looks like.
    writeViewsEnabled(true);
    expect(viewsEnabled(false)).toBe(true);
    localStorage.clear(); // …the other machine
    expect(
      viewsEnabled(false),
      "the toggle survived a storage boundary, which is the only thing " +
        "separating one device from another for a localStorage preference",
    ).toBe(false);
  });
});

describe("open surfaces are told, and a refusing store does not break the toggle", () => {
  it("dispatches its change event so the sidebar and Settings re-read", () => {
    // No prop threading between those two surfaces, so a missing event leaves
    // the sidebar showing the old state until something else re-renders it.
    const seen: string[] = [];
    const onChange = () => seen.push("fired");
    window.addEventListener(VIEWS_ENABLED_EVENT, onChange);
    try {
      writeViewsEnabled(true);
      writeViewsEnabled(false);
      expect(seen.length).toBe(2);
    } finally {
      window.removeEventListener(VIEWS_ENABLED_EVENT, onChange);
    }
  });

  it("still notifies when the store REFUSES the write (a private window)", () => {
    // The header's own case: "private mode — just won't persist". The session
    // must still reflect the user's choice, so the event has to fire even when
    // the write threw. Otherwise the toggle looks inert in a private window.
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new DOMException("quota", "QuotaExceededError");
    });
    let fired = 0;
    const onChange = () => (fired += 1);
    window.addEventListener(VIEWS_ENABLED_EVENT, onChange);
    try {
      expect(() => writeViewsEnabled(true)).not.toThrow();
      expect(fired).toBe(1);
    } finally {
      window.removeEventListener(VIEWS_ENABLED_EVENT, onChange);
    }
  });

  it("reads as untouched when the store refuses to be read", () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new DOMException("denied", "SecurityError");
    });
    expect(readViewsEnabledPref()).toBeNull();
    expect(viewsEnabled(true)).toBe(true);
  });
});
