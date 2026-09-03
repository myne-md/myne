// @vitest-environment jsdom
//
// What the ingest-image-compression settings row CLAIMS, on the client where
// the claim is different (`ingest-image-compression`, PR-review I5).
//
// The preference and the transform have different reaches, and only one of them
// is universal:
//
//  * `attachment_compression_enabled` is shared vault content
//    (`decisions.md` 2026-07-30) — every client reads it, writes it and syncs
//    it, so a browser session turning it off turns it off for that user's
//    desktop. The control therefore ships everywhere.
//  * The transform does NOT run where a decoder panic cannot be contained.
//    `compress::is_supported_on_this_target` gates it off on `wasm32`, so the
//    `imageCompression` capability is absent on web.
//
// "Applies to the whole vault, on every device" is therefore false in front of
// the one client that will not honour it — and for a feature whose ethical
// justification is disclosure rather than consent, a settings row misdescribing
// what THIS client does is the wrong end to be loose at. Asserted from both
// sides: a branch tested on one side only is a branch that can be deleted.

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";

const hasMock = vi.fn((_cap: string) => true);
vi.mock("../../src/platform/capabilities", async (importOriginal) => {
  const real = await importOriginal<typeof import("../../src/platform/capabilities")>();
  return { ...real, has: (cap: string) => hasMock(cap) };
});

vi.mock("../../src/lib/prefs", async (importOriginal) => ({
  prefsRead: async () => ({ attachment_compression_enabled: true }),
  setAttachmentCompressionEnabled: async () => {},
  // The REAL derivation, not a copy of it. It is what decides whether a
  // stale view can claim a deletion (myne-md/myne#613), so a stub here would
  // test the stub, and a hand-copy would be one more place for the real one
  // to drift away from.
  mutationFrom: (await importOriginal<typeof import("../../src/lib/prefs")>()).mutationFrom,
}));

const { AttachmentCompressionSettings } = await import(
  "../../src/components/settings/AttachmentCompressionSettings"
);
// Resolved through the same catalog the component reads rather than pasted, so
// this pins the BRANCH; the wording itself is the catalog's business.
const i18n = (await import("../../src/i18n")).default;

const EVERY_DEVICE = "settings.attachmentCompression.helperScopeEveryDevice";
const NOT_HERE = "settings.attachmentCompression.helperScopeNotHere";

afterEach(() => {
  cleanup();
  hasMock.mockReset();
});

/** Render the row with `imageCompression` answered by `supported`. */
function renderRow(supported: boolean) {
  hasMock.mockImplementation((cap: string) => (cap === "imageCompression" ? supported : true));
  render(<AttachmentCompressionSettings />);
}

describe("the compression settings row's scope sentence", () => {
  it("claims every device where the transform actually runs on every device", () => {
    renderRow(true);
    const body = document.body.textContent ?? "";
    expect(body).toContain(i18n.t(EVERY_DEVICE));
    expect(body).not.toContain(i18n.t(NOT_HERE));
  });

  it("says the transform does not run here on a client that declines it", () => {
    renderRow(false);
    const body = document.body.textContent ?? "";
    expect(body).toContain(i18n.t(NOT_HERE));
    expect(body).not.toContain(i18n.t(EVERY_DEVICE));
  });

  it("keeps the irreversibility sentence on both clients", () => {
    // The half that is true everywhere, and the one fact a user flipping this
    // switch needs: the original bytes are not kept. A capability branch must
    // not be able to drop it.
    for (const supported of [true, false]) {
      renderRow(supported);
      expect(document.body.textContent).toContain(
        i18n.t("settings.attachmentCompression.helper"),
      );
      cleanup();
    }
  });

  it("keeps the control itself on both clients — the PREFERENCE is shared", () => {
    // Absent-not-disabled does not apply: the toggle governs the user's other
    // devices, so omitting it on web would remove a working control.
    for (const supported of [true, false]) {
      renderRow(supported);
      expect(screen.getByTestId("settings.attachment-compression")).toBeTruthy();
      cleanup();
    }
  });
});
