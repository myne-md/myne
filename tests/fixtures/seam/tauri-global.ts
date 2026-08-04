// The seam bypass that carries no module specifier, so the import rule cannot
// see it. Both spellings the runtime injects are here.
//
// Not compiled by anything — `tsconfig`'s `include` is `["src"]`, and this
// directory is outside every guarded root, which is exactly why the spec has to
// inject a roster to reach it.
export async function reachAround(args: unknown): Promise<unknown> {
  const a = await (window as unknown as { __TAURI_INTERNALS__: { invoke: (c: string, a: unknown) => Promise<unknown> } })
    .__TAURI_INTERNALS__.invoke("plugin:x|y", args);
  const b = await (globalThis as unknown as { __TAURI__: { invoke: (c: string) => Promise<unknown> } })
    .__TAURI__.invoke("plugin:x|z");
  return [a, b];
}
