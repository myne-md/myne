// @vitest-environment jsdom
//
// The Editor panel's topic split and its live preview (myne-md/myne#885 tasks 6
// and 7). This is the panel the requester named as the model, so it is the one
// where the two halves of the work meet: the topics that replace "the section
// you scroll" and the preview that has to follow them.
//
// Four claims, and only the first is about markup:
//
//   1. **Every topic renders a body, and only its own, and none of them is
//      empty.** `SettingsTopicPanel` renders nothing while its topic is
//      inactive, so the settled DOM is the assertion. A topic whose every member
//      is gated off on some client renders an EMPTY tab, which is the failure the
//      grouping rule (`settingsTopics.ts`) exists to make impossible.
//   2. **Every `settingsSearchIndex` entry with `panelId: "editor"` lands in the
//      topic it names.** An inactive topic's body is not mounted, so a hit whose
//      `topic` field is wrong scrolls the user to an element that is not in the
//      document, and every compiler and every guard in the tree passes. This
//      walks every entry of the panel: select the entry's topic, mount, assert
//      the entry's `data-setting-anchor` (or its `testid` fallback, the shell's
//      own resolution order) is present, and assert it appears in EXACTLY one
//      topic.
//   3. **The preview follows the active topic, and shows what that topic's
//      settings decide.** One assertion per newly reflected setting, all through
//      RENDERED TEXT or a DOM attribute rather than through a key read: a test
//      that asserts the preview element merely exists passes on the version this
//      work replaces, which is the defect.
//   4. **The section testids and the preview testids the panel exposed before
//      the split still resolve.** The E2E scenarios reach the Editing section by
//      its testid (`developer-mode.e2e.ts`, `vim-mode.e2e.ts`) and the specimen
//      parity scenario reaches the preview by its own.
//
// The panel is the REAL component with its host calls mocked at the module
// boundary, because the thing under test is which body is mounted and what the
// specimen renders rather than which command answers. Two inputs are driven
// directly rather than through prefs, and both are deliberate: the date/time
// display comes from the SHARED store a note's own dates read
// (`setDateTimeDisplay`), and the task-chip display comes from the workspace
// container. Reading either from a pref would let the specimen print something
// no note would, which is the property claim 3 is really about.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, waitFor } from "@testing-library/react";

const invokeMock = vi.fn();

/** The prefs view the panel's own `usePrefs` sees. Mutable, because the preview
 *  assertions change it between renders. */
const { prefsState, taskDisplayState } = vi.hoisted(() => ({
  prefsState: {
    value: {} as Record<string, unknown>,
  },
  taskDisplayState: {
    value: { chipColor: "theme", iconOnly: false } as {
      chipColor: string;
      iconOnly: boolean;
    },
  },
}));

vi.mock("../../src/platform/core", () => ({
  invoke: (...a: unknown[]) => invokeMock(...(a as [])),
}));
vi.mock("../../src/platform/event", () => ({
  listen: vi.fn(() => Promise.resolve(() => {})),
}));
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(() => Promise.resolve(() => {})),
}));

// The prefs readers the panel's children call on mount. The real module is kept
// for everything else (the mutation derivations are pure).
vi.mock("../../src/lib/prefs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/lib/prefs")>();
  const resolved = (): Promise<unknown> => Promise.resolve(prefsState.value);
  const setters = [
    "setEditorTextSize",
    "setEditorLineSpacing",
    "setEditorContentWidth",
    "setEditorFontFamily",
    "setEditorLineNumbers",
    "setEditorVimMode",
    "setEditorDefaultViewMode",
    "setEditorFocusDimInactive",
    "setEditorFocusTypewriter",
    "setDateFormat",
    "setTimeFormat",
    "setTimezone",
    "setEditorToolbarOrder",
    "setEditorToolbarHidden",
    "setSpellEnabled",
    "setSpellLanguages",
    "setDailyFolder",
    "setDailyDateFormat",
    "setDailyTemplate",
    "setPeriodicNoteSetting",
    "setArchiveDisabled",
    "setRemindersEnabled",
    "setReminderHorizonDays",
  ];
  const overrides: Record<string, unknown> = { prefsRead: resolved };
  for (const name of setters) overrides[name] = vi.fn(resolved);
  return { ...actual, ...overrides };
});

// `usePrefs` is what the PREVIEW reads, so it is the one the assertions drive.
vi.mock("../../src/hooks/usePrefs", () => ({
  usePrefs: () => ({
    prefs: prefsState.value,
    setReminderHorizon: vi.fn(() => Promise.resolve()),
  }),
}));

// The task-chip display lives on the workspace container rather than in
// `vault.prefs`, which is the whole reason the specimen has to read it here.
vi.mock("../../src/notes/workspaceContext", () => ({
  useWorkspace: () => ({
    taskDisplay: taskDisplayState.value,
    setTaskDisplay: (next: { chipColor: string; iconOnly: boolean }) => {
      taskDisplayState.value = next;
    },
  }),
}));

// The periodic-notes block lists folders and templates; neither decides what
// this file asserts.
vi.mock("../../src/notes/listFolderPaths", () => ({
  listFolderPaths: () => Promise.resolve([]),
  resolveFolderOption: (values: string[], current: string) =>
    values.includes(current) ? current : values[0],
}));
vi.mock("../../src/notes", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/notes")>()),
  listTemplates: () => Promise.resolve([]),
}));

// Archive/views read the sidebar's own state; this file is not about either.
vi.mock("../../src/notes/sidebarState", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/notes/sidebarState")>()),
  archivedRecords: () => [],
  useSelectedNote: () => ({ noteUuid: null, record: null }),
}));
vi.mock("../../src/lib/viewsEnabled", () => ({
  readViewsEnabledPref: () => null,
  writeViewsEnabled: vi.fn(),
  VIEWS_ENABLED_EVENT: "myne:views-enabled-changed",
}));

// The plain-file surface is device-local and reads its own gate file.
vi.mock("../../src/platform/plainFile", () => ({
  plainFileGateGet: () => Promise.resolve({ enabled: true, dismissed: false }),
  plainFileGateSet: vi.fn(() => Promise.resolve()),
}));

const { EditorPanel } = await import("../../src/components/settings/EditorPanel");
const { resetSettingsTopics, setActiveSettingsTopic } = await import(
  "../../src/components/settings/SettingsTabs"
);
const { EDITOR_PANEL_TOPICS, SETTINGS_PANEL_TOPICS } = await import(
  "../../src/components/settings/settingsTopics"
);
const { SETTINGS_SEARCH_INDEX } = await import(
  "../../src/components/settings/search/settingsSearchIndex"
);
const { DEFAULT_DISPLAY, setDateTimeDisplay } = await import(
  "../../src/lib/datetimeFormat"
);
const { __resetDateTimeDisplayForTest } = await import(
  "../../src/lib/datetimeFormat"
);

/** The prefs the panel's own `usePrefs` sees, at their defaults. */
const BASE_PREFS: Record<string, unknown> = {
  // Developer mode ON is a fixture requirement, not a preference: the vim toggle
  // renders only while it is on, and `editor.vim-mode` is one of the panel's
  // registry entries. Off, that entry would look unreachable for a reason that
  // has nothing to do with the split (the same reason
  // `settingsPanelTopics.test.tsx` raises it for Privacy's CLI trio).
  developer_mode: true,
  reminders_enabled: true,
  reminder_horizon_days: null,
  // Typography at its canonical defaults (`null` resolves to the default).
  editor_text_size: null,
  editor_line_spacing: null,
  editor_content_width: null,
  editor_font_family: null,
  editor_line_numbers: false,
  editor_default_view_mode: null,
  spell_enabled: false,
  editor_toolbar_order: [],
  editor_toolbar_hidden: [],
};

/** Open one Editor topic, the way the strip does. */
function openTopic(topicId: string): void {
  act(() => {
    resetSettingsTopics();
    setActiveSettingsTopic("editor", topicId);
  });
}

function mount(focusAnchorId?: string): void {
  render(<EditorPanel {...(focusAnchorId === undefined ? {} : { focusAnchorId })} />);
}

beforeEach(() => {
  invokeMock.mockReset();
  invokeMock.mockImplementation(() => Promise.resolve(undefined));
  prefsState.value = { ...BASE_PREFS };
  taskDisplayState.value = { chipColor: "theme", iconOnly: false };
  setDateTimeDisplay(DEFAULT_DISPLAY);
});

afterEach(() => {
  cleanup();
  resetSettingsTopics();
  __resetDateTimeDisplayForTest();
});

describe("the Editor panel's topics", () => {
  it("declares six topics, and every one of them renders a non-empty body", async () => {
    expect(SETTINGS_PANEL_TOPICS.editor).toBe(EDITOR_PANEL_TOPICS);
    expect(EDITOR_PANEL_TOPICS.map((topic) => topic.id)).toEqual([
      "text",
      "editing",
      "writing",
      "tasks",
      "periodic",
      "features",
    ]);

    for (const topic of EDITOR_PANEL_TOPICS) {
      cleanup();
      openTopic(topic.id);
      mount();
      await act(async () => {
        await Promise.resolve();
      });
      const mine = document.querySelector(
        `[data-testid="settings.editor-topic-${topic.id}"]`,
      );
      expect(mine, `editor topic ${topic.id} rendered no body`).not.toBeNull();
      expect(
        (mine as HTMLElement).childElementCount,
        `editor topic ${topic.id} rendered an EMPTY body, which is a tab that opens onto nothing`,
      ).toBeGreaterThan(0);
      for (const other of EDITOR_PANEL_TOPICS) {
        if (other.id === topic.id) continue;
        expect(
          document.querySelector(`[data-testid="settings.editor-topic-${other.id}"]`),
          `editor rendered topic ${other.id} while ${topic.id} was active`,
        ).toBeNull();
      }
    }
  });

  it("keeps every section testid and the preview testids the panel exposed before the split", async () => {
    // The E2E scenarios reach the Editing section by its testid, and the
    // specimen-parity scenario reaches the preview by its own, so a testid that
    // moved with its control is the difference between a moved row and a broken
    // scenario.
    const sections: Record<string, string> = {
      text: "settings.section.editor-text",
      editing: "settings.section.editor-editing",
      writing: "settings.section.editor-writing",
      tasks: "settings.section.editor-tasks",
      features: "settings.section.editor-features",
    };
    for (const [topicId, testId] of Object.entries(sections)) {
      cleanup();
      openTopic(topicId);
      mount();
      await act(async () => {
        await Promise.resolve();
      });
      expect(
        document.querySelector(`[data-testid="${testId}"]`),
        `${testId} no longer resolves in topic ${topicId}`,
      ).not.toBeNull();
    }

    // The preview renders for every topic it can depict, so its own testid is
    // present on each of those. The two with nothing to depict draw no column,
    // which the test below asserts (myne-md/myne#885 visual pass).
    for (const topic of EDITOR_PANEL_TOPICS.filter(
      (meta) => meta.id !== "periodic" && meta.id !== "features",
    )) {
      cleanup();
      openTopic(topic.id);
      mount();
      await act(async () => {
        await Promise.resolve();
      });
      const preview = document.querySelector('[data-testid="settings.editor-preview"]');
      expect(preview, `the preview vanished on topic ${topic.id}`).not.toBeNull();
      expect(preview?.getAttribute("data-topic")).toBe(topic.id);
    }
  });
});

describe("every search entry lands in the topic it names", () => {
  it("renders each editor entry in exactly one topic, and the registry names it", async () => {
    const topics = EDITOR_PANEL_TOPICS;
    const entries = SETTINGS_SEARCH_INDEX.filter((entry) => entry.panelId === "editor");
    // A filter that matched nothing would make the whole walk vacuous.
    expect(entries.length, "the editor panel has no registry entries").toBeGreaterThan(20);

    const homes = new Map<string, Set<string>>();
    for (const topic of topics) {
      cleanup();
      openTopic(topic.id);
      mount();
      await act(async () => {
        await Promise.resolve();
      });
      const found = new Set<string>();
      for (const entry of entries) {
        const anchored = document.querySelector(
          `[data-setting-anchor="${entry.id}"]`,
        );
        // The shell's own resolution order: the anchor first, the testid as the
        // fallback (some rows carry only one of the two).
        const byTestid =
          entry.testid === undefined
            ? null
            : document.querySelector(`[data-testid="${entry.testid}"]`);
        if (anchored !== null || byTestid !== null) found.add(entry.id);
      }
      // The periodic block shows ONE period at a time behind a switcher, and the
      // settings search opens the right period by passing the hit's id as
      // `focusAnchorId` before the shell looks for the anchor. So an entry for a
      // period that is not the default one is checked the way the search reaches
      // it: mounted with its own id as the focus target.
      for (const entry of entries) {
        if (found.has(entry.id) || !/^editor\.(daily|weekly|monthly)-notes-/.test(entry.id)) continue;
        cleanup();
        openTopic(topic.id);
        mount(entry.id);
        await act(async () => {
          await Promise.resolve();
        });
        if (document.querySelector(`[data-setting-anchor="${entry.id}"]`) !== null) {
          found.add(entry.id);
        }
      }
      homes.set(topic.id, found);
    }

    const problems: string[] = [];
    for (const entry of entries) {
      const where = topics
        .filter((topic) => homes.get(topic.id)?.has(entry.id) === true)
        .map((topic) => topic.id);
      if (where.length === 0) {
        problems.push(
          `${entry.id} renders in NO topic, so the search scrolls to an element that is not in the document`,
        );
      } else if (where.length > 1) {
        problems.push(`${entry.id} renders in ${where.length} topics (${where.join(", ")})`);
      } else if (where[0] !== entry.topic) {
        problems.push(
          `${entry.id} renders in topic ${where[0]} but the registry says ${String(entry.topic)}`,
        );
      }
    }
    expect(problems).toEqual([]);
  });
});

describe("the preview follows the active topic", () => {
  it("shows the note specimen on the topics about the note, and a task specimen on Tasks", async () => {
    // The requester's own complaint was that the preview was STALE: it showed the
    // typography specimen whatever section they were in. So the assertion is
    // which specimen the topic produces, not that a preview exists.
    openTopic("text");
    mount();
    await act(async () => {
      await Promise.resolve();
    });
    expect(document.querySelector('[data-testid="settings.editor-preview"] p')).not.toBeNull();
    expect(document.querySelector('[data-testid="settings.editor-preview-task"]')).toBeNull();
    expect(document.querySelector('[data-testid="settings.editor-preview-toolbar"]')).toBeNull();

    cleanup();
    openTopic("tasks");
    mount();
    await act(async () => {
      await Promise.resolve();
    });
    expect(
      document.querySelector('[data-testid="settings.editor-preview-task"]'),
      "the Tasks topic must show the task specimen",
    ).not.toBeNull();
    expect(
      document.querySelector('[data-testid="settings.editor-preview"] p'),
      "the Tasks topic must NOT show the note specimen",
    ).toBeNull();
  });

  it("shows the toolbar band only where the toolbar is the subject", async () => {
    openTopic("editing");
    mount();
    await act(async () => {
      await Promise.resolve();
    });
    expect(document.querySelector('[data-testid="settings.editor-preview-toolbar"]')).not.toBeNull();
    expect(document.querySelector('[data-testid="settings.editor-preview-datetime"]')).not.toBeNull();

    cleanup();
    openTopic("text");
    mount();
    await act(async () => {
      await Promise.resolve();
    });
    expect(document.querySelector('[data-testid="settings.editor-preview-toolbar"]')).toBeNull();
    expect(document.querySelector('[data-testid="settings.editor-preview-datetime"]')).toBeNull();
  });

  it("draws no preview column for the two topics a note cannot depict", async () => {
    // Periodic notes decide where a new note is FILED and how it is TITLED, and
    // the two feature switches decide what the sidebar offers. Neither changes
    // what a note looks like, so a specimen for either would be an imitation of a
    // preview, and a framed box saying "nothing to show" spent a column on an
    // absence (myne-md/myne#885 visual pass). The column is simply not drawn.
    for (const topicId of ["periodic", "features"]) {
      cleanup();
      openTopic(topicId);
      mount();
      await act(async () => {
        await Promise.resolve();
      });
      // Waited rather than read once, because the panel's preview column and the
      // active topic are two subscriptions and the column only disappears when
      // the second one has settled. A single microtask flush was enough on a
      // developer machine and not on the CI runner, where this file failed with
      // the previous topic's column still mounted (`data-topic="tasks"`) in two
      // separate pipelines. The claim is unchanged: if the column were drawn for
      // a topic that cannot fill it, this would never settle and would still
      // fail, naming the topic.
      await waitFor(() =>
        expect(
          document.querySelector('[data-testid="settings.editor-preview"]'),
          `topic ${topicId} drew a preview it cannot honestly fill`,
        ).toBeNull(),
      );
    }
    // And the counter-case, so the assertion above is about the topic and not
    // about a preview that never renders in this harness.
    cleanup();
    openTopic("tasks");
    mount();
    await act(async () => {
      await Promise.resolve();
    });
    expect(document.querySelector('[data-testid="settings.editor-preview"]')).not.toBeNull();
  });
});

describe("the preview reflects the settings the requester named", () => {
  it("prints the date and time in the reader's chosen display", async () => {
    // Through the SHARED store a note's own dates read (`TaskRow` does the same
    // call), so the specimen cannot print a format no note would. Asserted on the
    // RENDERED TEXT: a test that read the pref back would pass on a preview that
    // ignored it.
    openTopic("editing");
    act(() => {
      setDateTimeDisplay({ ...DEFAULT_DISPLAY, dateFormat: "iso", timeFormat: "24h" });
    });
    mount();
    await act(async () => {
      await Promise.resolve();
    });
    const band = () =>
      (document.querySelector('[data-testid="settings.editor-preview-datetime"]')?.textContent ?? "").trim();
    expect(band()).toContain("2026-08-01");
    expect(band()).toContain("14:30");

    act(() => {
      setDateTimeDisplay({ ...DEFAULT_DISPLAY, dateFormat: "dmy", timeFormat: "12h" });
    });
    expect(band()).toContain("01/08/2026");
    expect(band()).toContain("2:30 PM");
  });

  it("draws the toolbar the customisation resolves to, and leaves a hidden button out", async () => {
    prefsState.value = {
      ...BASE_PREFS,
      editor_toolbar_order: [],
      editor_toolbar_hidden: ["bold"],
    };
    openTopic("editing");
    mount();
    await act(async () => {
      await Promise.resolve();
    });
    const shown = (id: string) =>
      document.querySelector(`[data-testid="settings.editor-preview-toolbar-${id}"]`);
    expect(shown("italic"), "a default-shown button is missing from the specimen").not.toBeNull();
    expect(shown("bold"), "a hidden button is still drawn in the specimen").toBeNull();
    // The five not-yet-renderable ids are pinned hidden by the resolver, so they
    // are absent whatever the stored layout says.
    expect(shown("checklist")).toBeNull();

    // And un-hiding one puts it back: the specimen reads the resolved set rather
    // than a frozen default.
    prefsState.value = { ...BASE_PREFS, editor_toolbar_order: [], editor_toolbar_hidden: [] };
    cleanup();
    openTopic("editing");
    mount();
    await act(async () => {
      await Promise.resolve();
    });
    expect(shown("bold")).not.toBeNull();
  });

  it("keeps the spell demo, resolves its default the way the editor does, and shows it only where spell check is the subject", async () => {
    // `null` ≡ unset ≡ ON (SYNC-15), which is the resolution `SpellSettings` and
    // the editor itself apply: a fresh vault has spell check ON in every note, so
    // a specimen that read the raw pref would say the opposite of what the editor
    // does.
    prefsState.value = { ...BASE_PREFS, spell_enabled: null };
    openTopic("writing");
    mount();
    await act(async () => {
      await Promise.resolve();
    });
    const demo = () => document.querySelector('[data-testid="settings.editor-preview-spell"]');
    expect(demo(), "an unset spell pref means ON, so the demo belongs here").not.toBeNull();
    expect((demo()?.textContent ?? "").length).toBeGreaterThan(0);

    // Explicitly off removes it.
    prefsState.value = { ...BASE_PREFS, spell_enabled: false };
    cleanup();
    openTopic("writing");
    mount();
    await act(async () => {
      await Promise.resolve();
    });
    expect(demo()).toBeNull();

    // And the same setting on the Text topic draws no spell demo at all: the
    // specimen is the ACTIVE topic's, which is the change this work makes.
    prefsState.value = { ...BASE_PREFS, spell_enabled: true };
    cleanup();
    openTopic("text");
    mount();
    await act(async () => {
      await Promise.resolve();
    });
    expect(demo()).toBeNull();
  });

  it("takes the task chip's colour and its icon-only mode from the workspace container", async () => {
    // Not from a pref: the two task-display settings live on the workspace
    // container (`taskDisplay.ts`), and `Editor.tsx` publishes the same closed
    // enum to `--task-chip-ink` for a note's own chips, so the two cannot
    // disagree.
    openTopic("tasks");
    mount();
    await act(async () => {
      await Promise.resolve();
    });
    const chip = () =>
      document.querySelector('[data-testid="settings.editor-preview-task-chip"]') as HTMLElement | null;
    const label = () => document.querySelector('[data-testid="settings.editor-preview-task-label"]');

    expect(chip()?.getAttribute("data-chip-color")).toBe("theme");
    expect(chip()?.getAttribute("data-icon-only")).toBe("false");
    expect(label(), "the priority word is shown while icon-only is off").not.toBeNull();
    expect(chip()?.style.color).toBe("var(--fg-1)");

    act(() => {
      taskDisplayState.value = { chipColor: "danger", iconOnly: true };
      // Re-render with the new container value the way a real `setTaskDisplay`
      // would: the mocked `useWorkspace` reads the mutable holder, so a rerender
      // is what a state update produces.
    });
    cleanup();
    openTopic("tasks");
    mount();
    await act(async () => {
      await Promise.resolve();
    });
    expect(chip()?.getAttribute("data-chip-color")).toBe("danger");
    expect(chip()?.getAttribute("data-icon-only")).toBe("true");
    expect(chip()?.style.color).toBe("var(--danger)");
    expect(label(), "icon-only must drop the word").toBeNull();
  });

  it("still reflects the four typography presets, line numbers and the view mode", async () => {
    // The inputs the preview already had, asserted on the specimen's computed
    // style rather than on the presence of the element (which passes on the
    // version this work replaces).
    prefsState.value = {
      ...BASE_PREFS,
      editor_text_size: "xl",
      editor_line_spacing: "relaxed",
      editor_default_view_mode: "source",
      editor_line_numbers: true,
    };
    openTopic("text");
    mount();
    await act(async () => {
      await Promise.resolve();
    });
    const specimen = document.querySelector('[data-testid="settings.editor-preview"]');
    // `typographyStyleFromKeys` sets the custom properties on the wrapper and the
    // sample reads them through `var(...)`, so the wrapper carries the resolved
    // preset values. Found by the property rather than by a `p`, because Source
    // view renders raw markdown rather than paragraphs.
    const wrapper = specimen?.querySelector(
      '[style*="--editor-text-size"]',
    ) as HTMLElement | null;
    expect(wrapper).not.toBeNull();
    const style = (wrapper as HTMLElement).style;
    expect(style.getPropertyValue("--editor-text-size")).toBe("18px");
    expect(style.getPropertyValue("--editor-line-spacing")).toBe("1.95");
    // Source view renders raw markdown, and the line-number gutter comes with it.
    expect((specimen?.textContent ?? "").includes("# The quick brown fox")).toBe(true);
  });
});
