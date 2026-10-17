import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  buildManifest,
  manifestFilename,
  outputNames,
} from "../../scripts/emit-update-manifest.mjs";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const SCRIPT = join(REPO_ROOT, "scripts", "emit-update-manifest.mjs");

describe("emit-update-manifest", () => {
  it("writes BOTH documents from one descriptor through the CLI", () => {
    // The unit below pins the decision; this drives the command the runbook
    // tells a maintainer to run, in a directory of its own, and reads the two
    // files back. A release that publishes one document is the v0.10.0 failure.
    const dir = mkdtempSync(join(tmpdir(), "emit-manifest-"));
    try {
      const sig = join(dir, "Myne.app.tar.gz.sig");
      writeFileSync(sig, "c2ln\n");
      const descriptor = join(dir, "descriptor.json");
      writeFileSync(
        descriptor,
        JSON.stringify({
          version: "0.10.0",
          platforms: {
            "darwin-aarch64": {
              url: "https://downloads.myne.md/releases/v0.10.0/Myne.app.tar.gz",
              sig_file: sig,
            },
          },
        }),
      );
      const run = (args: string[]) =>
        execFileSync(process.execPath, [SCRIPT, ...args], { cwd: dir, encoding: "utf8" });

      const output = run(["--channel", "both", "--descriptor", descriptor]);
      expect(output).toContain("latest.json and latest-beta.json");

      const stable = readFileSync(join(dir, "latest.json"), "utf8");
      const beta = readFileSync(join(dir, "latest-beta.json"), "utf8");
      expect(beta).toBe(stable);
      expect(JSON.parse(stable).version).toBe("0.10.0");

      // `--out` names one file, so the pair is refused rather than one document
      // being written under the other channel's name.
      expect(() =>
        run(["--channel", "both", "--descriptor", descriptor, "--out", "somewhere.json"]),
      ).toThrow();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("names the manifest per channel", () => {
    expect(manifestFilename("stable")).toBe("latest.json");
    expect(manifestFilename("beta")).toBe("latest-beta.json");
    expect(() => manifestFilename("nightly")).toThrow();
  });

  it("writes both channels from one descriptor for a normal release", () => {
    // The publishing half of decisions/clients/0701: a stable release is
    // offered to beta installs too. v0.10.0 shipped one manifest only, and
    // every beta install was left reporting "you are up to date".
    expect(outputNames("both", undefined)).toEqual(["latest.json", "latest-beta.json"]);
  });

  it("refuses --out with --channel both rather than writing one file twice", () => {
    // Silently honouring --out would publish one document under a name the
    // other channel reads and nothing would report it.
    expect(() => outputNames("both", "latest.json")).toThrow(/cannot be combined with --out/);
  });

  it("keeps the single-channel shape unchanged, including an explicit --out", () => {
    expect(outputNames("stable", undefined)).toEqual(["latest.json"]);
    expect(outputNames("beta", undefined)).toEqual(["latest-beta.json"]);
    expect(outputNames("beta", "/tmp/other.json")).toEqual(["/tmp/other.json"]);
    expect(() => outputNames("nightly", undefined)).toThrow(/unknown channel/);
  });

  it("inlines each signature, trimmed, and keeps the OS-ARCH keys", () => {
    const sigs: Record<string, string> = {
      "/a.sig": "SIGA",
      "/b.sig": " SIGB\n",
    };
    const manifest = buildManifest(
      {
        version: "0.10.0",
        notes: "Notes.",
        pub_date: "2026-10-07T00:00:00Z",
        platforms: {
          "darwin-aarch64": { url: "https://x/Myne.app.tar.gz", sig_file: "/a.sig" },
          "windows-x86_64": { url: "https://x/setup.exe", sig_file: "/b.sig" },
        },
      },
      (p: string) => sigs[p],
    );
    expect(manifest).toEqual({
      version: "0.10.0",
      notes: "Notes.",
      pub_date: "2026-10-07T00:00:00Z",
      platforms: {
        "darwin-aarch64": { signature: "SIGA", url: "https://x/Myne.app.tar.gz" },
        "windows-x86_64": { signature: "SIGB", url: "https://x/setup.exe" },
      },
    });
  });

  it("omits notes and pub_date when absent", () => {
    const manifest = buildManifest(
      { version: "1.0.0", platforms: { "linux-x86_64": { url: "u", sig_file: "s" } } },
      () => "sig",
    ) as { notes?: unknown; pub_date?: unknown };
    expect(manifest.notes).toBeUndefined();
    expect(manifest.pub_date).toBeUndefined();
  });

  it("rejects a missing version, an empty platform set, a bad target, and an empty signature", () => {
    expect(() => buildManifest({ platforms: {} }, () => "s")).toThrow(/version/);
    expect(() => buildManifest({ version: "1.0.0", platforms: {} }, () => "s")).toThrow(/non-empty/);
    expect(() =>
      buildManifest(
        { version: "1.0.0", platforms: { "macos-arm": { url: "u", sig_file: "s" } } },
        () => "s",
      ),
    ).toThrow(/OS-ARCH/);
    expect(() =>
      buildManifest(
        { version: "1.0.0", platforms: { "darwin-aarch64": { url: "u", sig_file: "s" } } },
        () => "   ",
      ),
    ).toThrow(/empty/);
  });
});
