// The floating-surface presentation the host declares.
//
// # What this pins that `tsc` cannot
//
// The seam member is OPTIONAL and its absence MEANS something: a host that omits
// it wants the anchored popover, which is what desktop and web want and what every
// host written before the member existed gets. So the interesting question is not
// "does the member typecheck" but "does one reader turn three states into two
// answers, and does the absent state land on anchored".
//
// A hand-written `getHost().floatingSurface ?? "anchored"` at each call site would
// answer the same way today and answer it differently the day a fourth state or a
// second default appears, so the reader is a single exported function and this
// spec drives all three inputs through it.
//
// The real clients are pinned separately, in `editor-host-capabilities.test.ts`:
// desktop and web must OMIT the member, because that omission is the anchored
// behaviour rather than an oversight.

import { afterEach, describe, expect, it } from "vitest";
import {
  floatingSurfacePresentation,
  setEditorHost,
  type EditorHost,
} from "@myne/editor/host";

/** The smallest host the seam accepts, so a spec can vary one member. */
function hostWith(patch: Partial<EditorHost>): EditorHost {
  return {
    t: (key: string) => key,
    notes: { tagTree: async () => [], isMediaTarget: () => false },
    attachments: {
      attachmentExport: async () => {},
      attachmentRename: async () => {},
      pickExportDestination: async () => null,
      import: async () => {
        throw new Error("spec host: attachments.import not installed");
      },
      catalogList: async () => [],
      resolveRef: (id: string) => `attachment://${id}`,
    },
    prefsRead: async () => ({
      editor_content_width: null,
      editor_font_family: null,
      editor_line_spacing: null,
      editor_text_size: null,
      spell_enabled: null,
      spell_languages: [],
    }),
    openExternal: () => {},
    clipboardWrite: async () => {},
    ...patch,
  };
}

afterEach(() => {
  // Leave the shared stub in the anchored state every other spec expects.
  setEditorHost(hostWith({ floatingSurface: "anchored" }));
});

describe("the floating-surface presentation reader", () => {
  it("answers anchored when the host omits the member", () => {
    setEditorHost(hostWith({}));
    expect(floatingSurfacePresentation()).toBe("anchored");
  });

  it("answers anchored when the host declares it explicitly", () => {
    setEditorHost(hostWith({ floatingSurface: "anchored" }));
    expect(floatingSurfacePresentation()).toBe("anchored");
  });

  it("answers docked when the host declares it", () => {
    setEditorHost(hostWith({ floatingSurface: "docked" }));
    expect(floatingSurfacePresentation()).toBe("docked");
  });
});
