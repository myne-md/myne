#!/usr/bin/env node
// Icon asset-check — the folded MYND-128 deliverable (SYNC-19;
// e2e-harness task 8). Structural, zero-dependency, CI-runnable:
//
//   1. Every expected variant exists in src-tauri/icons/ with the
//      correct pixel dimensions (PNG IHDR parsed directly).
//   2. tauri.conf.json's bundle.icon array ↔ files coherent.
//   3. NONE of the known Tauri-default icon hashes (extracted from
//      git history at 9fb4c00^, the pre-branding state) are present.
//   4. icon-source.svg matches its pinned hash — the ONLY pinned
//      hash (the rendered variants regenerate via `pnpm tauri icon`;
//      the master changes only deliberately). Re-pin at the
//      brand-final mark replacement (agent-tooling/docs/design/README.md).
//
// OS-shell rendering (Dock, Start menu, launcher) is structurally
// unreachable from any script — those checks live in the MYND-92
// release-QA matrix by ratified decision (SYNC-11).

import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const ICONS = join(REPO, "src-tauri", "icons");

// The ONLY pinned hash (see header). Update deliberately:
//   shasum -a 256 src-tauri/icons/icon-source.svg
const ICON_SOURCE_SHA256 =
  "852a3af4b80527c16169a3e5d5aa32d9c51f86ea0c7e9610b5e734e090196e70";

// sha256 of every pre-branding Tauri default asset (git 9fb4c00^).
const TAURI_DEFAULT_HASHES = new Set([
  "19b4fec485db7df51a691fcce72a3dd6f983e754fc4262da7154e4a4c688f69e", // 128x128.png
  "6c7660390d65217fe8de0892862254f47aee77e0af7096c75b8bfe168c5403f7", // 128x128@2x.png
  "1c6782dc65c8111c12cbc1882a0fea5e71ab8e51b18da2ce9580f5c88860ed02", // 32x32.png
  "54f7a0f58c96a4b023c1edc4b53fc443e27dace50e345f6936fa29bc20f785ca", // Square107
  "fec1e2080ca73cd4c4a123b23b1cd364059a8a8efeba3076e21dfefed390693b", // Square142
  "65fb570cb0e61ffce02ad67784cb200a0bf058400300980a46fa0d0c8f43a77a", // Square150
  "ea0b7c5d4b1d1ab9c91d2f7c9b069c8dfbf4557b0649a5777d47332cde610262", // Square284
  "cc72279c41b4ed343e8db7e7541ceef7b6b23edaa83d4e7338421dfcb8d63c33", // Square30
  "9733a89c539115de3c49bd06720bfc99639d9a918f5df48a810e267cf3554119", // Square310
  "10be9840e58fb018eb9029601d42008e16c0c9cfa66b8f9467fee94f600160d4", // Square44
  "2937fc83324cd9a1fddcfefd5927c791af31996a6840bfb3e2f1d578ad4129de", // Square71
  "12aed0e7ee06cb631427dc9da72c0c7ecf03857fbc4884d0c31f78314feb6c7f", // Square89
  "91a54024dd47230991546088f2e75d3e3199b3ccc9fe40f3f6b7d3bf1cbf7776", // StoreLogo
  "3dc10493b7de48a61de58f768f8a5708d3a44a068c148cedf0502b9b9b71ba5d", // icon.icns
  "392206b573a809997f3ff16fe68f456a52e931c372107eade9572b329bbe3321", // icon.ico
  "273cd669e07c455ad1c7c095890a37984652157cee73128a867300067dfb80e7", // icon.png
]);

// Expected PNG variants → pixel dimensions. Non-PNG containers
// (icns/ico/svg) are presence + non-default checked only.
const EXPECTED_PNGS = {
  "32x32.png": 32,
  "64x64.png": 64,
  "128x128.png": 128,
  "128x128@2x.png": 256,
  "icon.png": 512,
  "Square30x30Logo.png": 30,
  "Square44x44Logo.png": 44,
  "Square71x71Logo.png": 71,
  "Square89x89Logo.png": 89,
  "Square107x107Logo.png": 107,
  "Square142x142Logo.png": 142,
  "Square150x150Logo.png": 150,
  "Square284x284Logo.png": 284,
  "Square310x310Logo.png": 310,
  "StoreLogo.png": 50,
};
const EXPECTED_OTHER = ["icon.icns", "icon.ico", "icon-source.svg"];

const failures = [];
const ok = (msg) => console.log(`  ok  ${msg}`);
const fail = (msg) => {
  failures.push(msg);
  console.error(`FAIL  ${msg}`);
};

function sha256(buf) {
  return createHash("sha256").update(buf).digest("hex");
}

/** Parse PNG IHDR width/height (bytes 16..24 after the 8-byte sig). */
function pngSize(b) {
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  if (!b.subarray(0, 8).equals(sig)) return null;
  return { w: b.readUInt32BE(16), h: b.readUInt32BE(20) };
}

// 1 + 3. Variants present, correctly sized, never a Tauri default.
for (const [name, expected] of Object.entries(EXPECTED_PNGS)) {
  const path = join(ICONS, name);
  if (!existsSync(path)) {
    fail(`missing variant: ${name}`);
    continue;
  }
  const bytes = readFileSync(path);
  const size = pngSize(bytes);
  if (!size) {
    fail(`${name}: not a valid PNG`);
  } else if (size.w !== expected || size.h !== expected) {
    fail(`${name}: ${size.w}x${size.h}, expected ${expected}x${expected}`);
  } else {
    ok(`${name} ${size.w}x${size.h}`);
  }
  if (TAURI_DEFAULT_HASHES.has(sha256(bytes))) {
    fail(`${name}: matches a Tauri DEFAULT icon (branding regression)`);
  }
}
let iconSourceHash = null;
for (const name of EXPECTED_OTHER) {
  const path = join(ICONS, name);
  if (!existsSync(path)) {
    fail(`missing variant: ${name}`);
    continue;
  }
  const hash = sha256(readFileSync(path));
  if (name === "icon-source.svg") iconSourceHash = hash;
  if (TAURI_DEFAULT_HASHES.has(hash)) {
    fail(`${name}: matches a Tauri DEFAULT icon (branding regression)`);
  } else {
    ok(`${name} present, non-default`);
  }
}

// 2. bundle.icon ↔ files coherence.
const conf = JSON.parse(readFileSync(join(REPO, "src-tauri", "tauri.conf.json"), "utf8"));
for (const rel of conf.bundle?.icon ?? []) {
  const path = join(REPO, "src-tauri", rel);
  if (existsSync(path)) ok(`bundle.icon → ${rel}`);
  else fail(`bundle.icon references missing file: ${rel}`);
}

// 4. The single pinned hash: the master SVG (hashed once above).
if (iconSourceHash === ICON_SOURCE_SHA256) ok("icon-source.svg matches pinned hash");
else
  fail(
    `icon-source.svg hash drift: ${iconSourceHash} (pinned ${ICON_SOURCE_SHA256}). ` +
      "Deliberate master change? Re-pin here + regenerate variants via `pnpm tauri icon`.",
  );

if (failures.length > 0) {
  console.error(`\n${failures.length} icon check(s) failed.`);
  process.exit(1);
}
console.log("\nAll icon checks passed.");
