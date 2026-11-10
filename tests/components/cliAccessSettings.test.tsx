// @vitest-environment jsdom
//
// The Settings → Privacy terminal-access block (cli-thin-client task 12,
// MYND-490).
//
// Two things are worth a test here, and neither is "does the switch flip".
//
// 1. **The copy's BOUNDS.** `agent-tooling/docs/threat-model.md` §7's entry for this door is
//    normative: the enable copy must state the access consequence plainly and
//    must not claim a gatekeeper, and the rate limit must not be described as a
//    protection nor its removal as disabling one. The Rust side already pins its
//    half (`cli/src/output.rs::no_copy_calls_the_rate_limit_a_protection`), and
//    this is the same assertion against the same forbidden vocabulary on the
//    Settings side — the surface a user is far more likely to read.
// 2. **What the panel does with the door's session state**, which is a
//    branch rather than a string: an age becomes a coarse "x ago" line, "never"
//    becomes an explicit sentence, and a shim that exists but is not on `$PATH`
//    surfaces the one `export PATH=…` line the app declines to write into the
//    user's shell profile.
//
// Copy is asserted through the real English catalog rather than pasted, so the
// wording stays the catalog's business — what is pinned is the *bound*, which no
// translation may cross either.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

const readCliAccessState = vi.fn();
vi.mock("../../src/lib/cli-access", async (importOriginal) => {
  const real = await importOriginal<typeof import("../../src/lib/cli-access")>();
  return { ...real, readCliAccessState: () => readCliAccessState() };
});

const { CliAccessSettings, foldersFromDraft, lastUsedLabel } = await import(
  "../../src/components/settings/CliAccessSettings"
);
const i18n = (await import("../../src/i18n")).default;

/** Every word that would turn the rate limit into a security claim. */
const FORBIDDEN_IN_RATE_LIMIT_COPY = [
  "protect",
  "security",
  "secure",
  "safety",
  "safe",
  "guard",
  "block",
  "attack",
  "unsafe",
  "disable",
];

function renderBlock(overrides: Partial<Parameters<typeof CliAccessSettings>[0]> = {}) {
  render(
    <CliAccessSettings
      enabled
      excludedFolders={[]}
      rateLimitDisabled={null}
      onSetEnabled={() => {}}
      onSetExcludedFolders={() => {}}
      onSetRateLimitDisabled={() => {}}
      {...overrides}
    />,
  );
}

beforeEach(() => {
  readCliAccessState.mockResolvedValue({
    lastUsedSecsAgo: null,
    commandOnPath: true,
    shimDir: null,
  });
});

afterEach(() => {
  cleanup();
  readCliAccessState.mockReset();
});

describe("terminal-access copy bounds", () => {
  it("never calls the rate limit a protection, or its removal a disabling", () => {
    // The whole point of the criterion: the second claim is worse than the
    // first, because it implies a protection was there.
    const copy = [
      i18n.t("settings.cliAccess.rateLimitLabel"),
      i18n.t("settings.cliAccess.rateLimitHelper"),
    ]
      .join(" ")
      .toLowerCase();
    for (const forbidden of FORBIDDEN_IN_RATE_LIMIT_COPY) {
      expect(copy, `rate-limit copy must not use "${forbidden}": ${copy}`).not.toContain(
        forbidden,
      );
    }
  });

  it("states the rate limit for what it IS — a pace, not a permission check", () => {
    // Not just an absence of the wrong words: the honest positive claim has to
    // be there, or "120 commands a minute" reads as a security budget.
    const helper = i18n.t("settings.cliAccess.rateLimitHelper").toLowerCase();
    expect(helper).toContain("pace limit");
    expect(helper).toContain("not a permission check");
  });

  it("says plainly, when on, that any program under the user's account gets in", () => {
    // Row sentence plus disclosure: the "any program under your account" clause
    // is the row's, the bounds are behind the `?`.
    const helper =
      `${i18n.t("settings.cliAccess.inlineOn")} ${i18n.t("settings.cliAccess.helperOn")}`.toLowerCase();
    // The §7 residual, in the user's words: "while the door is open … any
    // program running as the same OS user can drive the CLI".
    expect(helper).toContain("any program running under your account");
    // And the two bounds that keep the sentence from reading as a threat: it
    // closes on lock, and it cannot delete.
    expect(helper).toContain("locks");
    expect(helper).toContain("delete");
  });

  it("claims no gatekeeper — no token, no allow-list, no verification", () => {
    // There is no identity check by construction (a program running as the
    // same user can invoke the legitimate CLI), so the copy may not hint at
    // one. This is the claim the threat-model entry forbids most explicitly.
    const helper = i18n.t("settings.cliAccess.helperOn").toLowerCase();
    for (const forbidden of ["token", "pair", "approve", "verif", "allow-list", "trusted"]) {
      expect(helper, `enable copy must not imply a gatekeeper via "${forbidden}"`).not.toContain(
        forbidden,
      );
    }
  });
});

describe("last-access line", () => {
  it("reads as an explicit sentence when nothing has used the door", () => {
    expect(lastUsedLabel(null, i18n.t.bind(i18n))).toBe(
      i18n.t("settings.cliAccess.lastUsedNever"),
    );
  });

  it("coarsens an age into just-now / minutes / hours / days", () => {
    const t = i18n.t.bind(i18n);
    expect(lastUsedLabel(0, t)).toBe(i18n.t("settings.cliAccess.lastUsedJustNow"));
    expect(lastUsedLabel(59, t)).toBe(i18n.t("settings.cliAccess.lastUsedJustNow"));
    expect(lastUsedLabel(60, t)).toContain("1 min");
    expect(lastUsedLabel(59 * 60, t)).toContain("59 min");
    expect(lastUsedLabel(2 * 3_600, t)).toContain("2 h");
    expect(lastUsedLabel(3 * 86_400, t)).toContain("3 days");
    // One day is the singular form, which is the plural-key wiring rather than
    // a formatting nicety: `_one` missing from a catalog reads as "1 days ago".
    expect(lastUsedLabel(86_400, t)).toContain("1 day ");
  });

  it("is rendered from the session state, and only while the door is open", async () => {
    readCliAccessState.mockResolvedValue({
      lastUsedSecsAgo: 7_260,
      commandOnPath: true,
      shimDir: null,
    });
    renderBlock({ enabled: true });
    await waitFor(() =>
      expect(screen.getByTestId("settings.cli-access-last-used").textContent).toContain("2 h"),
    );

    cleanup();
    renderBlock({ enabled: false });
    // A door that is shut has no session to report on.
    await waitFor(() => expect(readCliAccessState).toHaveBeenCalled());
    expect(screen.queryByTestId("settings.cli-access-last-used")).toBeNull();
  });
});

describe("PATH hint", () => {
  it("surfaces the one line the user adds when the shim is not reachable", async () => {
    readCliAccessState.mockResolvedValue({
      lastUsedSecsAgo: null,
      commandOnPath: false,
      shimDir: "/home/u/.local/bin",
    });
    renderBlock({ enabled: true });
    const hint = await waitFor(() => screen.getByTestId("settings.cli-access-path-hint"));
    // The directory must appear VERBATIM — an HTML-escaped path pasted into a
    // shell is a line that silently does not work.
    expect(hint.textContent).toContain('export PATH="/home/u/.local/bin:$PATH"');
  });

  it("stays hidden when the command already resolves", async () => {
    readCliAccessState.mockResolvedValue({
      lastUsedSecsAgo: null,
      commandOnPath: true,
      shimDir: "/home/u/.local/bin",
    });
    renderBlock({ enabled: true });
    await waitFor(() => expect(readCliAccessState).toHaveBeenCalled());
    expect(screen.queryByTestId("settings.cli-access-path-hint")).toBeNull();
  });

  it("stays hidden when there is no shim directory to point at", async () => {
    // The Windows shape: no shim mechanism, so no remedy to offer. Claiming
    // one would be worse than saying nothing.
    readCliAccessState.mockResolvedValue({
      lastUsedSecsAgo: null,
      commandOnPath: false,
      shimDir: null,
    });
    renderBlock({ enabled: true });
    await waitFor(() => expect(readCliAccessState).toHaveBeenCalled());
    expect(screen.queryByTestId("settings.cli-access-path-hint")).toBeNull();
  });

  it("is not shown while the door is shut", async () => {
    readCliAccessState.mockResolvedValue({
      lastUsedSecsAgo: null,
      commandOnPath: false,
      shimDir: "/home/u/.local/bin",
    });
    renderBlock({ enabled: false });
    await waitFor(() => expect(readCliAccessState).toHaveBeenCalled());
    expect(screen.queryByTestId("settings.cli-access-path-hint")).toBeNull();
  });
});

describe("exclusion list", () => {
  it("is editable with the door shut, so exclusions can be set BEFORE opening it", () => {
    // Deliberately not the `AiPanel` disabled-until-enabled shape: greying this
    // out would force open-wide-then-narrow, which is the wrong order for a
    // control whose job is to narrow.
    renderBlock({ enabled: false });
    expect(
      (screen.getByTestId("settings.cli-excluded-folders") as HTMLTextAreaElement).disabled,
    ).toBe(false);
  });

  it("seeds the editor from the persisted set, one folder per line", () => {
    renderBlock({ excludedFolders: ["Private/", "Journal/"] });
    expect(
      (screen.getByTestId("settings.cli-excluded-folders") as HTMLTextAreaElement).value,
    ).toBe("Private/\nJournal/");
  });

  it("drops blank lines and surrounding whitespace on the way to the backend", () => {
    // The backend NFC-sorts and dedups on encode, so trimming is all this side
    // owes — but an empty string would be a folder named "" that excludes
    // nothing and shows up in the persisted set forever.
    expect(foldersFromDraft("  Private/  \n\n\tJournal/\n   \n")).toEqual([
      "Private/",
      "Journal/",
    ]);
    expect(foldersFromDraft("")).toEqual([]);
    expect(foldersFromDraft("\n\n")).toEqual([]);
  });

  it("appends the trailing slash the exclusion predicate requires", () => {
    // The regression this pins (found by the cli5 E2E scenario, task 14): the
    // case above only ever fed ALREADY-slashed input, so nothing noticed that a
    // user typing `Private` got an entry `folder_is_excluded` can never match —
    // a privacy control that saves visibly and does nothing. Same
    // canonicalization as the note writer's own (`normalizeFolderPath`).
    expect(foldersFromDraft("Private")).toEqual(["Private/"]);
    expect(foldersFromDraft("Work/Secret")).toEqual(["Work/Secret/"]);
    // Idempotent, and structural noise collapses the same way the writer
    // collapses it — a pasted `/Private//` is the same folder.
    expect(foldersFromDraft("Private/")).toEqual(["Private/"]);
    expect(foldersFromDraft("/Private//")).toEqual(["Private/"]);
    // A line of nothing but slashes is root, and excluding root would close the
    // whole vault off — dropped, exactly like a blank line.
    expect(foldersFromDraft("/\n//")).toEqual([]);
  });
});

describe("toggles", () => {
  it("renders the door as off by default and reports a flip", async () => {
    const onSetEnabled = vi.fn();
    renderBlock({ enabled: false, onSetEnabled });
    const toggle = screen.getByTestId("settings.cli-access-toggle");
    expect(toggle.getAttribute("aria-checked")).toBe("false");
    expect(screen.getByTestId("settings.cli-access").getAttribute("data-enabled")).toBe("false");
    toggle.click();
    await waitFor(() => expect(onSetEnabled).toHaveBeenCalledWith(true));
  });

  it("treats an unset rate-limit preference as the limit being in force", () => {
    // `null` is "never chosen", and the default is that the limit applies — so
    // the removal switch must read OFF, not indeterminate.
    renderBlock({ rateLimitDisabled: null });
    expect(
      screen.getByTestId("settings.cli-rate-limit-toggle").getAttribute("aria-checked"),
    ).toBe("false");
    cleanup();
    renderBlock({ rateLimitDisabled: false });
    expect(
      screen.getByTestId("settings.cli-rate-limit-toggle").getAttribute("aria-checked"),
    ).toBe("false");
    cleanup();
    renderBlock({ rateLimitDisabled: true });
    expect(
      screen.getByTestId("settings.cli-rate-limit-toggle").getAttribute("aria-checked"),
    ).toBe("true");
  });
});

// ---------------------------------------------------------------------------
// myne-md/myne#613 (pr-review round 2): the CLI exclusion editor is an egress
// control, and it must be able to REMOVE and must CONVERGE.
//
// `cli_excluded_folders` is what keeps the terminal client out of a folder. Its
// AI sibling got three tests in round one and this file got none, so the whole
// seed-diff mechanism was covered on one list and uncovered on the other while
// both are the same promise to the user.
// ---------------------------------------------------------------------------

describe("CliAccessSettings: the excluded-folders editor", () => {
  it("a removal reaches the write as a removal", () => {
    const onSet = vi.fn();
    renderBlock({ excludedFolders: ["Private/", "Money/"], onSetExcludedFolders: onSet });
    const box = screen.getByTestId("settings.cli-excluded-folders") as HTMLTextAreaElement;
    expect(box.value).toBe("Private/\nMoney/");

    fireEvent.change(box, { target: { value: "Private/" } });
    fireEvent.blur(box);

    // THE ASSERTION, and it is on the SECOND argument. The first is the desired
    // set, which a removal and an add both produce; the baseline is what turns
    // it into a mutation, and passing `[]` there silently makes removal
    // impossible while every other assertion in this file still passes.
    const [folders, seededFrom] = onSet.mock.calls[0] as [string[], string[]];
    expect(folders).toEqual(["Private/"]);
    expect(seededFrom).toEqual(["Private/", "Money/"]);
  });

  it("converges on the stored set after a refused write", () => {
    // `usePrefs.writeExcludedFolders` re-reads disk on BOTH failure paths (a
    // budget refusal and a thrown write), so the prop holds truth afterwards.
    // Without the re-seed the textarea kept rendering the entry that was
    // refused, and the user was shown a folder listed as excluded from the CLI
    // that the CLI can read: fail-OPEN on an egress control.
    const { rerender } = render(
      <CliAccessSettings
        enabled
        excludedFolders={["Private/", "Refused/"]}
        rateLimitDisabled={null}
        onSetEnabled={() => {}}
        onSetExcludedFolders={() => {}}
        onSetRateLimitDisabled={() => {}}
      />,
    );
    rerender(
      <CliAccessSettings
        enabled
        excludedFolders={["Private/"]}
        rateLimitDisabled={null}
        onSetEnabled={() => {}}
        onSetExcludedFolders={() => {}}
        onSetRateLimitDisabled={() => {}}
      />,
    );
    expect(
      (screen.getByTestId("settings.cli-excluded-folders") as HTMLTextAreaElement).value,
    ).toBe("Private/");
  });

  it("does not clobber an edit in flight", () => {
    // Why the re-seed is guarded rather than unconditional. Same reason the AI
    // twin's is, and the guard is what makes convergence safe to add at all.
    const { rerender } = render(
      <CliAccessSettings
        enabled
        excludedFolders={["Private/"]}
        rateLimitDisabled={null}
        onSetEnabled={() => {}}
        onSetExcludedFolders={() => {}}
        onSetRateLimitDisabled={() => {}}
      />,
    );
    const box = screen.getByTestId("settings.cli-excluded-folders") as HTMLTextAreaElement;
    fireEvent.change(box, { target: { value: "TypedFirst/" } });
    rerender(
      <CliAccessSettings
        enabled
        excludedFolders={["Private/", "Landed/"]}
        rateLimitDisabled={null}
        onSetEnabled={() => {}}
        onSetExcludedFolders={() => {}}
        onSetRateLimitDisabled={() => {}}
      />,
    );
    expect(
      (screen.getByTestId("settings.cli-excluded-folders") as HTMLTextAreaElement).value,
    ).toBe("TypedFirst/");
  });
});
