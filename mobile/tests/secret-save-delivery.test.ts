// Which delivery the save message names (myne-md/myne#504, myne-md/myne#505).
//
// `saveSecretToDocuments` used to answer `"Documents/<file>"` on both platforms
// and the flow rendered it verbatim as "Saved to Documents/myne-recovery-phrase.txt".
// That answer was wrong twice over. On iOS the folder is not in the Files app at
// all: the app declares no `UIFileSharingEnabled` and no
// `LSSupportsOpeningDocumentsInPlace` in either `Info.ios.plist` or the generated
// plist. On Android it is `Android/data/<pkg>/files/Documents`, which the system
// Files app has refused to enter since API 30, and Android had no chooser to
// make up for it, so the answer named a place the user could not reach and
// pointed at no way out of it (myne-md/myne#505).
//
// Since #505 both platforms present a chooser, so NO platform's delivery can be
// described as a path the user can open: iOS's share sheet, Android's Storage
// Access Framework picker. The write is identical on both and is NOT what these
// assert. The write was never the defect. What they assert is the CLAIM: one
// sentence for a platform the app could identify, and a weaker one for a probe
// that failed.

import { beforeEach, describe, expect, it, vi } from "vitest";

const invoke = vi.fn();
const devicePlatform = vi.fn();
const shareFile = vi.fn(async () => {});

vi.mock("../src/platform/core", () => ({ invoke: (...a: unknown[]) => invoke(...a) }));
// The seam is one host call (myne#517), not a pair of path accessors: the
// destination, the directory it lives in and the backup exclusion all come back
// from `plugin:export-dir|export_path`. The mock returns values the old
// hard-coded `Documents/${filename}` could not produce, so an assertion built on
// them means something (`dir`/`name` are the host's answer and nothing here reads
// them any more, but the shape stays the real one).
vi.mock("../src/platform/path", () => ({
  exportPath: async (filename: string) => ({
    path: `/vault-exports/${filename}`,
    dir: "Files",
    name: `sanitized-${filename}`,
  }),
}));
vi.mock("../src/lib/share", () => ({ shareFile: (...a: unknown[]) => shareFile(...a) }));
vi.mock("../src/lib/prefs", () => ({ devicePlatform: () => devicePlatform() }));
vi.mock("../src/lib/vault-creation-logging", () => ({ logErrorKind: () => {} }));
// The copy half of this module is not under test here, and its transitive
// `@myne/clipboard` import pulls a package this spec has no reason to resolve.
vi.mock("../src/lib/clipboardTransport", () => ({ writeSecret: async () => {} }));
vi.mock("@myne/clipboard", () => ({ copySecret: async () => null }));

import { saveSecretToDocuments } from "../src/lib/secret-export";

beforeEach(() => {
  invoke.mockReset().mockResolvedValue(undefined);
  shareFile.mockClear();
  devicePlatform.mockReset();
});

describe("saveSecretToDocuments names the delivery the platform performed", () => {
  it("on iOS says the file is reachable through the share sheet", async () => {
    devicePlatform.mockResolvedValue("ios");
    const outcome = await saveSecretToDocuments("myne-recovery-phrase.txt", "w1 w2");
    expect(outcome).toEqual({ kind: "shared" });
  });

  it("on Android now says the same, because it has a chooser too (myne#505)", async () => {
    // This test used to assert the opposite, and the reason it flipped is the
    // whole change: Android's arm of `share_file.rs` was a documented no-op, so
    // naming the file's location was the only useful thing left to say. It is
    // no longer true that there is nowhere to say it went.
    devicePlatform.mockResolvedValue("android");
    const outcome = await saveSecretToDocuments("myne-recovery-phrase.txt", "w1 w2");
    expect(outcome).toEqual({ kind: "shared" });
  });

  it("writes and shares identically on both, so only the claim differs", async () => {
    devicePlatform.mockResolvedValue("android");
    await saveSecretToDocuments("myne-account-number.txt", "MY-1234");
    // The path is the HOST's answer, verbatim. Asserting a path this test could
    // have composed itself would be asserting the mock again.
    expect(invoke).toHaveBeenCalledWith("plugin:secret-export|save_secret_text", {
      path: "/vault-exports/myne-account-number.txt",
      contents: "MY-1234",
    });
    // The chooser is offered on Android exactly as on iOS: the line that was
    // missing before #505, and the one the whole issue is about.
    expect(shareFile).toHaveBeenCalledWith("/vault-exports/myne-account-number.txt");
  });

  it("claims nothing at all when the platform probe fails", async () => {
    // A failed probe gets its OWN outcome rather than the smaller of the two
    // real ones: `"shared"` asserts a chooser was offered, and the probe that
    // would have established the platform never answered. The write is the only
    // thing this arm witnessed.
    devicePlatform.mockRejectedValue(new Error("no prefs"));
    const outcome = await saveSecretToDocuments("myne-recovery-phrase.txt", "w1 w2");
    expect(outcome).toEqual({ kind: "written" });
  });

  it("keeps the two outcomes distinct, which is what the union is for", async () => {
    // Stated as one comparison, because each case reads plausibly alone. One is
    // a CLAIM about where a plaintext recovery phrase can be reached, on a
    // screen that never shows the value again; the other says only that the file
    // was written. Collapsing them makes the claim on a device nobody asked.
    devicePlatform.mockResolvedValue("android");
    const known = await saveSecretToDocuments("a.txt", "x");
    devicePlatform.mockRejectedValue(new Error("no prefs"));
    const unknown = await saveSecretToDocuments("a.txt", "x");
    expect(new Set([known?.kind, unknown?.kind]).size).toBe(2);
  });

  it("still reports failure as null when the write itself rejects", async () => {
    devicePlatform.mockResolvedValue("android");
    invoke.mockRejectedValue(new Error("io"));
    expect(await saveSecretToDocuments("myne-recovery-phrase.txt", "w1 w2")).toBeNull();
    expect(shareFile).not.toHaveBeenCalled();
  });
});
