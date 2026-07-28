// The wasm boundary's two-language drift lock (phase3-web-client task 11).
//
// `web/src/worker/wasm-module.d.ts` is HAND-WRITTEN — `scripts/build-wasm.sh`
// passes `--no-typescript` so that `tsc` does not depend on having run the wasm
// build (a clean clone has no `web/wasm/pkg/`). The cost of hand-writing it is
// that nothing in the compiler relates it to the Rust it describes: an export
// renamed in `entry.rs` would leave the `.d.ts` describing a function that no
// longer exists, and `tsc` would keep passing because the declaration is
// ambient. The first symptom would be `undefined is not a function` inside the
// Worker at runtime.
//
// So this file reads both sides and compares them. Deliberately a text scan
// rather than a parser: the surface is three exports, and a Rust parser
// dependency to check three names would be the wrong trade (root CLAUDE.md:
// adding a dependency is a security decision).

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const ENTRY_RS = resolve(process.cwd(), "web/wasm/src/entry.rs");
const DTS = resolve(process.cwd(), "web/src/worker/wasm-module.d.ts");

/** Every `#[wasm_bindgen]`-exported function in `entry.rs`, with its arity. */
function rustExports(): Map<string, number> {
  const source = readFileSync(ENTRY_RS, "utf8");
  const found = new Map<string, number>();
  const lines = source.split("\n");

  lines.forEach((line, i) => {
    // A bare `#[wasm_bindgen]` on its own line, immediately above the item. The
    // `extern "C"` blocks in `csprng.rs` are IMPORTS, not exports, and live in a
    // different file — which is why only `entry.rs` is scanned.
    if (line.trim() !== "#[wasm_bindgen]") return;
    const signature = lines[i + 1] ?? "";
    const m = /^pub (?:async )?fn ([a-z_0-9]+)\s*\(([^)]*)\)/.exec(signature.trim());
    if (!m) return;
    const params = m[2].trim();
    found.set(m[1], params === "" ? 0 : params.split(",").length);
  });

  return found;
}

/** Every declared function in the `.d.ts`, with its arity. */
function declaredExports(): Map<string, number> {
  const source = readFileSync(DTS, "utf8");
  const found = new Map<string, number>();
  for (const m of source.matchAll(
    /export (?:default )?function ([A-Za-z_0-9]+)\s*\(([\s\S]*?)\)\s*:/g,
  )) {
    const params = m[2].trim().replace(/\s+/g, " ");
    // Count top-level commas only — a parameter can be an object type with
    // commas inside it.
    let depth = 0;
    let count = params === "" ? 0 : 1;
    for (const ch of params) {
      if ("({[<".includes(ch)) depth++;
      else if (")}]>".includes(ch)) depth--;
      else if (ch === "," && depth === 0) count++;
    }
    found.set(m[1], count);
  }
  return found;
}

describe("wasm boundary — the hand-written .d.ts tracks entry.rs", () => {
  it("the scanners find something at all", () => {
    // A regex that silently matches nothing would make every assertion below
    // vacuously true, which is the failure mode of a text-scanning test.
    expect(rustExports().size).toBeGreaterThan(0);
    expect(declaredExports().size).toBeGreaterThan(0);
  });

  it("declares exactly the exports Rust provides", () => {
    const rust = rustExports();
    const declared = declaredExports();
    // `init` is the wasm-bindgen glue's own default export (`__wbg_init`), not
    // an item in `entry.rs`, so it is excluded from the comparison rather than
    // silently tolerated.
    declared.delete("init");

    expect([...declared.keys()].sort()).toEqual([...rust.keys()].sort());
  });

  it("declares each export with the same arity", () => {
    const rust = rustExports();
    const declared = declaredExports();
    for (const [name, arity] of rust) {
      expect(declared.get(name), `arity of ${name}`).toBe(arity);
    }
  });

  it("every declared export is imported by the Worker or explained", () => {
    // A declared-but-unused export is how a dead entry point survives a refactor.
    // The Worker is the ONLY consumer of this module by design.
    const worker = readFileSync(
      resolve(process.cwd(), "web/src/worker/worker.ts"),
      "utf8",
    );
    const rust = rustExports();
    for (const name of rust.keys()) {
      expect(worker, `${name} is exported from wasm but never used`).toContain(name);
    }
  });
});

describe("wasm boundary — the contract that keeps failures distinguishable", () => {
  it("invoke is declared as never-rejecting on the Rust side", () => {
    // `entry.rs`'s `invoke` MUST return `String`, not `Result<String, JsValue>`.
    // The whole distinction between "the command failed" (healthy instance) and
    // "the instance trapped" (dead instance) rests on it: if `invoke` could
    // reject, the Worker's `catch` could not tell the two apart and would either
    // discard a good instance or keep calling a dead one.
    const source = readFileSync(ENTRY_RS, "utf8");
    expect(source).toMatch(/pub async fn invoke\(cmd: String, args_json: String\) -> String/);
    expect(source).not.toMatch(/pub async fn invoke\([^)]*\)\s*->\s*Result/);
  });

  it("csprng_self_check has no host arm that could fabricate a pass", () => {
    // A `#[cfg(not(target_arch = "wasm32"))]` arm returning `true` would make the
    // startup gate pass on a target with no registered backend at all. `entry.rs`
    // is wasm-only, so the correct state is NO cfg arms in this function.
    const source = readFileSync(ENTRY_RS, "utf8");
    const fn = source.slice(source.indexOf("pub fn csprng_self_check"));
    const body = fn.slice(0, fn.indexOf("\n}"));
    expect(body).not.toContain("cfg(");
  });
});
