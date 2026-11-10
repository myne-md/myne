// @vitest-environment jsdom
//
// The manifest export flow (view-manifests task 8).
//
// Three things are pinned, and the middle one is the reason this exists: the
// bytes are written by the HOST with the shared canonical encoder, so the flow's
// only jobs are (a) name the file, (b) not write when the user backs out, and
// (c) say where it went without putting a directory on screen.
//
// The overwrite flag is asserted as `true` because the OS dialog's own "Replace"
// prompt is the consent (SYNC-2); passing `false` here would make every export to
// an existing filename fail with a refusal the user already answered.

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SavedView } from "../../src/lib/prefs";

const invoke = vi.hoisted(() => vi.fn());
const saveDialog = vi.hoisted(() => vi.fn());
const has = vi.hoisted(() => vi.fn());
const toast = vi.hoisted(() => vi.fn());

vi.mock("../../src/platform/core", () => ({ invoke }));
vi.mock("../../src/platform/dialog", () => ({ save: saveDialog }));
vi.mock("../../src/platform/capabilities", () => ({ has }));
vi.mock("../../src/components/toast/toastStore", () => ({ toast }));
vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));
vi.mock("../../src/i18n", () => ({
  default: {
    t: (key: string, vars?: Record<string, unknown>) =>
      vars === undefined ? key : `${key}:${JSON.stringify(vars)}`,
  },
}));

import {
  canExportViewManifest,
  exportViewManifest,
  manifestFilename,
} from "../../src/notes/exportViewManifest";

function view(over: Partial<SavedView> = {}): SavedView {
  return {
    id: "v1",
    name: "Reading list",
    view_type: "table",
    filters: { kind: "all" },
    version: 2,
    ...over,
  };
}

beforeEach(() => {
  invoke.mockReset().mockResolvedValue(undefined);
  saveDialog.mockReset();
  has.mockReset().mockReturnValue(true);
  toast.mockReset();
});

describe("manifestFilename", () => {
  it("derives a .myneview name from the view name", () => {
    expect(manifestFilename("Reading list")).toBe("Reading list.myneview");
  });

  it("sanitizes path separators, which the OS dialog does not own", () => {
    expect(manifestFilename("Notes/2026\\reading")).toBe("Notes_2026_reading.myneview");
  });

  it("falls back to the untitled wording for an unnamed view", () => {
    expect(manifestFilename("   ")).toBe("common.untitledview.myneview");
  });
});

describe("exportViewManifest", () => {
  it("writes through the host command with the dialog's path", async () => {
    saveDialog.mockResolvedValue("/home/someone/Reading list.myneview");

    await expect(exportViewManifest(view())).resolves.toBe("saved");

    expect(invoke).toHaveBeenCalledWith("plugin:prefs|export_view_manifest", {
      view: view(),
      targetPath: "/home/someone/Reading list.myneview",
      overwrite: true,
    });
  });

  it("writes nothing when the dialog is dismissed", async () => {
    saveDialog.mockResolvedValue(null);

    await expect(exportViewManifest(view())).resolves.toBe("cancelled");

    expect(invoke).not.toHaveBeenCalled();
    expect(toast).not.toHaveBeenCalled();
  });

  it("reports the filename, never the directory, on success", async () => {
    saveDialog.mockResolvedValue("/home/someone/private/dir/Reading list.myneview");

    await exportViewManifest(view());

    const call = toast.mock.calls[0][0] as { message: string; variant: string };
    expect(call.variant).toBe("success");
    expect(call.message).toContain("Reading list.myneview");
    expect(call.message).not.toContain("/home/someone");
  });

  it("says one plain sentence when the write is refused, and reports failed", async () => {
    saveDialog.mockResolvedValue("/home/someone/Reading list.myneview");
    invoke.mockRejectedValue({ kind: "io_failure" });

    await expect(exportViewManifest(view())).resolves.toBe("failed");

    const call = toast.mock.calls[0][0] as { message: string; variant: string };
    expect(call.variant).toBe("error");
    expect(call.message).toBe("notes.viewSettings.exportFailed");
  });

  it("is unavailable where the host has no path-taking save dialog", async () => {
    has.mockReturnValue(false);

    expect(canExportViewManifest()).toBe(false);
    await expect(exportViewManifest(view())).resolves.toBe("failed");
    expect(saveDialog).not.toHaveBeenCalled();
  });
});
