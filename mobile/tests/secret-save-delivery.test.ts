// Which delivery the save message names (myne-md/myne#504).
//
// `saveSecretToDocuments` used to answer `"Documents/<file>"` on both platforms
// and the flow rendered it verbatim as "Saved to Documents/myne-recovery-phrase.txt".
// On iOS that folder is not in the Files app at all: the app declares no
// `UIFileSharingEnabled` and no `LSSupportsOpeningDocumentsInPlace` in either
// `Info.ios.plist` or the generated plist. The share sheet is the only route to
// the file, so a user who dismissed it held a success message naming a location
// that does not exist for them, for the one file that is never shown again
// (`recovery-flow.md` §2.4).
//
// The write is identical on both platforms and is NOT what changed. What changed
// is the claim, so that is what these assert: the same successful write, two
// different true sentences.

import { beforeEach, describe, expect, it, vi } from "vitest";

const invoke = vi.fn();
const devicePlatform = vi.fn();
const shareFile = vi.fn(async () => {});

vi.mock("../src/platform/core", () => ({ invoke: (...a: unknown[]) => invoke(...a) }));
vi.mock("../src/platform/path", () => ({
  documentDir: async () => "/app/Documents",
  join: async (...parts: string[]) => parts.join("/"),
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
  it("on iOS says the file is reachable only through the share sheet", async () => {
    devicePlatform.mockResolvedValue("ios");
    const outcome = await saveSecretToDocuments("myne-recovery-phrase.txt", "w1 w2");
    expect(outcome).toEqual({ kind: "shared" });
  });

  it("on Android keeps the path, because there the write IS the delivery", async () => {
    // The other direction, and it is what stops the fix from being "say less
    // everywhere": on Android the share sheet is the documented no-op
    // (`share_file.rs`), so naming the file's location is the only useful thing
    // the message can do.
    devicePlatform.mockResolvedValue("android");
    const outcome = await saveSecretToDocuments("myne-recovery-phrase.txt", "w1 w2");
    expect(outcome).toEqual({ kind: "path", label: "Documents/myne-recovery-phrase.txt" });
  });

  it("writes and shares identically on both, so only the claim differs", async () => {
    devicePlatform.mockResolvedValue("ios");
    await saveSecretToDocuments("myne-account-number.txt", "MY-1234");
    expect(invoke).toHaveBeenCalledWith("plugin:secret-export|save_secret_text", {
      path: "/app/Documents/myne-account-number.txt",
      contents: "MY-1234",
    });
    expect(shareFile).toHaveBeenCalledWith("/app/Documents/myne-account-number.txt");
  });

  it("falls back to the claim-less wording when the platform probe fails", async () => {
    // Unknown platform resolves to the iOS sentence on purpose: it names no
    // location, so it cannot name a wrong one. The opposite default would print
    // a path that may be unreachable.
    devicePlatform.mockRejectedValue(new Error("no prefs"));
    const outcome = await saveSecretToDocuments("myne-recovery-phrase.txt", "w1 w2");
    expect(outcome).toEqual({ kind: "shared" });
  });

  it("still reports failure as null when the write itself rejects", async () => {
    devicePlatform.mockResolvedValue("android");
    invoke.mockRejectedValue(new Error("io"));
    expect(await saveSecretToDocuments("myne-recovery-phrase.txt", "w1 w2")).toBeNull();
    expect(shareFile).not.toHaveBeenCalled();
  });
});
