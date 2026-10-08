import { describe, expect, it } from "vitest";
import { buildManifest, manifestFilename } from "../../scripts/emit-update-manifest.mjs";

describe("emit-update-manifest", () => {
  it("names the manifest per channel", () => {
    expect(manifestFilename("stable")).toBe("latest.json");
    expect(manifestFilename("beta")).toBe("latest-beta.json");
    expect(() => manifestFilename("nightly")).toThrow();
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
