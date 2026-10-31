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
// Usage: node scripts/build-macos-dmg.mjs --target universal-apple-darwin
// APPLE_SIGNING_IDENTITY overrides the identity; the default is the Developer ID
// Application certificate, because that is the only one Apple notarizes. The
// identity SHA-1 is preferred over the common name: the certificate common name
// contains "Ö" and `codesign` reports "no identity found" for it in some shells.
//
// An Apple Development identity is REFUSED, not warned about. It cannot be
// notarized, so a build signed with it downloads as "Apple could not verify" on
// every machine but this one, and that shipped silently twice before this check
// existed. MYNE_ALLOW_DEV_SIGNING=1 is the deliberate escape for a local test
// build that is never uploaded.

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, rmSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const CONF = JSON.parse(readFileSync(join(ROOT, "src-tauri/tauri.conf.json"), "utf8"));

// An optional Rust target triple. Without one this behaves exactly as it always
// has (host arch, `target/release`). With one it follows the target's own output
// directory, which is what a universal build needs: `universal-apple-darwin`
// writes under `target/universal-apple-darwin/release` and names its DMG
// `_universal`, not `_aarch64`, so a script that kept the host's paths would
// look for artefacts the build never wrote.
//
//   node scripts/build-macos-dmg.mjs --target universal-apple-darwin
//
// The universal artefact also requires the four sidecars to exist as
// `binaries/<name>-universal-apple-darwin` before the build starts; the runbook's
// pre-build hygiene block is what produces them.
const targetArgIdx = process.argv.indexOf("--target");
const TARGET = targetArgIdx === -1 ? undefined : process.argv[targetArgIdx + 1];
if (targetArgIdx !== -1 && !TARGET) {
  console.error("--target needs a Rust target triple, e.g. universal-apple-darwin");
  process.exit(1);
}
const TARGET_ARGS = TARGET ? ["--target", TARGET] : [];
const BUNDLE = TARGET
  ? join(ROOT, "target", TARGET, "release/bundle")
  : join(ROOT, "target/release/bundle");

const APP = join(BUNDLE, "macos", `${CONF.productName}.app`);

// The Developer ID Application certificate on the release machine. Overridable,
// pinned by default: resolving it per run is how the wrong identity got used.
const DEVELOPER_ID_APP = "B1EE8D7C8D492AF0B0F2DA20282E5F6F96F760B1";
const ID = process.env.APPLE_SIGNING_IDENTITY || DEVELOPER_ID_APP;
const identityLine = execFileSync("security", ["find-identity", "-v"], { encoding: "utf8" })
  .split("\n")
  .find((line) => line.includes(ID));
const ID_NAME = identityLine ? (identityLine.match(/"([^"]+)"/)?.[1] ?? "") : "";
if (ID_NAME.includes("Apple Development") && process.env.MYNE_ALLOW_DEV_SIGNING !== "1") {
  console.error(
    `refusing to sign with ${ID_NAME}: Apple does not notarize a development\n` +
      "certificate, so every download would fail Gatekeeper. Use the Developer ID\n" +
      "Application identity, or set MYNE_ALLOW_DEV_SIGNING=1 for a local-only build.",
  );
  process.exit(1);
}

const ASC_KEY_PATH =
  process.env.ASC_KEY_PATH ||
  join(process.env.HOME, ".appstoreconnect/private_keys/AuthKey_MU82G3Z46F.p8");
const ASC_KEY_ID = process.env.ASC_KEY_ID || "MU82G3Z46F";
const ASC_ISSUER = process.env.ASC_ISSUER || "72c68bcb-f22a-4117-8906-0b1d4a619393";

// Notarization is not optional, and it is not a warning. An unnotarized artefact
// is the defect this whole block exists for, so a rejection prints Apple's own
// reasons and exits non-zero rather than leaving a shippable-looking file behind.
function notarize(path) {
  const out = execFileSync(
    "xcrun",
    [
      "notarytool", "submit", path,
      "--key", ASC_KEY_PATH, "--key-id", ASC_KEY_ID, "--issuer", ASC_ISSUER,
      "--wait", "--output-format", "json",
    ],
    { encoding: "utf8" },
  );
  const res = JSON.parse(out);
  if (res.status !== "Accepted") {
    console.error(`notarization of ${path} came back ${res.status} (id ${res.id})`);
    try {
      execFileSync(
        "xcrun",
        [
          "notarytool", "log", res.id,
          "--key", ASC_KEY_PATH, "--key-id", ASC_KEY_ID, "--issuer", ASC_ISSUER,
        ],
        { stdio: "inherit" },
      );
    } catch {
      console.error(`read the log by hand: xcrun notarytool log ${res.id} --key …`);
    }
    process.exit(1);
  }
  console.log(`notarized: ${path} (id ${res.id})`);
}

const codesign = (path) =>
  run("codesign", ["--force", "--options", "runtime", "--timestamp", "--sign", ID, path]);

const run = (cmd, args, opts = {}) =>
  execFileSync(cmd, args, { stdio: "inherit", cwd: ROOT, ...opts });

// 1. Build first and bundle second when a target triple is given, because the
//    universal bundler expects a cargo `[[bin]]` that is ALSO an `externalBin` to
//    exist at `target/<triple>/release/<name>`, and tauri's universal step lipos
//    only the app binary. That one is `myne-clipper-host` here, and its absence
//    fails the DMG bundle with "Failed to copy binary from ... does not exist"
//    after the whole universal compile, which is how this was found.
const cargoBins = (() => {
  const toml = readFileSync(join(ROOT, "src-tauri/Cargo.toml"), "utf8");
  const names = [...toml.matchAll(/^\[\[bin\]\][\s\S]*?^name = "([^"]+)"/gm)].map((m) => m[1]);
  const external = (CONF.bundle.externalBin ?? []).map((p) => p.replace(/^binaries\//, ""));
  return names.filter((n) => external.includes(n));
})();

if (TARGET) {
  run("pnpm", ["tauri", "build", "--no-bundle", ...TARGET_ARGS]);
  if (TARGET === "universal-apple-darwin") {
    for (const bin of cargoBins) {
      const arms = ["aarch64-apple-darwin", "x86_64-apple-darwin"].map((t) =>
        join(ROOT, "target", t, "release", bin),
      );
      for (const p of arms) {
        if (!existsSync(p)) {
          console.error(`cargo bin missing for the universal lipo: ${p}`);
          process.exit(1);
        }
      }
      run("lipo", ["-create", ...arms, "-output", join(ROOT, "target", TARGET, "release", bin)]);
    }
  }
  // A dmg bundle also writes bundle_dmg.sh + support/ into the bundle directory,
  // which step 4 reuses, so it runs before the signature repair rather than after.
  // Both bundle steps can end on the updater signing key, which is a separate
  // secret from the notarization credentials. That failure is TOLERATED only when
  // MYNE_ALLOW_MISSING_UPDATER_KEY=1, and it is announced with what is missing,
  // because a build that quietly ships without the updater signature leaves the
  // auto-updater dead for everyone with no symptom anywhere else.
  const bundleStep = (bundles) => {
    try {
      run("pnpm", ["tauri", "bundle", "--bundles", bundles, ...TARGET_ARGS]);
    } catch (err) {
      const tolerated = process.env.MYNE_ALLOW_MISSING_UPDATER_KEY === "1";
      if (!tolerated || !existsSync(APP)) {
        throw err;
      }
      console.error(
        "\nWARNING: the updater signature was not produced (no TAURI_SIGNING_PRIVATE_KEY).\n" +
          "The app and DMG in this run are signed and notarized but the updater\n" +
          `${CONF.productName}.app.tar.gz.sig is MISSING. Do not publish the auto-update\n` +
          "manifest from this build.",
      );
    }
  };
  bundleStep("dmg");
  bundleStep("app");
} else {
  run("pnpm", ["tauri", "build", "--bundles", "dmg"]);
  run("pnpm", ["tauri", "bundle", "--bundles", "app"]);
}

// 3. Re-sign the sidecars WITHOUT entitlements, then re-sign the app WITH them.
const sidecars = (CONF.bundle.externalBin ?? []).map((p) => p.replace(/^binaries\//, ""));
for (const bin of sidecars) {
  const path = join(APP, "Contents/MacOS", bin);
  if (!existsSync(path)) {
    console.error(`sidecar not found in the app bundle: ${bin}`);
    process.exit(1);
  }
  codesign(path);
}
// The app is signed WITHOUT `src-tauri/entitlements.plist`, which is now an
// empty dict on purpose. That file used to carry `keychain-access-groups`, and on
// macOS 26 that restricted entitlement made the app unlaunchable
// (`Launchd job spawn failed`, NSPOSIXErrorDomain 163) even with an embedded
// development profile, a matching certificate and the profile's own
// application-identifier entitlement. It granted nothing: the Touch ID provider
// sets no access group, so its items already live in the default group, which is
// the identifier the entitlement named. Reintroducing it needs a Developer ID
// provisioning profile with Keychain Sharing, not another entitlement edit.
codesign(APP);

run("codesign", ["--verify", "--verbose=2", "--deep", APP]);

// 4. Rebuild the DMG from the fixed app using Tauri's own script (the chrome, the
//    background art and the Finder layout come from there, not from hdiutil).
const dmgConf = CONF.bundle.macOS.dmg;
const arch = TARGET === "universal-apple-darwin"
  ? "universal"
  : process.arch === "arm64"
    ? "aarch64"
    : "x64";
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
run("codesign", ["--force", "--timestamp", "--sign", ID, dmgPath]);

// 6. Notarize the app and then the DMG, and staple BOTH. The app ticket is what
//    makes the installed copy launch on a machine that has never seen this build;
//    the DMG ticket is what makes the download itself open. The app is notarized
//    as a zip because notarytool does not take a directory, and it is notarized
//    BEFORE the DMG is rebuilt so the staple travels inside it.
if (process.env.MYNE_SKIP_NOTARIZE === "1") {
  console.error("\nMYNE_SKIP_NOTARIZE=1: the DMG is signed but NOT notarized. Never upload it.");
} else {
  const zipPath = join(BUNDLE, "macos", `${CONF.productName}.app.zip`);
  rmSync(zipPath, { force: true });
  run("ditto", ["-c", "-k", "--keepParent", APP, zipPath]);
  notarize(zipPath);
  rmSync(zipPath, { force: true });
  // Staple the app BEFORE the DMG is rebuilt from it, so the image users
  // download contains a payload that validates offline on its own. Stapling it
  // afterwards would leave the ticket beside the image rather than inside it,
  // which passes a spot check here and fails the check that mounts the DMG.
  run("xcrun", ["stapler", "staple", APP]);
  run("xcrun", ["stapler", "validate", APP]);

  // Rebuild the DMG so the stapled ticket is inside the image users download.
  for (const stale of readdirSync(join(BUNDLE, "dmg"))) {
    if (stale === dmgName || stale.startsWith("rw.")) rmSync(join(BUNDLE, "dmg", stale), { force: true });
  }
  run(script, args, {
    cwd: join(BUNDLE, "macos"),
    env: { ...process.env, TAURI_BUNDLER_DMG_IGNORE_CI: "1" },
  });
  run("codesign", ["--force", "--timestamp", "--sign", ID, dmgPath]);
  notarize(dmgPath);
  run("xcrun", ["stapler", "staple", dmgPath]);
  run("xcrun", ["stapler", "validate", dmgPath]);
  run("spctl", ["--assess", "--type", "open", "--context", "context:primary-signature", "-vv", dmgPath]);
}

run("node", [join(ROOT, "scripts/check-macos-dmg.mjs"), dmgPath]);

console.log(`\nmacOS DMG ready: ${dmgPath}`);
