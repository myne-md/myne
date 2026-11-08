// @vitest-environment jsdom
//
// The mobile half of the account-record command surface (myne-md/myne#684).
//
// One thing is pinned here and it is invisible to `tsc`: the ACL mirror. A
// Tauri command needs FOUR registration sites on this client (`build.rs`'s
// `InlinedPlugin` list, the `[[permission]]` block, the `[default]` roster that
// names it, and `generate_handler!`), plus the capability grant. Miss any of
// them and the command fails CLOSED at runtime, on a device, which is the most
// expensive place to find out. `src-tauri/AGENTS.md` records that dropping an
// identifier from a `[default]` bundle compiles clean, so nothing but this test
// sees it.

import { readFileSync } from "node:fs";
import { fileURLToPath, URL } from "node:url";
import { describe, expect, it } from "vitest";

const sib = (p: string) => fileURLToPath(new URL(p, import.meta.url));
const read = (p: string) => readFileSync(sib(p), "utf8");

// One since `agent-tooling/design-notes/ui/0728` removed `account_rename` (an account has no
// name) and myne-md/myne#937 removed the move/split pair (the grouping is
// single-account, so there is nothing to move a vault into). A command that no
// longer exists is gone from every site rather than left authorized with
// nothing behind it.
const THE_COMMANDS = ["account_list"];

describe("the account ACL is mirrored, not half-mirrored", () => {
  it("registers the one command at every backend site", () => {
    const sites = [
      "../src-tauri/build.rs",
      "../src-tauri/permissions/account/default.toml",
      "../src-tauri/src/plugins/account/mod.rs",
    ];
    for (const site of sites) {
      const source = read(site);
      for (const command of THE_COMMANDS) {
        expect(source, `${site} must register ${command}`).toContain(command);
      }
    }
  });

  it("names every identifier in the [default] roster", () => {
    const toml = read("../src-tauri/permissions/account/default.toml");
    const declared = [...toml.matchAll(/identifier = "([a-z-]+)"/g)].map((m) => m[1]).sort();
    const bundled = [...toml.matchAll(/^\s+"(allow-[a-z-]+)",$/gm)].map((m) => m[1]).sort();
    expect(declared).toEqual(["allow-account-list"]);
    expect(bundled).toEqual(declared);
  });

  it("grants account:default to the main window", () => {
    const caps = JSON.parse(read("../src-tauri/capabilities/default.json"));
    expect(caps.permissions).toContain("account:default");
    expect(caps.windows).toEqual(["main"]);
  });

  it("registers the plugin on the builder, so the handler is reachable at all", () => {
    expect(read("../src-tauri/src/lib.rs")).toContain("plugins::account::init()");
    expect(read("../src-tauri/src/plugins/mod.rs")).toContain("pub mod account;");
  });
});
