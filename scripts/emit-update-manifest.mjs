#!/usr/bin/env node
// Emit a Tauri static-endpoint update manifest (`latest.json` / `latest-beta.json`)
// from a descriptor that names, per platform target, the artifact URL and the
// path to its detached `.sig` file.
//
// Why a separate step and not `tauri build` alone: the signing key is held
// offline and outside CI (TB8), so the artifact and its signature are produced
// in a build/sign pass, and this script only ASSEMBLES the manifest the updater
// reads. It never touches the key.
//
// Why a descriptor rather than inferring names from the bundler output: the
// emitted artifact names come from the bundler and drift with it (macOS
// `.app.tar.gz`, Windows `-setup.exe` / `.msi`, Linux `.AppImage`). Rather than
// guess a name in a script that would then be wrong silently, the release
// procedure names each target's artifact and its `.sig`, and this script
// validates what it is given.
//
// Usage:
//   node scripts/emit-update-manifest.mjs --channel stable --descriptor desc.json --out latest.json
//
// Descriptor shape:
//   {
//     "version": "0.10.0",
//     "notes": "Optional release notes.",
//     "pub_date": "2026-10-07T00:00:00Z",           // optional, RFC 3339
//     "platforms": {
//       "darwin-aarch64": { "url": "https://…/Myne.app.tar.gz", "sig_file": "/path/x.sig" },
//       "windows-x86_64": { "url": "https://…/Myne_0.10.0_x64-setup.exe", "sig_file": "/path/y.sig" },
//       "linux-x86_64":   { "url": "https://…/Myne_0.10.0_amd64.AppImage", "sig_file": "/path/z.sig" }
//     }
//   }
//
// The `.sig` file holds the base64 signature the Tauri bundler wrote beside the
// artifact. Its content is inlined verbatim as `signature`, which is what
// `tauri-plugin-updater` expects (a path or URL does not work).

import { readFileSync, writeFileSync } from "node:fs";

/** The manifest file name for a channel. `stable` is the default. */
export function manifestFilename(channel) {
  if (channel === "stable") return "latest.json";
  if (channel === "beta") return "latest-beta.json";
  throw new Error(`unknown channel: ${channel} (expected "stable" or "beta")`);
}

/** `OS-ARCH`, the key `tauri-plugin-updater` matches a platform against. */
const TARGET_RE = /^(darwin|windows|linux)-(x86_64|aarch64|i686|armv7)$/;

/**
 * Build the manifest object from a descriptor, using `read` to load each
 * `.sig` file (injected so a test does not touch the filesystem).
 *
 * Fails loudly on a missing/empty platform set, a bad target key, an empty URL,
 * or an empty signature: a manifest that is silently missing a platform would
 * stop that platform updating with nothing reporting why.
 */
export function buildManifest(descriptor, read = (p) => readFileSync(p, "utf8")) {
  if (typeof descriptor?.version !== "string" || descriptor.version.length === 0) {
    throw new Error("descriptor.version must be a non-empty string");
  }
  const platforms = descriptor.platforms;
  if (platforms === null || typeof platforms !== "object" || Object.keys(platforms).length === 0) {
    throw new Error("descriptor.platforms must be a non-empty object");
  }
  const out = {};
  for (const [target, entry] of Object.entries(platforms)) {
    if (!TARGET_RE.test(target)) {
      throw new Error(`platform key "${target}" is not OS-ARCH (e.g. darwin-aarch64)`);
    }
    if (typeof entry?.url !== "string" || entry.url.length === 0) {
      throw new Error(`platform "${target}" is missing a url`);
    }
    if (typeof entry.sig_file !== "string" || entry.sig_file.length === 0) {
      throw new Error(`platform "${target}" is missing sig_file`);
    }
    const signature = read(entry.sig_file).trim();
    if (signature.length === 0) {
      throw new Error(`platform "${target}" signature file is empty`);
    }
    out[target] = { signature, url: entry.url };
  }
  const manifest = { version: descriptor.version, platforms: out };
  if (typeof descriptor.notes === "string" && descriptor.notes.length > 0) {
    manifest.notes = descriptor.notes;
  }
  if (typeof descriptor.pub_date === "string" && descriptor.pub_date.length > 0) {
    manifest.pub_date = descriptor.pub_date;
  }
  return manifest;
}

function main(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 2) {
    const key = argv[i]?.replace(/^--/, "");
    if (key) args[key] = argv[i + 1];
  }
  const channel = args.channel ?? "stable";
  const outName = args.out ?? manifestFilename(channel);
  if (!args.descriptor) {
    console.error("emit-update-manifest: --descriptor <path> is required");
    process.exit(2);
  }
  const descriptor = JSON.parse(readFileSync(args.descriptor, "utf8"));
  const manifest = buildManifest(descriptor);
  writeFileSync(outName, JSON.stringify(manifest, null, 2) + "\n");
  console.log(
    `emit-update-manifest: wrote ${outName} (${channel}, ${Object.keys(manifest.platforms).length} platform(s))`,
  );
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main(process.argv.slice(2));
}
