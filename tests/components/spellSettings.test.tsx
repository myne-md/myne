// @vitest-environment jsdom
//
// Component tests for `src/components/settings/SpellSettings.tsx`. Covers the
// The toggle is the shared `<Switch>` primitive (MYND-624), so its state is
// read from `aria-checked` -- it renders no On/Off text of its own.
//
// optimistic spell-check toggle (flip → persist → live-update editor; revert +
// error on failure), the disabled language picker when spell-check is off, and
// the language multi-select persistence. The prefs setters, the spell lib, and
// the editor decoration hook are mocked at their boundaries; the SearchableSelect
// primitive renders for real.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

const prefsRead = vi.fn();
const setSpellEnabled = vi.fn();
const setSpellLanguages = vi.fn();
const setActiveSpellLanguages = vi.fn();
const setSpellConfig = vi.fn();

vi.mock("../../src/lib/prefs", async (importOriginal) => ({
  prefsRead: (...a: unknown[]) => prefsRead(...a),
  setSpellEnabled: (...a: unknown[]) => setSpellEnabled(...a),
  mutateSpellLanguages: (...a: unknown[]) => setSpellLanguages(...a),
  // The REAL derivation, not a copy of it. It is what decides whether a
  // stale view can claim a deletion (myne-md/myne#613), so a stub here would
  // test the stub, and a hand-copy would be one more place for the real one
  // to drift away from.
  mutationFrom: (await importOriginal<typeof import("../../src/lib/prefs")>()).mutationFrom,
}));
vi.mock("../../src/lib/spell", () => ({
  // Two bundled tags is enough to exercise the picker.
  BUNDLED_SPELL_LANGUAGES: ["en-US", "de"],
  defaultActiveLanguages: () => ["en-US"],
  setActiveSpellLanguages: (...a: unknown[]) => setActiveSpellLanguages(...a),
}));
vi.mock("../../src/editor/decorations/spell", () => ({
  setSpellConfig: (...a: unknown[]) => setSpellConfig(...a),
}));

import { SpellSettings } from "../../src/components/settings/SpellSettings";

beforeEach(() => {
  prefsRead.mockReset().mockResolvedValue({
    spell_enabled: true,
    spell_languages: ["en-US"],
  });
  setSpellEnabled.mockReset().mockResolvedValue(undefined);
  setSpellLanguages.mockReset().mockResolvedValue(undefined);
  setActiveSpellLanguages.mockReset().mockResolvedValue(undefined);
  setSpellConfig.mockReset();
});

afterEach(cleanup);

describe("SpellSettings — enable toggle", () => {
  it("seeds On from prefs and toggles to Off (persist + live editor update)", async () => {
    render(<SpellSettings />);
    await waitFor(() =>
      expect(screen.getByTestId("settings.spell-check").getAttribute("aria-checked")).toBe("true"),
    );
    // Wait for `prefsRead` to resolve and seed `active` (the picker trigger shows
    // the selected language label) before toggling — otherwise the click races
    // the async load and fires with an empty language set.
    await screen.findByText("English (US)");
    await act(async () => {
      fireEvent.click(screen.getByTestId("settings.spell-check"));
    });
    expect(setSpellEnabled).toHaveBeenCalledWith(false);
    expect(setSpellConfig).toHaveBeenCalledWith(false, ["en-US"]);
    // Turning off frees the active dictionaries.
    expect(setActiveSpellLanguages).toHaveBeenCalledWith([]);
    await waitFor(() =>
      expect(screen.getByTestId("settings.spell-check").getAttribute("aria-checked")).toBe("false"),
    );
  });

  it("reverts to On and surfaces an error when the toggle write fails", async () => {
    setSpellEnabled.mockRejectedValueOnce(new Error("io"));
    render(<SpellSettings />);
    await waitFor(() =>
      expect(screen.getByTestId("settings.spell-check").getAttribute("aria-checked")).toBe("true"),
    );
    await act(async () => {
      fireEvent.click(screen.getByTestId("settings.spell-check"));
    });
    await waitFor(() =>
      expect(
        screen.getByText("Could not save the spell-check setting."),
      ).toBeTruthy(),
    );
    expect(screen.getByTestId("settings.spell-check").getAttribute("aria-checked")).toBe("true");
  });

  it("disables the language picker when spell-check is off", async () => {
    prefsRead.mockResolvedValue({ spell_enabled: false, spell_languages: ["en-US"] });
    render(<SpellSettings />);
    await waitFor(() =>
      expect(screen.getByTestId("settings.spell-check").getAttribute("aria-checked")).toBe("false"),
    );
    expect(
      (screen.getByTestId("settings.spell-language-select") as HTMLButtonElement)
        .disabled,
    ).toBe(true);
  });
});

describe("SpellSettings — language selection", () => {
  it("adding a language persists the new set + live-updates the editor", async () => {
    render(<SpellSettings />);
    // Wait for `prefsRead` to resolve and seed `active` with ["en-US"] before
    // adding "de" — otherwise the add races the async load and the resulting set
    // is missing the seeded language.
    await screen.findByText("English (US)");

    fireEvent.click(screen.getByTestId("settings.spell-language-select"));
    const de = (
      await screen.findAllByTestId("settings.spell-language-select-option")
    ).find((el) => el.getAttribute("data-value") === "de");
    expect(de).toBeTruthy();
    await act(async () => {
      fireEvent.click(de!);
    });
    // The multi-select adds "de" to the existing ["en-US"].
    await waitFor(() => expect(setSpellLanguages).toHaveBeenCalled());
    // The payload is a mutation, so the claim is "de was ADDED" rather than
    // "the set is now these two". `en-US` is untouched and must therefore be in
    // NEITHER half: a caller that mentioned it would be claiming something about
    // an entry it did not change (myne-md/myne#613).
    const lastCall = setSpellLanguages.mock.calls.at(-1)![0] as {
      add: string[];
      remove: string[];
    };
    expect(lastCall.add).toContain("de");
    expect(lastCall.remove).toEqual([]);
    expect(lastCall.add).not.toContain("en-US");
    expect(setActiveSpellLanguages).toHaveBeenCalled();
  });
});
