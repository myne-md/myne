// @vitest-environment jsdom
//
// The periodic-notes rows on mobile: daily, weekly and monthly (myne-md/myne#880).
//
// # What this pins
//
// `mobile/src/lib/daily.ts` resolved a period note's folder, title format and
// template out of `vault.prefs` and nothing on this client could write any of
// them, so a phone filed its notes by a configuration only a computer could set.
// The failure was wiring, and wiring is what a mocked IPC asserts cheaply: the
// control reaches the SETTER, and the setter reaches the CHOKEPOINT.
//
// # The two halves, and why both are here
//
// 1. The ROUTING. Daily writes its three legacy top-level fields; weekly and
//    monthly write one `periodic_notes` entry each. A test that only asserted
//    "something was written" would pass with the two swapped, which is the
//    asymmetry the desktop component records as the no-migration decision.
// 2. The CHOKEPOINT. Every write must arrive as
//    `plugin:prefs|set_periodic_note_setting` (or a `daily_*` command) at
//    `invoke`. Asserting the setter was called would pass over a setter that
//    bypassed `writePref`, which is the shape `check-prefs-nonce.mjs` exists to
//    forbid; this is that rule's behavioural twin for the new command.
//
// The template picker is driven through a mocked note list rather than a real
// one: which notes count as templates is `isListedTemplate`'s business and is
// covered by its own specs. What is under test is that the picker offers them
// and that a tap writes the chosen id.

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const invoke = vi.fn();

vi.mock("../../src/platform/core", () => ({
  invoke: (...args: unknown[]) => invoke(...args),
}));

const TEMPLATE_BODY = "---\ntemplate: true\ntitle: Meeting\n---\n\nAgenda\n";
const PLAIN_BODY = "---\ntitle: Plain\n---\n\nBody\n";

vi.mock("../../src/lib/notes", () => ({
  noteList: async () => ["tpl-1", "note-1"],
  noteRead: async (id: string) => (id === "tpl-1" ? TEMPLATE_BODY : PLAIN_BODY),
}));

import { PeriodicNotesBlock, persistPeriodSetting } from "../../src/components/PeriodicNotesBlock";
import { DEFAULT_DAILY_FOLDER, PERIOD_DEFAULTS, type PeriodPrefs } from "../../src/lib/daily";

/** The i18n stub every mobile spec uses: keys echo, so an assertion about copy
 *  reaches the catalog separately (see the spell-row spec for that half). */
vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string, opts?: Record<string, unknown>) => key + (opts ? "" : "") }),
}));

function prefs(over: Partial<PeriodPrefs> = {}): PeriodPrefs {
  return {
    daily_folder: null,
    daily_date_format: null,
    daily_template: null,
    periodic_notes: {},
    ...over,
  };
}

/** The prefs commands that reached the chokepoint, in order. */
function prefsWrites(): { cmd: string; args: Record<string, unknown> }[] {
  return invoke.mock.calls
    .map((c) => c as [string, Record<string, unknown>])
    .filter(([cmd]) => typeof cmd === "string" && cmd.startsWith("plugin:prefs|"))
    .map(([cmd, args]) => ({ cmd: cmd.slice("plugin:prefs|".length), args: args ?? {} }));
}

beforeEach(() => {
  invoke.mockReset();
  invoke.mockImplementation(async (cmd: unknown) => {
    if (cmd === "plugin:prefs|prefs_read") return {};
    return undefined;
  });
});

afterEach(cleanup);

describe("mobile periodic-notes rows", () => {
  it("routes the DAILY fields to their legacy setters, not to the periodic map", async () => {
    render(<PeriodicNotesBlock prefs={prefs()} />);

    // The field is seeded with the resolved default, so the default is visible
    // rather than described.
    const folder = screen.getByTestId("settings.periodicNotes.folder") as HTMLInputElement;
    expect(folder.value).toBe(DEFAULT_DAILY_FOLDER);

    fireEvent.change(folder, { target: { value: "Journal/" } });
    fireEvent.click(screen.getByTestId("settings.periodicNotes.folder-commit"));

    await waitFor(() => expect(prefsWrites()).toHaveLength(1));
    expect(prefsWrites()[0].cmd).toBe("set_daily_folder");
    expect(prefsWrites()[0].args).toEqual({ folder: "Journal/" });

    const format = screen.getByTestId("settings.periodicNotes.format") as HTMLInputElement;
    fireEvent.change(format, { target: { value: "YYYY/MM/DD" } });
    fireEvent.click(screen.getByTestId("settings.periodicNotes.format-commit"));

    await waitFor(() => expect(prefsWrites()).toHaveLength(2));
    expect(prefsWrites()[1].cmd).toBe("set_daily_date_format");
    expect(prefsWrites()[1].args).toEqual({ format: "YYYY/MM/DD" });
    // And NOT the map: the daily/periodic split is the no-migration decision.
    expect(prefsWrites().some((w) => w.cmd === "set_periodic_note_setting")).toBe(false);
  });

  it("routes WEEKLY and MONTHLY to the periodic map, through the chokepoint", async () => {
    render(<PeriodicNotesBlock prefs={prefs()} />);

    // The segment ids come from `optionValues`, so the spec addresses a period
    // by name rather than by its translated label.
    fireEvent.click(screen.getByTestId("settings.periodicNotes-period-weekly"));
    const folder = screen.getByTestId("settings.periodicNotes.folder") as HTMLInputElement;
    expect(folder.value).toBe(PERIOD_DEFAULTS.weekly.folder);
    fireEvent.change(folder, { target: { value: "Weeks/" } });
    fireEvent.click(screen.getByTestId("settings.periodicNotes.folder-commit"));

    await waitFor(() => expect(prefsWrites()).toHaveLength(1));
    expect(prefsWrites()[0]).toEqual({
      cmd: "set_periodic_note_setting",
      args: { period: "weekly", setting: "folder", value: "Weeks/" },
    });

    fireEvent.click(screen.getByTestId("settings.periodicNotes-period-monthly"));
    const monthly = screen.getByTestId("settings.periodicNotes.format") as HTMLInputElement;
    fireEvent.change(monthly, { target: { value: "YYYY-MM-log" } });
    fireEvent.click(screen.getByTestId("settings.periodicNotes.format-commit"));

    await waitFor(() => expect(prefsWrites()).toHaveLength(2));
    expect(prefsWrites()[1].args).toEqual({
      period: "monthly",
      setting: "format",
      value: "YYYY-MM-log",
    });
    // No `daily_*` write: the daily three are not reachable from these periods.
    expect(prefsWrites().some((w) => w.cmd.startsWith("set_daily"))).toBe(false);
  });

  it("offers the vault's templates and writes the chosen one, and clears it", async () => {
    render(<PeriodicNotesBlock prefs={prefs()} />);

    await waitFor(() =>
      expect(screen.getByTestId("settings.periodicNotes.template-tpl-1")).toBeTruthy(),
    );
    // The plain note is NOT offered: only `template: true` notes are.
    expect(screen.queryByTestId("settings.periodicNotes.template-note-1")).toBeNull();

    fireEvent.click(screen.getByTestId("settings.periodicNotes.template-tpl-1"));
    await waitFor(() => expect(prefsWrites()).toHaveLength(1));
    expect(prefsWrites()[0]).toEqual({
      cmd: "set_daily_template",
      args: { templateId: "tpl-1" },
    });

    fireEvent.click(screen.getByTestId("settings.periodicNotes.template-none"));
    await waitFor(() => expect(prefsWrites()).toHaveLength(2));
    expect(prefsWrites()[1]).toEqual({ cmd: "set_daily_template", args: { templateId: null } });
  });

  it("states which client's value the rows change", () => {
    // The daily fields and the periodic map are all SHARED, and the neighbours
    // in this panel are a mix, so the block says which it is.
    render(<PeriodicNotesBlock prefs={prefs()} />);
    const notice = screen.getByTestId("settings.periodicNotes.shared-notice");
    expect(notice.textContent).toContain("settings.dailyNotes.mobileSharedNotice");
  });

  it("saves a typed folder when the field loses focus (myne-md/myne#867 review)", async () => {
    // A folder typed and the sheet closed used to be lost: only Enter or the
    // trailing glyph saved it, and nothing said the draft was unsaved.
    render(<PeriodicNotesBlock prefs={prefs()} />);
    const folder = screen.getByTestId("settings.periodicNotes.folder") as HTMLInputElement;
    fireEvent.change(folder, { target: { value: "Journal/" } });
    fireEvent.blur(folder);
    await waitFor(() => expect(prefsWrites()).toHaveLength(1));
    expect(prefsWrites()[0]).toEqual({ cmd: "set_daily_folder", args: { folder: "Journal/" } });
  });

  it("does not write when the field was not edited", async () => {
    // A commit with no edit is not an edit, and every write stamps a fresh
    // field clock. Asserting this is what keeps the field's blur handler from
    // turning a tab-through into a write.
    render(<PeriodicNotesBlock prefs={prefs()} />);
    fireEvent.click(screen.getByTestId("settings.periodicNotes.folder-commit"));
    fireEvent.click(screen.getByTestId("settings.periodicNotes.format-commit"));
    await Promise.resolve();
    expect(prefsWrites()).toEqual([]);
  });

  it("reports a failed write and rolls the field back to disk truth", async () => {
    // The desktop twin (`PeriodicNotesSettings`) catches, restores the previous
    // value and shows a per-setting error. Without both halves the phone keeps
    // the path the user typed while `vault.prefs` keeps the old one.
    invoke.mockImplementation(async () => {
      throw new Error("write failed");
    });
    const onToast = vi.fn();
    render(<PeriodicNotesBlock prefs={prefs({ daily_folder: "Old/" })} onToast={onToast} />);
    const field = screen.getByTestId("settings.periodicNotes.folder") as HTMLInputElement;
    fireEvent.change(field, { target: { value: "New/" } });
    fireEvent.keyDown(field, { key: "Enter" });

    await waitFor(() => expect(onToast).toHaveBeenCalledWith("settings.saveSettingError"));
    await waitFor(() => expect(field.value).toBe("Old/"));
  });
});

describe("persistPeriodSetting routing", () => {
  beforeEach(() => invoke.mockReset());

  it("sends a cleared daily folder as an empty string, not null", async () => {
    // The daily setter takes `String`; the periodic one takes `String | null`
    // and uses null to REMOVE the key. Sending null for daily would clear the
    // wrong shape at the backend.
    await persistPeriodSetting("daily", "folder", null);
    await persistPeriodSetting("weekly", "folder", null);
    const writes = prefsWrites();
    expect(writes[0].args).toEqual({ folder: "" });
    expect(writes[1].args).toEqual({ period: "weekly", setting: "folder", value: null });
  });
});
