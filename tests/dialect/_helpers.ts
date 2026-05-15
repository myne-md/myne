import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

export const FIXTURE_ROOT = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "../fixtures/dialect",
);

export function fixtureDir(category: string): string {
  return path.join(FIXTURE_ROOT, category);
}

export function readFixture(category: string, file: string): string {
  return fs.readFileSync(path.join(FIXTURE_ROOT, category, file), "utf-8");
}

export function listFixtureBasenames(category: string): string[] {
  return fs
    .readdirSync(path.join(FIXTURE_ROOT, category))
    .filter((f) => f.endsWith(".md"))
    .map((f) => f.replace(/\.md$/, ""))
    .sort();
}

export const enc = new TextEncoder();
export const dec = new TextDecoder();

export function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}
