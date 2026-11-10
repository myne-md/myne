#!/usr/bin/env node
// Build the macOS .app and a decorated .dmg with correctly signed sidecar binaries.
//
// Why this exists: Tauri signs every sign target, the Frameworks, the `externalBin`
// sidecars and the app itself, with the SAME `bundle.macOS.entitlements`. The app
// needs the restricted `com.apple.application-identifier` entitlement: every keychain
// write that carries an access control is refused `errSecMissingEntitlement` (-34018)
// without it, which is how the device signing key went a week without ever being
// stored (myne-md/myne#959). But a nested binary that carries a restricted
// entitlement is SIGKILLed by AMFI (exit 137), because the entitlement is authorized
// by the app's embedded provisioning profile and a sidecar has none. Stripping the
// entitlement from the sidecars fixes them, and re-signing the app re-seals the bundle.
//
// The app is re-signed WITH `src-tauri/entitlements.plist`, and that is the half a
// bare `codesign --force` silently drops: entitlements live inside the signature, so
// a re-sign that omits the flag ships an app that launches and then fails every ACL
// keychain write. Pass the file, and keep `bundle.macOS.files`' embedded profile.
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

import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync, rmSync, readdirSync } from "node:fs";
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

const codesign = (path, entitlements) =>
  run("codesign", [
    "--force",
    "--options",
    "runtime",
    "--timestamp",
    "--sign",
    ID,
    ...(entitlements ? ["--entitlements", entitlements] : []),
    path,
  ]);

const run = (cmd, args, opts = {}) =>
  execFileSync(cmd, args, { stdio: "inherit", cwd: ROOT, ...opts });

// macOS 27 hides a volume mounted with `-nobrowse` from Finder ENTIRELY, and
// `bundle_dmg.sh` mounts the nascent image that way before asking Finder, by the
// mount directory's name, to lay out the window. Finder answers
// `Can't get disk "dmg.XXXXXX" (-1728)` and the bundler deletes the image it just
// made, so the whole build ends after the compile and both signatures. On earlier
// macOS the flag only kept the volume off the Desktop and the same AppleScript
// resolved it.
//
// Proven rather than inferred: the same image mounted the same way without
// `-nobrowse` resolves, by the same name, in the same Finder (`tell application
// "Finder" to get name of disk "dmg.Zzq4YL"` prints the name; with `-nobrowse` it
// raises -1728), and a 15 second wait does not change the outcome, so this is not
// the timing race the script's own `-1728` workaround was written for.
//
// The script is REGENERATED by every `tauri bundle --bundles dmg`, so a patch
// applied beforehand is discarded. It is patched after Tauri writes it, and the
// patched copy is what steps 4 and 6 run.
const patchDmgScript = () => {
  const script = join(BUNDLE, "dmg", "bundle_dmg.sh");
  if (!existsSync(script)) return;
  const before = readFileSync(script, "utf8");
  const after = before.replace("-readwrite -noverify -noautoopen -nobrowse", "-readwrite -noverify -noautoopen");
  if (after === before) {
    console.log("bundle_dmg.sh: no `-nobrowse` attach to patch (already patched, or Tauri changed it)");
    return;
  }
  writeFileSync(script, after);
  console.log("bundle_dmg.sh: dropped `-nobrowse` from the attach, so Finder can reach the volume");
};

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
  // Tauri's DMG step both WRITES `bundle_dmg.sh` and runs it. On macOS 27 the run
  // always fails at the Finder layout step (see `patchDmgScript`), and every DMG in
  // this build is produced from the patched copy below, so that failure is tolerated
  // ONLY when it left the script behind. Anything else is a real failure.
  try {
    run("pnpm", ["tauri", "bundle", "--bundles", "dmg", ...TARGET_ARGS]);
  } catch (err) {
    if (!existsSync(join(BUNDLE, "dmg", "bundle_dmg.sh"))) throw err;
    console.error(
      "\nNOTE: Tauri's DMG run failed after writing bundle_dmg.sh (expected on macOS 27,\n" +
        "see patchDmgScript). The DMG is built from the patched script further down.\n",
    );
  }
  patchDmgScript();
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
// The app is signed WITH `src-tauri/entitlements.plist`: `com.apple.application-identifier`
// is what authorizes a keychain write that carries an access control, and macOS honors
// it only because `bundle.macOS.files` embeds the Developer ID provisioning profile
// that names it. The sidecars above are signed WITHOUT it for the reason in the
// header: AMFI SIGKILLs a nested binary carrying a restricted entitlement that has no
// profile of its own, and the symptom is a dead terminal client and dead Tor routing
// while the app itself launches.
//
// Measured, both directions (myne-md/myne#959): entitlement without the embedded
// profile and the app cannot launch (`Launchd job spawn failed`, NSPOSIXErrorDomain
// 163, while `codesign` verification still passes); profile embedded and entitlement
// absent and every ACL write returns -34018 with the UI falling back silently.
// A dev-signed build is the documented local escape (`MYNE_ALLOW_DEV_SIGNING=1`), and the
// embedded profile lists only the Developer ID certificate, so applying the restricted
// entitlement under a development signature is a bundle nothing authorizes. It stores no
// device key, which is the honest outcome for a build nobody should ship.
const devSigned =
  process.env.MYNE_ALLOW_DEV_SIGNING === "1" || ID_NAME.includes("Apple Development");
const appEntitlements = devSigned
  ? undefined
  : join(ROOT, "src-tauri", CONF.bundle.macOS.entitlements);
codesign(APP, appEntitlements);

run("codesign", ["--verify", "--verbose=2", "--deep", APP]);

// `codesign --verify` passes in BOTH broken states this change documents, so it is not
// evidence about either. Ask the signature itself, and ask the bundle for the profile that
// authorizes what it finds: the entitlement without a profile cannot launch at all
// (NSPOSIXErrorDomain 163), the profile without the entitlement silently stores no device
// key (-34018, so every head stays `0x02` and the phrase prompt returns), and an AMFI
// parser error makes `codesign` sign with NEITHER while still exiting 0.
if (!devSigned) {
  // `codesign -d` writes to stderr, so both streams are read.
  const probe = spawnSync("codesign", ["-d", "--entitlements", "-", APP], { encoding: "utf8" });
  const shown = `${probe.stdout ?? ""}${probe.stderr ?? ""}`;
  if (!shown.includes("com.apple.application-identifier")) {
    console.error(
      "the signed app carries no com.apple.application-identifier, so every keychain write\n" +
        "that carries an access control is refused (-34018) and no device signing key is\n" +
        "ever stored. Run `plutil -lint src-tauri/entitlements.plist` AND check that no XML\n" +
        "comment in it contains a double hyphen: AMFI rejects the file, `codesign` prints\n" +
        "AMFIUnserializeXML and signs without the entitlement anyway.",
    );
    process.exit(1);
  }
  if (!existsSync(join(APP, "Contents/embedded.provisionprofile"))) {
    console.error(
      "the app bundle carries no Contents/embedded.provisionprofile, so the restricted\n" +
        "entitlement is unauthorized and the app cannot launch at all\n" +
        "(Launchd job spawn failed, NSPOSIXErrorDomain 163). Check bundle.macOS.files.",
    );
    process.exit(1);
  }
}

// The updater payload was archived BEFORE the repair above, so the app inside it carries
// the restricted entitlement on its sidecars and no embedded profile: an in-place update
// would install a SIGKILLed CLI, MCP front-end and Tor sidecar while the app itself
// launched. Re-archive from the repaired bundle, and remove the now-stale signature rather
// than leave one that no longer matches these bytes.
const tarball = join(BUNDLE, "macos", `${CONF.productName}.app.tar.gz`);
if (existsSync(tarball)) {
  rmSync(tarball, { force: true });
  run("tar", ["-czf", tarball, "-C", join(BUNDLE, "macos"), `${CONF.productName}.app`]);
  rmSync(`${tarball}.sig`, { force: true });
  if (process.env.TAURI_SIGNING_PRIVATE_KEY) {
    // `--app-version` is not optional here. The client ships `requireSignedVersion: true`,
    // so its updater requires the signature's trusted comment to name the version it
    // signed. `tauri build` embeds that field itself, but a bare `signer sign` produces a
    // signature with no version at all: it verifies cryptographically, and the client then
    // rejects it AFTER the whole download with `MissingSignedVersion`, which the app shows
    // as "did not finish". v0.11.4 shipped exactly that for macOS because this call is the
    // one signer invocation the bundler does not make.
    run("pnpm", ["tauri", "signer", "sign", "--app-version", CONF.version, tarball]);
  } else {
    console.error(
      "\nWARNING: the updater archive was rebuilt from the repaired app, so its previous\n" +
        "signature was REMOVED and no new one could be made (no TAURI_SIGNING_PRIVATE_KEY).\n" +
        "Do not publish the auto-update manifest from this build.",
    );
  }
}

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
