// sp1 — Settings → Storage shows the path the vault is actually at, and the
// "open in Files" handoff really leaves. myne-md/myne#555, the
// `settings.panel.storage` bullet:
//
//   > the displayed path is comparable against the session's own `appDataDir`,
//   > the `openPath` handoff is interceptable at its IPC, and the "no file
//   > manager installed" case is the container's DEFAULT state — the one branch
//   > the item called unreachable is the only one it can take.
//
// # What the row is for, and how it fails
//
// It is the answer to "where are my notes". A user reads it to back the vault
// up by hand, to point a sync tool at it, or to check that a vault they thought
// they deleted is gone. So a path that is merely PLAUSIBLE is worse than no
// path: it sends someone to back up a directory that is not the one holding
// their notes, and they find out when they try to restore.
//
// Three ways it goes wrong, none of which raises anything:
//
//  * the resolution silently fails and the row shows its unavailable copy —
//    which reads as "we could not tell you" and is honest, but must not happen
//    on a normal launch;
//  * the row renders a stale module-scope memo from a previous vault (the
//    resolution IS memoized at module scope, deliberately, for the lifetime of
//    the process);
//  * the path is right and the button opens something else, or nothing, with no
//    sign either way.
//
// # The comparison is against the HARNESS, not against another IPC
//
// `app.appDataDir` is the directory the harness itself created and pointed
// `XDG_DATA_HOME` at before launch. Comparing the rendered path against that is
// an independent measurement: asking the app a second time through
// `plugin:path|resolve_directory` would compare the row against the same
// resolution that produced it, which passes whatever it resolved to.
//
// # The button, and the branch the roster row called unreachable
//
// The container ships no file manager, so `openPath` reaching the opener plugin
// is exactly the "no handler installed" case — the branch the roster row
// assumed could not be tested is the ONLY one this environment can take. What
// is asserted is that the failure is contained: the app does not crash, the
// path stays on screen for manual copying, and Settings stays open. That is the
// production contract the `.catch()` in `StoragePanel` states in a comment
// ("opener-plugin failure is non-fatal — the path is already shown for manual
// copy/paste"), and nothing was checking it.
//
// Vault-count precondition: 1 (weak KDF generator fixture).

import { expect, it } from "vitest";
import { describeE2E, scenario } from "./support/scenario";
import { seedVault, type SeededVault } from "./support/fixtures";
import { dismissImporterOffer, openSettings, unlockToEditor } from "./support/flows";
import { testIdSelector, type Session } from "./support/webdriver";

/** The path the row is showing, trimmed. */
async function shownPath(s: Session): Promise<string> {
  return ((await (await s.byTestId("storage.vault-path")).text()) ?? "").trim();
}

describeE2E("sp1 the storage panel shows the real vault path (myne-md/myne#555)", () => {
  // Vault-count precondition: 1 (weak KDF).
  it("renders the resolved path and survives an opener with nothing behind it", async () => {
    let seeded: SeededVault;
    await scenario(
      "sp1-storage-panel",
      { seed: (dir) => void (seeded = seedVault(dir, {})) },
      async (app) => {
        const s = app.session;
        await unlockToEditor(s, seeded.password);
        await dismissImporterOffer(s);
        await openSettings(s, "storage");

        // The row resolves asynchronously and shows a loading glyph first, so
        // the wait is for it to STOP being that rather than for the element.
        await s.waitUntil(
          async () => {
            const p = await shownPath(s);
            return p !== "" && p !== "…" ? p : null;
          },
          { label: "the storage row resolved a path", timeoutMs: 20_000 },
        );

        const shown = await shownPath(s);

        // The row's failure copy is a legitimate render, and it is what would
        // be on screen if resolution had failed — so it is called out by name
        // rather than being caught by the prefix check below with a message
        // about paths.
        expect(
          shown.toLowerCase(),
          "the storage row is showing its resolution-failed copy on a normal " +
            "launch, so the user is being told we cannot say where their notes are",
        ).not.toContain("unavailable");

        // THE assertion: the app's answer against the harness's own directory.
        // `app.appDataDir` is what the harness created and pointed
        // `XDG_DATA_HOME` at before launch, so this is two independent sources
        // agreeing rather than one source agreeing with itself.
        expect(
          shown,
          `Settings → Storage says the vault lives at "${shown}", but this ` +
            `session's app-data directory is "${app.appDataDir}". A user backing ` +
            `up the directory this row names would be backing up the wrong one, ` +
            `and would find out when they tried to restore.`,
        ).toContain(app.appDataDir);

        // …and it names the vaults directory specifically, not just the app
        // root. The row's own label promises where the VAULTS are.
        expect(shown.endsWith("vaults") || shown.includes("vaults"), `path was "${shown}"`).toBe(
          true,
        );

        // The container has no file manager registered, so this click reaches
        // the opener plugin and fails there. What matters is that it is
        // contained: no crash, the path still readable, Settings still up.
        await (await s.byTestId("storage.open-in-files")).click();

        await s.byTestId("settings.modal");
        expect(
          await shownPath(s),
          "the path stopped being readable after the open handoff failed, which " +
            "is the one thing the user still needed — the row exists so it can " +
            "be copied by hand when the button cannot work",
        ).toBe(shown);

        // The editor shell is still there, i.e. the WebView is alive rather than
        // showing a crash surface.
        //
        // `editor.settings-cta` rather than `editor.content`: this scenario
        // opens no note, and `editor.content` is the CodeMirror surface, which
        // does not exist until one is open. A first draft probed for it and
        // burned the full 45 s wait three times over on a scenario whose every
        // real assertion had already passed.
        await (await s.byTestId("settings.close")).click();
        await s.waitForGone(testIdSelector("settings.modal"));
        await s.byTestId("editor.settings-cta");
      },
    );
  });
});
