// Quick-unlock (PIN) end-to-end suite (MYND-329, MYND-558).
//
// Pins the PIN quick-unlock flow through the production bundle: from an
// unlocked editor, configure a PIN in Settings → Privacy, lock the vault, and
// re-enter with the PIN (NOT the master password) — then a wrong PIN reports
// the remaining-attempts count. The biometric (Touch ID) path is deliberately
// NOT E2E-driven: it is hardware-gated (no WebDriver path) and HARDWARE-
// UNVERIFIED (see `core/.../quick_unlock/apple.rs`); its surrounding logic
// is covered by the Rust `cargo test` provider/command suites with a mock.
//
// Spring-loaded gate, two stories:
//   qu1 locks WITHIN the same app session (via the editor Lock CTA), so the
//     `full_unlock_this_session` gate is open (the earlier `unlockToEditor`
//     opened it) and the PIN affordance IS offered.
//   qu2 drives the COLD START: a fresh process has no full unlock yet, so the
//     gate is closed, `quick_unlock_status` reports `available: false`, and the
//     PIN field must NOT appear on the Unlock screen even though the credential
//     is on disk — the user must type their master password. Reproduces the
//     "PIN screen shown on first launch" bug (status now mirrors the redeem
//     gate). A genuine restart is a second process, so qu2 runs two launches
//     that share the vault dir.
//
// Surface precedence (MYND-558), one story:
//   qu3 pins that an offered PIN is the ONLY credential surface — the password
//     form is not rendered beside it (the reported bug: both prompts at once
//     after PIN setup, with no cue which one the app wanted) — and that the
//     "Use password instead" link trades one for the other and still unlocks.
//     The complementary no-PIN fallback is qu2 plus every other suite that
//     boots straight into the password form.
//
// Post-unlock pipeline parity, one story:
//   qu4 pins that a PIN unlock runs the SAME post-unlock pipeline as a password
//     unlock. The regression it guards: quick-unlock installed its `Unlocked`
//     slot without running any of it, so a PIN unlock opened a vault whose
//     search index (zeroized on every lock, hydrated only by that pipeline)
//     was empty — a search that had worked seconds earlier returned nothing.
//     The pipeline's other observable member, the persisted screen-capture
//     preference, is native state WebDriver cannot see; it is pinned by the
//     Rust test `quick_unlock_reapplies_the_persisted_screen_capture_preference`
//     instead. Search is the browser-visible half of the same fix.
//
// Precondition: exactly 1 vault (weak KDF — unlock reads params from vault.meta).
//
// Verified 3× green in the Linux tauri-driver container (`./scripts/e2e-local.sh`,
// 2026-06-24; re-verified with qu3 on 2026-07-25). The PIN-setup completion wait
// (`configurePinInSettings`) is the load-bearing de-flake: reading the
// always-present status text the instant the element is found races the async
// Argon2id setup and failed ~1 in 3.

import { cpSync, rmSync } from "node:fs";
import { it } from "vitest";
import { describeE2E, scenario } from "./support/scenario";
import { seedVault } from "./support/fixtures";
import {
  createNote,
  dismissImporterOffer,
  dismissImporterOfferIfPresent,
  editorText,
  openSettings,
  closeSettings,
  searchAndOpenNote,
  typeIntoEditor,
  unlockToEditor,
  waitForSaved,
} from "./support/flows";
import { testIdSelector, type Session } from "./support/webdriver";

const PIN = "135790";
const WRONG_PIN = "024680";

/** Read the `data-note-id` of the currently-selected sidebar row — the note
 *  `createNote` just created and left selected. Mirrors the helper in
 *  `search-palette.e2e.ts`; the sidebar row carries `aria-current="true"`
 *  alongside `data-note-id`, which is the byTestId-only path to a
 *  live-created note's id. */
async function selectedNoteId(s: Session): Promise<string> {
  const row = await s.waitForElement(
    '[data-testid="notes.row"][aria-current="true"]',
  );
  const id = await row.attribute("data-note-id");
  if (id === null || id === "") {
    throw new Error("selected notes.row carried no data-note-id");
  }
  return id;
}

/**
 * Configure a PIN in Settings → Privacy from an unlocked editor.
 *
 * The setup runs Argon2id off the UI thread, then `refresh()` re-reads the
 * status — only when that lands does `configured` flip true, the "Set PIN"
 * button unmount, and the helper text become "Configured via PIN". Waiting for
 * the button to disappear is the deterministic completion signal; reading the
 * status text the instant the (always-present) status element is found races
 * that async setup and flakes (~1 in 3).
 */
async function configurePinInSettings(s: Session): Promise<void> {
  await openSettings(s, "privacy");
  await (await s.byTestId("settings.quick-unlock-toggle")).click();
  // Toggling on reveals the PIN setup row.
  await (await s.byTestId("settings.quick-unlock-pin-input")).replaceText(PIN);
  await (await s.byTestId("settings.quick-unlock-setup-pin")).click();
  // Setup complete → the setup row unmounts. Now the status text is settled.
  await s.waitForGone(testIdSelector("settings.quick-unlock-setup-pin"));
  const status = await s.byTestId("settings.quick-unlock-status");
  if (!(await status.textContent()).includes("Configured via PIN")) {
    throw new Error("quick-unlock status did not report PIN configured");
  }
  await closeSettings(s);
}

describeE2E("qu1 PIN quick-unlock round-trip (MYND-329)", () => {
  // Precondition: exactly 1 vault (weak KDF).
  it("configures a PIN, locks, and re-enters with the PIN (wrong PIN counts down)", async () => {
    let password = "";
    await scenario(
      "qu1-pin-roundtrip",
      {
        seed: (dir) => {
          const v = seedVault(dir);
          password = v.password;
        },
      },
      async (app) => {
        const s = app.session;
        await unlockToEditor(s, password);
        await dismissImporterOffer(s);

        // ---- Configure a PIN in Settings → Privacy --------------------------
        await configurePinInSettings(s);

        // ---- Lock the vault (same session → spring-loaded gate open) --------
        await (await s.byTestId("editor.lock-cta")).click();
        // The Unlock screen shows the quick-unlock PIN affordance.
        await s.byTestId("unlock.quick-pin-input");

        // ---- Wrong PIN first: the remaining-attempts note appears ----------
        await (await s.byTestId("unlock.quick-pin-input")).replaceText(WRONG_PIN);
        await (await s.byTestId("unlock.quick-pin-submit")).click();
        const note = await s.waitForElement('[data-testid="unlock.quick-note"]');
        if (!(await note.textContent()).toLowerCase().includes("attempt")) {
          throw new Error("wrong PIN did not surface the remaining-attempts note");
        }

        // ---- Correct PIN: back to the editor (Lock CTA present again) -------
        await (await s.byTestId("unlock.quick-pin-input")).replaceText(PIN);
        await (await s.byTestId("unlock.quick-pin-submit")).click();
        await s.byTestId("editor.lock-cta", { timeoutMs: 15_000 });
      },
    );
  });
});

describeE2E("qu2 PIN quick-unlock hidden on a cold start (MYND-329)", () => {
  // Precondition: exactly 1 vault (weak KDF). Two launches share one vault dir.
  // Launch 1 configures a PIN (which opens the spring-loaded session gate, but
  // that gate is process-local). Launch 2 boots a SEPARATE process from a copy
  // of that vault dir — the credential is on disk, but no full unlock has
  // happened this session, so the gate is closed and the PIN field must stay
  // hidden. The master password is still the way in.
  it("does not offer the PIN on a fresh launch; the password still unlocks", async () => {
    let password = "";
    let warmAppDataDir = "";
    let warmDataHome = "";

    // ---- Launch 1: configure a PIN, then quit -----------------------------
    await scenario(
      "qu2-warm-configure",
      {
        // Keep the dir on teardown so launch 2 can copy the configured vault
        // (incl. the freshly-written vault.quickunlock credential).
        keepDataDir: true,
        seed: (dir) => {
          const v = seedVault(dir);
          password = v.password;
        },
      },
      async (app) => {
        const s = app.session;
        warmAppDataDir = app.appDataDir;
        warmDataHome = app.dataHome;
        await unlockToEditor(s, password);
        await dismissImporterOffer(s);
        await configurePinInSettings(s);
      },
    );

    // ---- Launch 2: genuine cold start from a copy of the configured vault --
    try {
      await scenario(
        "qu2-cold-start",
        {
          seed: (dir) => {
            // `dir` is launch 2's empty appDataDir. Lay launch 1's vault tree
            // (vault.meta + vault.quickunlock + …) into it. The app resolves
            // every path from app_data_dir at runtime, so relocating the tree
            // to a new absolute home is transparent.
            cpSync(warmAppDataDir, dir, { recursive: true });
          },
        },
        async (app) => {
          const s = app.session;
          // Single vault → boot lands straight on the Unlock screen. Waiting for
          // the password field confirms the screen has settled: since MYND-558
          // the Unlock screen owns the `quick_unlock_status` probe and renders
          // NO credential field until it resolves, so the password input can
          // only be here because the probe already answered "not redeemable" —
          // a regression that offered the PIN would fail the waitForGone below.
          await s.byTestId("unlock.password-input");

          // The bug: on a cold start the gate is closed, status reports
          // `available: false`, and the PIN affordance must NOT appear.
          await s.waitForGone(testIdSelector("unlock.quick-pin-input"));
          await s.waitForGone(testIdSelector("unlock.quick-unlock"));

          // The master password is the escape hatch and still unlocks. (qu1
          // already covers the positive side — the PIN returns after a full
          // unlock + a same-session relock.)
          await unlockToEditor(s, password);
        },
      );
    } finally {
      // Launch 1 kept its data dir; reap it now.
      if (warmDataHome) rmSync(warmDataHome, { recursive: true, force: true });
    }
  });
});

describeE2E("qu3 PIN is the only surface, password is one click away (MYND-558)", () => {
  // Precondition: exactly 1 vault (weak KDF). Same-session lock, so the
  // spring-loaded gate is open and the PIN affordance is offered.
  it("hides the password form behind a reveal, then unlocks with the password", async () => {
    let password = "";
    await scenario(
      "qu3-pin-primary",
      {
        seed: (dir) => {
          const v = seedVault(dir);
          password = v.password;
        },
      },
      async (app) => {
        const s = app.session;
        await unlockToEditor(s, password);
        await dismissImporterOffer(s);
        await configurePinInSettings(s);

        // ---- Lock: the PIN owns the screen, the password form is absent -----
        await (await s.byTestId("editor.lock-cta")).click();
        // Finding the PIN field first means the screen has settled — the status
        // probe that decides the surface has already resolved, so a regression
        // that renders both would be on the page for the checks below.
        await s.byTestId("unlock.quick-pin-input");
        await s.waitForGone(testIdSelector("unlock.password-input"));
        await s.waitForGone(testIdSelector("unlock.form"));

        // ---- Reveal: the password replaces the PIN, it does not join it -----
        await (await s.byTestId("unlock.use-password-link")).click();
        await s.byTestId("unlock.password-input");
        await s.waitForGone(testIdSelector("unlock.quick-pin-input"));
        await s.waitForGone(testIdSelector("unlock.quick-unlock"));

        // ---- The revealed password path still unlocks the vault -------------
        await unlockToEditor(s, password);
      },
    );
  });
});

describeE2E("qu4 PIN unlock runs the post-unlock pipeline (search survives)", () => {
  // Precondition: exactly 1 vault (weak KDF). Same-session lock, so the
  // spring-loaded gate is open and the PIN affordance is offered.
  it("finds a note by search after re-entering with the PIN", async () => {
    // A single distinctive token, per the search-palette suite's shape. The
    // leading space gives it a clean word boundary after `typeIntoEditor`'s
    // sacrificial probe char.
    const QUERY = "pipelinequokka";
    const BODY = ` ${QUERY} pintail7q4z`;
    let password = "";
    await scenario(
      "qu4-pin-search-hydrate",
      {
        seed: (dir) => {
          const v = seedVault(dir);
          password = v.password;
        },
      },
      async (app) => {
        const s = app.session;
        await unlockToEditor(s, password);
        await dismissImporterOffer(s);

        // ---- A real note the search index must know about -------------------
        await createNote(s, "Pipeline Note");
        await typeIntoEditor(s, BODY);
        await waitForSaved(s);
        const noteId = await selectedNoteId(s);

        await configurePinInSettings(s);

        // ---- Lock (which zeroizes the index) and re-enter with the PIN ------
        await (await s.byTestId("editor.lock-cta")).click();
        await s.byTestId("unlock.quick-pin-input");
        await (await s.byTestId("unlock.quick-pin-input")).replaceText(PIN);
        await (await s.byTestId("unlock.quick-pin-submit")).click();
        await s.byTestId("editor.lock-cta", { timeoutMs: 15_000 });
        await dismissImporterOfferIfPresent(s);

        // ---- The note is searchable again -----------------------------------
        //
        // This is the whole assertion: before the fix the PIN path skipped the
        // hydrate, the palette rendered no NOTES hit, and this call timed out
        // waiting for the row. Opening the specific note (rather than counting
        // rows) also proves the hit is the real note, not a stale entry.
        await searchAndOpenNote(s, QUERY, noteId);
        const body = await editorText(s);
        if (!body.includes(QUERY)) {
          throw new Error("search result opened a note without the query token");
        }
      },
    );
  });
});
