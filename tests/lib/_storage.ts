// A working `localStorage` stand-in for the jsdom test environment.
//
// Not a test file: the `_` prefix keeps it out of vitest's
// `tests/**/*.test.ts` collection, the same convention `_themeLink.ts` and
// `_desktopCsp.ts` use.
//
// Two independent reasons the ambient binding cannot be trusted, both measured
// rather than assumed:
//
//   - Node 25 and later expose an EXPERIMENTAL global `localStorage` that is
//     `undefined` unless the process was started with `--localstorage-file`, so
//     a bare `localStorage.clear()` throws `Cannot read properties of undefined
//     (reading 'clear')`. CI's vitest step runs `image: node:25`.
//   - This jsdom setup supplies no `localStorage` at all (`globalThis === window`
//     here, and both report `undefined`), so `window.localStorage` is not the
//     escape hatch it looks like. Older Node, which has no such global at all,
//     hides the first problem and used to let these suites pass locally.
//
// So a spec that actually needs storage installs one, and it installs it on
// `globalThis` so the bare binding the app code uses resolves to it. The key
// enumeration in the stand-in goes through the Storage API (`length` + `key(i)`)
// rather than `Object.keys`: a plain stand-in and Node's experimental object
// both expose their methods as own properties, while a real `Storage` exposes
// only data keys.
//
// Call it in `beforeEach`, before the first `localStorage` access. Tests that
// assert a REFUSED storage (private mode) still replace `localStorage` with an
// object that throws on its own.

/** Install an in-memory `Storage` over `globalThis.localStorage` when the
 *  ambient one cannot answer (`clear`/`getItem` missing, or absent entirely).
 *  Idempotent: a working Storage is left alone. */
export function ensureUsableStorage(): void {
  const s = globalThis.localStorage as Storage | undefined;
  if (s && typeof s.clear === "function" && typeof s.getItem === "function") return;
  const map = new Map<string, string>();
  Object.defineProperty(globalThis, "localStorage", {
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
