#!/usr/bin/env node
// The macOS release DMG actually carries its install chrome (issues #194/#195).
//
// The failure this prevents is a PROCESS regression, not a config one, and that
// is exactly why nothing else catches it. `src-tauri/tauri.conf.json`'s
// `bundle.macOS.dmg` block is correct and always has been; Tauri's bundler
// honours it and additionally passes `--volicon`, so a DMG built by
// `tauri build --bundles dmg` comes out with the background, the icon
// positions, the `Applications` drop target and a branded volume icon. What
// shipped in v0.1.0 instead was a hand-rolled
//
//     hdiutil create -volname Myne -srcfolder .../Myne.app -ov out.dmg
//
// from the release runbook — `-srcfolder` pointed straight at the `.app`, so
// the volume held that one item and nothing else. The user got a bare Finder
// window with no way to drag the app into /Applications, and a generic disk
// icon in the sidebar. Every input to that outcome was green: the config is
// right, the assets exist, `tauri build` is not even in the failing path, and
// the artifact is a valid, mountable, correctly-signed disk image.
//
// So the check has to run against the BUILT ARTIFACT, and it has to look past
// "the file exists" at whether Finder was actually told about it:
//
//   1. `<productName>.app` at the volume root                — the payload
//   2. `Applications` symlink → /Applications                — the drag target
//   3. `.background/<configured basename>`                   — the art, copied
//   4. `.DS_Store` referencing that art + an `icvp` record   — the art, APPLIED
//   5. `.VolumeIcon.icns` with an `icnC` creator             — the volume icon
//   6. the volume's kHasCustomIcon FinderInfo bit            — the icon, APPLIED
//
// 4 and 6 are the load-bearing ones. `bundle_dmg.sh` copies the background file
// and writes `.VolumeIcon.icns` BEFORE it runs the AppleScript that makes Finder
// commit either of them, and it skips that AppleScript entirely under
// `--skip-jenkins` (which tauri-bundler passes whenever it sees CI, unless
// `TAURI_BUNDLER_DMG_IGNORE_CI` is set). A DMG that fails only 4 and 6 has every
// asset in place and still opens bare — the precise shape of #194.
//
// Note what is deliberately NOT checked: a custom icon on the `.dmg` FILE
// itself. That lives in the file's resource fork, and no HTTP download carries
// an xattr, so a DMG fetched from a release page shows the generic disk-image
// icon no matter what we write locally. The volume icon (5, 6) is inside the
// image's own filesystem and is the only one that survives distribution.
//
// macOS-only by nature (it mounts an HFS+/APFS image); skips cleanly elsewhere,
// which is why CI's Linux runner can call it unconditionally.
//
// Zero dependencies, hand-runnable:
//   node scripts/check-macos-dmg.mjs ~/.cargo/shared-target/.../Myne_0.1.0_aarch64.dmg

import { execFileSync } from "node:child_process";
import { existsSync, lstatSync, mkdtempSync, readFileSync, readlinkSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const dmgPath = process.argv[2];
if (!dmgPath) {
  console.error("usage: node scripts/check-macos-dmg.mjs <path-to.dmg>");
  process.exit(2);
}

if (process.platform !== "darwin") {
  console.log(`macOS DMG chrome: skipped (platform ${process.platform}, needs darwin to mount)`);
  process.exit(0);
}

if (!existsSync(dmgPath)) {
  console.error(`macOS DMG chrome: FAILED\n  - no such file: ${dmgPath}`);
  process.exit(1);
}

const conf = JSON.parse(readFileSync(join(REPO, "src-tauri", "tauri.conf.json"), "utf8"));
const appName = `${conf.productName}.app`;
const dmgConf = conf.bundle?.macOS?.dmg ?? {};
/** Basename only — `bundle_dmg.sh` copies the art to `.background/<basename>`. */
const backgroundName = dmgConf.background ? dmgConf.background.split("/").pop() : null;

const failures = [];
const fail = (message) => failures.push(message);
const ok = (message) => console.log(`  ok   ${message}`);

/** kHasCustomIcon lives at FinderInfo bytes 8-9 for both FInfo and DInfo. */
const K_HAS_CUSTOM_ICON = 0x0400;

/** Raw com.apple.FinderInfo bytes, or null when the attribute is absent. */
function finderInfo(path) {
  try {
    const hex = execFileSync("/usr/bin/xattr", ["-px", "com.apple.FinderInfo", path], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    return Buffer.from(hex.replace(/\s+/g, ""), "hex");
  } catch {
    return null;
  }
}

const mountPoint = mkdtempSync(join(tmpdir(), "myne-dmg-check-"));
let attached = false;
try {
  execFileSync(
    "/usr/bin/hdiutil",
    ["attach", dmgPath, "-readonly", "-nobrowse", "-noverify", "-mountpoint", mountPoint],
    { stdio: ["ignore", "ignore", "pipe"] },
  );
  attached = true;

  // 1. The payload.
  if (existsSync(join(mountPoint, appName))) ok(`${appName} at the volume root`);
  else fail(`${appName} missing from the volume root`);

  // 2. The drag target — plain `ln -s`, so its absence means the volume was
  //    never staged (the `hdiutil -srcfolder <app>` shape), not that Finder
  //    scripting failed.
  const appsLink = join(mountPoint, "Applications");
  if (!existsSync(appsLink) && !lstatSync(appsLink, { throwIfNoEntry: false })) {
    fail(
      "no `Applications` symlink — there is nothing to drag the app onto. " +
        "A DMG built by `hdiutil create -srcfolder <…>.app` always looks like this; " +
        "build it with `tauri build --bundles dmg` instead.",
    );
  } else {
    const stat = lstatSync(appsLink);
    if (!stat.isSymbolicLink()) fail("`Applications` exists but is not a symlink");
    else if (readlinkSync(appsLink) !== "/Applications")
      fail(`\`Applications\` points at ${readlinkSync(appsLink)}, expected /Applications`);
    else ok("`Applications` symlink → /Applications");
  }

  // 3 + 4. The background: copied, then actually committed to the window.
  if (backgroundName) {
    const artPath = join(mountPoint, ".background", backgroundName);
    if (existsSync(artPath)) ok(`.background/${backgroundName} present`);
    else fail(`.background/${backgroundName} missing (bundle.macOS.dmg.background is configured)`);

    const dsStorePath = join(mountPoint, ".DS_Store");
    if (!existsSync(dsStorePath)) {
      fail(
        "no `.DS_Store` — the window layout was never written, so Finder shows a " +
          "plain list regardless of what is in `.background/`.",
      );
    } else {
      const dsStore = readFileSync(dsStorePath);
      const hasIconView = dsStore.includes(Buffer.from("icvp", "ascii"));
      const namesTheArt =
        dsStore.includes(Buffer.from(backgroundName, "ascii")) ||
        dsStore.includes(Buffer.from(backgroundName, "utf16le").swap16());
      if (hasIconView && namesTheArt) ok(".DS_Store carries the icon-view layout + background");
      else
        fail(
          `.DS_Store is present but ${!hasIconView ? "has no `icvp` icon-view record" : `never names ${backgroundName}`}. ` +
            "This is the `--skip-jenkins` shape: the assets got copied, the AppleScript " +
            "that tells Finder about them did not run. Set TAURI_BUNDLER_DMG_IGNORE_CI=1 " +
            "if a CI environment variable is what suppressed it.",
        );
    }
  }

  // 5 + 6. The volume icon: written, then flagged.
  const volIcon = join(mountPoint, ".VolumeIcon.icns");
  if (!existsSync(volIcon)) {
    fail(
      "no `.VolumeIcon.icns` — the mounted volume falls back to the generic disk " +
        "glyph in the Finder sidebar. Tauri's bundler passes `--volicon` from " +
        "`bundle.icon`'s .icns automatically.",
    );
  } else {
    const info = finderInfo(volIcon);
    if (info && info.length >= 8 && info.subarray(4, 8).toString("ascii") === "icnC")
      ok(".VolumeIcon.icns present with an `icnC` creator");
    else fail(".VolumeIcon.icns is present but lacks the `icnC` creator (SetFile -c icnC)");

    const volInfo = finderInfo(mountPoint);
    const flags = volInfo && volInfo.length >= 10 ? volInfo.readUInt16BE(8) : 0;
    if (flags & K_HAS_CUSTOM_ICON) ok("volume carries the custom-icon flag");
    else
      fail(
        "the volume's kHasCustomIcon bit is not set, so Finder ignores " +
          "`.VolumeIcon.icns` and draws the generic disk icon anyway (SetFile -a C).",
      );
  }
} finally {
  if (attached) {
    try {
      execFileSync("/usr/bin/hdiutil", ["detach", mountPoint, "-quiet"], { stdio: "ignore" });
    } catch {
      // A busy volume (Finder, Spotlight) can refuse the first detach; force it
      // rather than leaving a stray mount behind.
      try {
        execFileSync("/usr/bin/hdiutil", ["detach", mountPoint, "-force", "-quiet"], {
          stdio: "ignore",
        });
      } catch {
        console.error(`  warn  could not unmount ${mountPoint} — detach it by hand`);
      }
    }
  }
  rmSync(mountPoint, { recursive: true, force: true });
}

if (failures.length > 0) {
  console.error(`\nmacOS DMG chrome: FAILED (${failures.length})`);
  for (const message of failures) console.error(`  - ${message}`);
  process.exit(1);
}
console.log(`\nmacOS DMG chrome: ok (${dmgPath})`);
