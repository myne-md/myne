/**
 * Build notice gate: the artefact must carry the licence and both notices.
 *
 * `--rust` requires the generated Rust notice too; the web job can pass only
 * the default set because cargo lives in the rust/notices lane.
 */
import { existsSync, statSync } from "node:fs";
import { join } from "node:path";

const dist = join(process.cwd(), "dist");
const required = [];
if (process.argv.includes("--rust-only")) {
  required.push(["THIRD-PARTY-LICENSES-rust.txt", "Rust third-party notice"]);
} else {
  required.push(
    ["LICENSE", "root licence"],
    ["THIRD-PARTY-LICENSES.txt", "web third-party notice"],
  );
  if (process.argv.includes("--rust")) {
    required.push(["THIRD-PARTY-LICENSES-rust.txt", "Rust third-party notice"]);
  }
}

let failed = false;
for (const [file, label] of required) {
  const path = join(dist, file);
  if (!existsSync(path)) {
    console.error(`check-build-notices: missing ${path} (${label})`);
    failed = true;
    continue;
  }
  const size = statSync(path).size;
  if (size < 100) {
    console.error(`check-build-notices: ${path} is suspiciously small (${size} bytes)`);
    failed = true;
  } else {
    console.log(`check-build-notices: ${file} (${size} bytes)`);
  }
}
if (failed) process.exit(1);
console.log("check-build-notices: ok");
