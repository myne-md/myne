// @vitest-environment jsdom
//
// The AI excluded-folders control on mobile (MYND-408, reached this client in
// myne-md/myne#880).
//
// # What this pins
//
// `ai_excluded_folders` is the list the AI REFUSAL PATH honours. This client
// already enforced it and reported its count, and could not author it, so the
// control that decides where AI may read was authored only from a computer.
//
// Three assertions carry the feature, and none of them is "something was
// written":
//
// 1. **The payload is VERBS, not a whole set.** The sync stamper derives
//    removals from `before \ after`, so a whole-set write from a stale caller
//    claims deletions it never made and travels them to every device. A test
//    asserting the resulting value would pass over exactly that.
// 2. **A folder excluded from the phone is honoured by the EGRESS PATH.** The
//    write reaching the command is not the property; the property is that the
//    shared predicate the AI surfaces short-circuit through then reports the
//    note as excluded. That predicate (`isNoteAiExcluded`) is the frontend
//    mirror of the Rust `folder_matches_excluded`, and the two must agree or a
//    note gated on one path is not gated on the other.
// 3. **A concurrent addition survives.** A folder another device added, which
//    this caller has never seen, is in neither of the caller's two values and is
//    therefore claimed by neither.

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { isNoteAiExcluded } from "../../../src/lib/aiExcludedFolders";

const invoke = vi.fn();

vi.mock("../../src/platform/core", () => ({
  invoke: (...args: unknown[]) => invoke(...args),
}));

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string, opts?: Record<string, unknown>) => (opts ? key : key) }),
}));

import {
  AiExcludedFoldersBlock,
  excludeFolder,
  includeFolder,
} from "../../src/components/AiExcludedFoldersBlock";
import { mutationFrom } from "../../src/lib/prefs";

/** The mutations that reached the command, in order. */
function mutations(): { add?: string[]; remove?: string[] }[] {
  return invoke.mock.calls
    .filter((c) => (c as [string])[0] === "plugin:prefs|set_ai_excluded_folders")
    .map((c) => (c as [string, { mutation?: { add?: string[]; remove?: string[] } }])[1].mutation ?? {});
}

beforeEach(() => {
  invoke.mockReset();
  invoke.mockImplementation(async () => 0);
});

afterEach(cleanup);

describe("mobile AI excluded-folders row", () => {
  it("sends VERBS when a folder is excluded", async () => {
    render(<AiExcludedFoldersBlock folders={["Private/"]} />);
    const field = screen.getByTestId("settings.aiExcludedFolders.add") as HTMLInputElement;
    fireEvent.change(field, { target: { value: "Journal/" } });
    fireEvent.click(screen.getByTestId("settings.aiExcludedFolders.add-commit"));

    await waitFor(() => expect(mutations()).toHaveLength(1));
    // The whole-set shape would be `{ folders: [...] }`; the set-union shape is
    // `{ mutation: { add, remove } }`.
    expect(mutations()[0]).toEqual({ add: ["Journal/"], remove: [] });
  });

  it("sends VERBS when a folder is un-excluded, naming only that folder", async () => {
    render(<AiExcludedFoldersBlock folders={["Private/", "Journal/"]} />);
    fireEvent.click(screen.getByTestId("settings.aiExcludedFolders.remove-Journal/"));

    await waitFor(() => expect(mutations()).toHaveLength(1));
    expect(mutations()[0]).toEqual({ add: [], remove: ["Journal/"] });
  });

  it("honours an exclusion made on the phone in the EGRESS predicate", async () => {
    // The property that separates authorable from bypassable. The write reaches
    // the same shared field the AI surfaces read, and the shared predicate then
    // reports a note in that folder as excluded.
    render(<AiExcludedFoldersBlock folders={[]} />);
    fireEvent.change(screen.getByTestId("settings.aiExcludedFolders.add"), {
      target: { value: "Private/" },
    });
    fireEvent.click(screen.getByTestId("settings.aiExcludedFolders.add-commit"));
    await waitFor(() => expect(mutations()).toHaveLength(1));

    // Apply the mutation the way the host does, then ask the egress predicate.
    const onDisk = ["Archive/"];
    const applied = [...onDisk, ...(mutations()[0].add ?? [])].filter(
      (f) => !(mutations()[0].remove ?? []).includes(f),
    );
    expect(isNoteAiExcluded("Private/", applied)).toBe(true);
    // And nested folders inherit, which is what the trailing slash is for.
    expect(isNoteAiExcluded("Private/Notes/", applied)).toBe(true);
    // A sibling whose name merely starts with the excluded one is NOT excluded.
    expect(isNoteAiExcluded("PrivateStuff/", applied)).toBe(false);
    expect(isNoteAiExcluded("Archive/", applied)).toBe(true);
  });

  it("keeps a concurrent addition this caller never saw", async () => {
    // A desktop added `Shared/`; this phone's view has not caught up. The phone
    // removes a DIFFERENT folder. The mutation names only what the caller's own
    // before/after disagree about, so the peer's entry is claimed by neither and
    // survives on the host.
    const caller = ["Private/", "Journal/"];
    const next = includeFolder(caller, "Journal/");
    const m = mutationFrom(caller, next);
    expect(m).toEqual({ add: [], remove: ["Journal/"] });

    const onDisk = ["Private/", "Journal/", "Shared/"];
    const applied = [...onDisk, ...(m.add ?? [])].filter((f) => !(m.remove ?? []).includes(f));
    expect(applied).toContain("Shared/");
    expect(applied).not.toContain("Journal/");
  });

  it("does not write when the field is empty or unchanged", async () => {
    render(<AiExcludedFoldersBlock folders={["Private/"]} />);
    fireEvent.click(screen.getByTestId("settings.aiExcludedFolders.add-commit"));
    await Promise.resolve();
    expect(mutations()).toEqual([]);
  });

  it("says the list is empty rather than showing an empty box", () => {
    render(<AiExcludedFoldersBlock folders={[]} />);
    expect(screen.getByTestId("settings.aiExcludedFolders.empty").textContent).toContain(
      "settings.ai.excludedFoldersEmpty",
    );
  });

  it("states the monotone-union consequence rather than implying a local removal", () => {
    // §10.2 keeps this set's union monotone because it is an egress control, so
    // a removal does not travel. A UI that implied otherwise would be promising
    // something the merge does not do.
    render(<AiExcludedFoldersBlock folders={["Private/"]} />);
    expect(screen.getByTestId("settings.aiExcludedFolders.monotone-notice").textContent).toContain(
      "settings.ai.excludedFoldersMonotoneNotice",
    );
  });
});

describe("excludeFolder / includeFolder", () => {
  it("trims, ignores an empty entry, and removes exactly one", () => {
    expect(excludeFolder(["A/"], "  B/  ")).toEqual(["A/", "B/"]);
    expect(excludeFolder(["A/"], "   ")).toEqual(["A/"]);
    expect(includeFolder(["A/", "B/"], "A/")).toEqual(["B/"]);
  });

  it("does not duplicate a folder that is already excluded", () => {
    // The desktop twin's picker guards this ("already excluded: not a no-op to
    // say so twice"). Unguarded, the add committed a duplicate and the list
    // rendered two rows with one key and one testid.
    expect(excludeFolder(["Private/"], "Private/")).toEqual(["Private/"]);
    expect(excludeFolder(["Private/"], "  Private/  ")).toEqual(["Private/"]);
  });
});

describe("mobile AI excluded-folders row, the duplicate and the failed write", () => {
  it("writes nothing when the folder is already excluded", async () => {
    render(<AiExcludedFoldersBlock folders={["Private/"]} />);
    fireEvent.change(screen.getByTestId("settings.aiExcludedFolders.add"), {
      target: { value: "Private/" },
    });
    fireEvent.click(screen.getByTestId("settings.aiExcludedFolders.add-commit"));
    await Promise.resolve();
    expect(mutations()).toEqual([]);
  });

  it("reports a failed write instead of swallowing it", async () => {
    // `ai_excluded_folders` is the AI egress control, so a user who believes
    // they excluded a folder while `vault.prefs` still holds the old set has
    // been told something false about where AI may read. The desktop twin
    // reports the same failure through `usePrefs`'s `onShowToast`.
    invoke.mockImplementation(async () => {
      throw new Error("write failed");
    });
    const onToast = vi.fn();
    render(<AiExcludedFoldersBlock folders={["Private/"]} onToast={onToast} />);
    fireEvent.change(screen.getByTestId("settings.aiExcludedFolders.add"), {
      target: { value: "Journal/" },
    });
    fireEvent.click(screen.getByTestId("settings.aiExcludedFolders.add-commit"));
    await waitFor(() => expect(onToast).toHaveBeenCalledWith("settings.saveSettingError"));
  });
});
