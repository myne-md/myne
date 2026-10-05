#!/usr/bin/env node
// Build the macOS .app and a decorated .dmg with correctly signed sidecar binaries.
//
// Why this exists: Tauri signs every sign target, the Frameworks, the `externalBin`
// sidecars and the app itself, with the SAME `bundle.macOS.entitlements`. The app
// needs the restricted `keychain-access-groups` entitlement for Touch ID quick-unlock,
// but a nested binary that carries a restricted entitlement is SIGKILLed by AMFI
// (exit 137): the entitlement is authorized by the app's embedded provisioning
// profile and a sidecar has none. Stripping the entitlement from the sidecars fixes
// them and re-signing the app re-seals the bundle.
//
// So the flow is: let Tauri produce the DMG scaffolding (`bundle_dmg.sh` + support/),
// produce the app, re-sign the sidecars without entitlements, re-sign the app with
// them, then rebuild the DMG from the fixed app with Tauri's own script.
//
// Usage: APPLE_SIGNING_IDENTITY=<sha-1|name> node scripts/build-macos-dmg.mjs
// The identity SHA-1 is preferred: the certificate common name contains "Ö" and
// `codesign` reports "no identity found" for it in some shells.

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, rmSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const CONF = JSON.parse(readFileSync(join(ROOT, "src-tauri/tauri.conf.json"), "utf8"));
const BUNDLE = join(ROOT, "target/release/bundle");
const APP = join(BUNDLE, "macos", `${CONF.productName}.app`);
const ID = process.env.APPLE_SIGNING_IDENTITY;
if (!ID) {
  console.error("APPLE_SIGNING_IDENTITY is required (the Apple Development identity SHA-1).");
  process.exit(1);
}

const run = (cmd, args, opts = {}) =>
  execFileSync(cmd, args, { stdio: "inherit", cwd: ROOT, ...opts });

// 1. Tauri writes bundle_dmg.sh + support/ into target/release/bundle/dmg during a
//    dmg bundle, and builds a first DMG from the app before we fix the signatures.
run("pnpm", ["tauri", "build", "--bundles", "dmg"]);

// 2. The dmg run cleaned the .app; rebuild it so we can fix and reuse it.
run("pnpm", ["tauri", "bundle", "--bundles", "app"]);

// 3. Re-sign the sidecars WITHOUT entitlements, then re-sign the app WITH them.
const sidecars = (CONF.bundle.externalBin ?? []).map((p) => p.replace(/^binaries\//, ""));
for (const bin of sidecars) {
  const path = join(APP, "Contents/MacOS", bin);
  if (!existsSync(path)) {
    console.error(`sidecar not found in the app bundle: ${bin}`);
    process.exit(1);
  }
  run("codesign", ["--force", "--sign", ID, path]);
}
run("codesign", [
  "--force",
  "--sign",
  ID,
  "--entitlements",
  join(ROOT, "src-tauri/entitlements.plist"),
  APP,
]);
run("codesign", ["--verify", "--verbose=2", APP]);

// 4. Rebuild the DMG from the fixed app using Tauri's own script (the chrome, the
//    background art and the Finder layout come from there, not from hdiutil).
const dmgConf = CONF.bundle.macOS.dmg;
const arch = process.arch === "arm64" ? "aarch64" : "x64";
const dmgName = `${CONF.productName}_${CONF.version}_${arch}.dmg`;
const dmgPath = join(BUNDLE, "dmg", dmgName);
const script = join(BUNDLE, "dmg", "bundle_dmg.sh");
const icns = join(BUNDLE, "dmg", "icon.icns");
for (const stale of readdirSync(join(BUNDLE, "dmg"))) {
  if (stale === dmgName || stale.startsWith("rw.")) rmSync(join(BUNDLE, "dmg", stale), { force: true });
}
const args = [
  "--volname", CONF.productName,
  "--icon", `${CONF.productName}.app`, String(dmgConf.appPosition.x), String(dmgConf.appPosition.y),
  "--app-drop-link", String(dmgConf.applicationFolderPosition.x), String(dmgConf.applicationFolderPosition.y),
  "--window-size", String(dmgConf.windowSize.width), String(dmgConf.windowSize.height),
  "--hide-extension", `${CONF.productName}.app`,
];
if (dmgConf.background) {
  args.push("--background", join(ROOT, "src-tauri", dmgConf.background));
}
if (existsSync(icns)) args.push("--volicon", icns);
args.push(dmgPath, `${CONF.productName}.app`);
run(script, args, {
  cwd: join(BUNDLE, "macos"),
  env: { ...process.env, TAURI_BUNDLER_DMG_IGNORE_CI: "1" },
});

// 5. Sign the DMG and run the repo's chrome checker.
run("codesign", ["--force", "--sign", ID, dmgPath]);
run("node", [join(ROOT, "scripts/check-macos-dmg.mjs"), dmgPath]);

console.log(`\nmacOS DMG ready: ${dmgPath}`);
