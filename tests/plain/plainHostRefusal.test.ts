// The zero-vault-IPC spec for the plain-file surface (myne-md/myne#788, task 8).
//
// The mechanism under test is behavioural, not structural: `src/editor-host.ts`
// installs ONE host for the window, and its vault-coupled members consult
// `src/plain/surfaceMode.ts` and answer emptily while the plain surface is
// active. This spec mocks the LEAF modules those members wrap, imports the real
// host so it installs itself, and then drives `getHost()` in both modes.
//
// The OFF phase is the positive control and it is load-bearing: without it the
// ON assertions would pass just as well against a host that never wired the
// leaves at all (a mock that is never reacheable from the tested path records
// zero calls no matter what the guard does). The pair is what proves the spies
// measure a live path that the mode then cuts.
//
// `warmAttachmentUrls` is mocked at `src/platform/attachments`, which is the
// module the host calls, because the wrapping member does not go through
// `src/lib/attachments`.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const prefsReadMock = vi.fn();
const tagTreeMock = vi.fn();
const spellCheckMock = vi.fn();
const catalogListMock = vi.fn();
const warmAttachmentUrlsMock = vi.fn();

vi.mock("../../src/lib/prefs", () => ({
  prefsRead: (...args: unknown[]) => prefsReadMock(...args),
}));

vi.mock("../../src/notes/vaultIndices", () => ({
  tagTree: (...args: unknown[]) => tagTreeMock(...args),
  isMediaTarget: () => false,
}));

vi.mock("../../src/lib/spell", () => ({
  spellCheck: (...args: unknown[]) => spellCheckMock(...args),
  addToPersonalDictionary: async () => undefined,
  ignoreWordInVault: async () => undefined,
}));

vi.mock("../../src/lib/attachments", () => ({
  attachmentExport: async () => undefined,
  attachmentRename: async () => undefined,
  attachmentReadText: async () => "",
  attachmentReadStructured: async () => null,
  attachmentImport: async () => ({ id: "unused" }),
  catalogList: (...args: unknown[]) => catalogListMock(...args),
}));

vi.mock("../../src/platform/attachments", () => ({
  warmAttachmentUrls: (...args: unknown[]) => warmAttachmentUrlsMock(...args),
}));

import { getHost } from "@myne/editor/host";
import type { ImportSource } from "@myne/editor/host";
import {
  isPlatformUnsupported,
  PlatformUnsupportedError,
} from "../../src/platform/unsupported";
import { setPlainSurfaceActive } from "../../src/plain/surfaceMode";
// Side-effect import: the REAL host installs itself over the inert stub
// `tests/setup-editor-host.ts` registered at setup time.
import "../../src/editor-host";

/** The exact answer `src/editor-host.ts` documents for the plain surface. */
const PLAIN_SURFACE_PREFS = {
  editor_content_width: null,
  editor_font_family: null,
  editor_line_spacing: null,
  editor_text_size: null,
  spell_enabled: false,
  spell_languages: [],
};

const VAULT_PREFS = {
  editor_content_width: 800,
  editor_font_family: "Inter",
  editor_line_spacing: 1.5,
  editor_text_size: 16,
  spell_enabled: true,
  spell_languages: ["en-US"],
};

const IMPORT_SOURCE: ImportSource = { kind: "bytes", bytes: [104, 105], filename: null };

describe("the editor host while the plain surface is active", () => {
  const host = getHost();

  beforeEach(() => {
    vi.resetAllMocks();
    setPlainSurfaceActive(false);
  });

  afterEach(() => {
    setPlainSurfaceActive(false);
    vi.resetAllMocks();
  });

  it("plain OFF: the vault-coupled members reach their leaf modules (positive control)", async () => {
    prefsReadMock.mockResolvedValue(VAULT_PREFS);
    tagTreeMock.mockResolvedValue([]);
    catalogListMock.mockResolvedValue([
      { id: "att-1", content_type: "text/markdown", filename: "a.md", size: 3 },
    ]);
    spellCheckMock.mockResolvedValue([]);

    await host.prefsRead();
    expect(prefsReadMock).toHaveBeenCalledTimes(1);

    await host.notes.tagTree();
    expect(tagTreeMock).toHaveBeenCalledTimes(1);

    const rows = await host.attachments.catalogList();
    expect(catalogListMock).toHaveBeenCalledTimes(1);
    expect(rows).toEqual([
      { id: "att-1", contentType: "text/markdown", filename: "a.md", size: 3 },
    ]);

    expect(host.attachments.warmRefs).toBeDefined();
    await host.attachments.warmRefs?.(["att-1"]);
    expect(warmAttachmentUrlsMock).toHaveBeenCalledWith(["att-1"]);

    // `spellCheck` is a desktop capability, so the block is installed; if it
    // were silently absent, the ON assertions below would skip the member.
    expect(host.spell).toBeDefined();
    await host.spell?.spellCheck(["teh"], ["en-US"]);
    expect(spellCheckMock).toHaveBeenCalledTimes(1);
  });

  it("plain ON: every ambient member answers emptily and the leaf is never reached", async () => {
    setPlainSurfaceActive(true);

    await expect(host.prefsRead()).resolves.toEqual(PLAIN_SURFACE_PREFS);
    expect(prefsReadMock).not.toHaveBeenCalled();

    await expect(host.notes.tagTree()).resolves.toEqual([]);
    expect(tagTreeMock).not.toHaveBeenCalled();

    await expect(host.attachments.catalogList()).resolves.toEqual([]);
    expect(catalogListMock).not.toHaveBeenCalled();

    const refusal = await host.attachments.import(IMPORT_SOURCE).then(
      () => {
        throw new Error("attachments.import resolved while the plain surface was active");
      },
      (err: unknown) => err,
    );
    expect(refusal).toBeInstanceOf(PlatformUnsupportedError);
    expect(isPlatformUnsupported(refusal)).toBe(true);
    expect((refusal as PlatformUnsupportedError).operation).toBe("core.invoke");

    await host.attachments.warmRefs?.(["att-1"]);
    expect(warmAttachmentUrlsMock).not.toHaveBeenCalled();

    await expect(host.spell?.spellCheck(["teh"], ["en-US"])).resolves.toEqual([]);
    expect(spellCheckMock).not.toHaveBeenCalled();
  });

  it("plain OFF after plain ON: the members answer from the vault again", async () => {
    setPlainSurfaceActive(true);
    await host.prefsRead();
    expect(prefsReadMock).not.toHaveBeenCalled();

    setPlainSurfaceActive(false);
    prefsReadMock.mockResolvedValue(VAULT_PREFS);
    await expect(host.prefsRead()).resolves.toEqual(VAULT_PREFS);
    expect(prefsReadMock).toHaveBeenCalledTimes(1);
  });
});
