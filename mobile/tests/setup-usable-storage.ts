//
// A working `Storage` over the ambient one, when the ambient one is the broken
// kind.
//
// # The failure this pins
//
// CI's `mobile-vitest` step runs `image: node:25`, which exposes a global
// `localStorage` WITHOUT `getItem`/`clear` (incomplete experimental storage,
// usually paired with `--localstorage-file was provided without a valid path`).
// That global shadows what `@vitest-environment jsdom` would otherwise provide,
// so a bare `localStorage` read in a component under test throws
// `TypeError: localStorage.getItem is not a function` — and the same file passes
// on a local Node 26, which has no such global and lets jsdom win. The two arms
// disagree, so the failing run says nothing about the code under test.
//
// `SettingsSheet` reads the stored theme inside a `useState` initializer, so the
// break is not confined to the storage assertion: the whole sheet fails to
// mount and four unrelated copy tests in
// `tests/components/SettingsSheet.memberVaultRemoval.test.tsx` went red for it.
//
// # Why a setup file and not a per-test helper
//
// The desktop lane keeps an equivalent `ensureUsableStorage()` inside the two
// specs that need it (`tests/lib/viewsEnabled.test.ts` carries the full
// reasoning). Mobile runs its specs under `environment: "node"` with a per-file
// `@vitest-environment jsdom` pragma, so every jsdom spec in this tree inherits
// the same broken global and each would need the same copy. One setup file
// covers them, costs nothing in the node-env specs (there is no `window` there,
// so it returns before touching anything), and cannot drift spec by spec.
//
// The stand-in answers the Storage API rather than enumerating properties: a
// real `Storage` exposes only data keys, while both this object and Node's
// experimental one expose methods as own properties, so `Object.keys` would see
// the wrong thing on two of the three shapes. Tests that force a refusal spy on
// THIS `localStorage` object, not on `Storage.prototype`: the stand-in is not a
// `Storage` instance, so a prototype spy never reaches it and the test would
// pass for the wrong reason on exactly the CI arm this helper exists for.
function ensureUsableStorage(): void {
  if (typeof window === "undefined") return;
  const ambient = globalThis.localStorage as Storage | undefined;
  if (
    ambient &&
    typeof ambient.getItem === "function" &&
    typeof ambient.clear === "function"
  ) {
    return;
  }
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

ensureUsableStorage();
