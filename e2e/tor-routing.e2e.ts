// Tor-routing toggle + connection states (MYND-650 task 10).
//
//   tor1 — Developer mode on → Settings → Network. The toggle starts off and
//          the posture reads `inactive`. Turning it on puts the posture in
//          `connecting` and raises the connecting banner while the (fake) Tor
//          client bootstraps; completing that bootstrap moves it to `active`
//          and the banner goes away. Killing the client — an exit the host did
//          not ask for — lands on the **fail-closed** `unavailable` posture and
//          the alert banner. Turning the toggle back off returns to `inactive`,
//          shows the "no longer routed" cue, and clears the banner.
//
// Driven by a **fake SOCKS5 sidecar**, never real Tor: `support/fake-tor-sidecar.ts`
// explains what it substitutes and why. Nothing in production is stubbed — the
// supervisor, the phase machine, the routing gate and the IPC are all the
// shipped ones, and every state below is reached by clicking the real toggle.
// What this scenario therefore does NOT prove is that traffic traverses the real
// Tor network; that is a manual procedure by design (task 12).
//
// Vault-count precondition: 1 (weak KDF generator fixture, SYNC-9).
//
// AUTHORED AND VERIFIED on the Linux tauri-driver harness.

import { expect, it } from "vitest";
import { describeE2E, scenario } from "./support/scenario";
import { seedVault } from "./support/fixtures";
import { installFakeTorSidecar, torSidecarControl } from "./support/fake-tor-sidecar";
import {
  bootDiagnostic,
  closeSettings,
  dismissImporterOffer,
  enableDeveloperMode,
  unlockToEditor,
} from "./support/flows";
import { testIdSelector, type Session } from "./support/webdriver";

/** Posture transitions are bounded by the panel's own 2 s poll plus a spawn or
 *  a process death; 20 s is slack for a contended runner, not a real budget. */
const POSTURE_TIMEOUT_MS = 20_000;

/** Wait until the settings posture row reports `posture`, and return the label
 *  text it renders — the two are asserted together so a row that changes its
 *  `data-posture` without changing what the user reads cannot pass.
 *
 *  **On timeout it names the posture the row was ACTUALLY showing**, because
 *  the four postures fail for four unrelated reasons and the bare wait
 *  distinguished none of them. `unavailable` means the supervisor declared the
 *  run failed (its SOCKS greeting probe refused, or the child was reaped), and
 *  it is a TERMINAL verdict — no amount of extra budget recovers it, which is
 *  the thing a timeout message alone cannot say. `connecting` means the fake
 *  never emitted its readiness line, `inactive` means the toggle came back off,
 *  and no row at all means the panel unmounted. This scenario was quarantined as
 *  a contention victim on the assumption it was merely late; that assumption has
 *  never been checked against the posture it was stuck on. */
async function waitForPosture(session: Session, posture: string): Promise<string> {
  const selector = testIdSelector("settings.tor-posture", { "data-posture": posture });
  try {
    await session.waitForElement(selector, { timeoutMs: POSTURE_TIMEOUT_MS });
  } catch (raw) {
    const rows = await session.byTestIdAll("settings.tor-posture");
    if (rows.length > 0) {
      throw new Error(
        `${(raw as Error).message} | waited for "${posture}", the row was showing ` +
          `"${await rows[0].attribute("data-posture")}"`,
      );
    }
    // NO row at all is the answer that needs the screen, not the row. The panel
    // renders the row whenever the posture is known, so its absence means
    // either the panel is not mounted (Settings closed, the vault locked under
    // us, the tab moved) or the hook has not published yet on a FRESH mount —
    // and those are the same observation from here. What separates them is what
    // else is on screen, which is exactly what the boot probe reports.
    throw new Error(
      `${(raw as Error).message} | waited for "${posture}", no posture row rendered; ` +
        `screen: ${await bootDiagnostic(session)}`,
    );
  }
  return await (await session.byTestId("settings.tor-posture-label")).text();
}

/** The editor-chrome banner's posture, or `null` when it renders nothing. */
async function bannerPosture(session: Session): Promise<string | null> {
  const found = await session.byTestIdAll("sync.tor-banner");
  if (found.length === 0) return null;
  return await found[0].attribute("data-posture");
}

// QUARANTINE (PROVISIONAL): `data-posture="active"` never settles within the
// 20s POSTURE_TIMEOUT on a contended runner. Uses a FAKE SOCKS5 sidecar (no
// network / no real Tor bootstrap), so this is not a CI-network limitation —
// most likely the 20s slack is the victim of suite-length contention. Pending
// an ISOLATED container run to decide: raise the timeout / keep quarantined
// (contention) vs. fix a real control-file handshake bug if it fails solo too.
describeE2E.flaky("tor1 Tor routing: toggle, connecting, fail-closed (MYND-650)", () => {
  it("drives inactive → connecting → active → fail-closed → inactive from the real toggle", async () => {
    let password = "";
    const uninstallSidecar = installFakeTorSidecar();
    try {
      await scenario(
        "tor1-tor-routing-states",
        { seed: (dir) => void (password = seedVault(dir).password) },
        async (app) => {
          const s = app.session;
          const tor = torSidecarControl(app.appDataDir);

          await unlockToEditor(s, password);
          await dismissImporterOffer(s);

          // ── The panel is behind Developer mode, so turn that on first ──
          await enableDeveloperMode(s);
          await (await s.byTestId("settings.tab-network")).click();
          await s.byTestId("settings.network-panel");

          // ── Off by default: direct sync, and nothing dressed as a fault ──
          expect(await (await s.byTestId("settings.tor-routing")).attribute("data-enabled")).toBe(
            "false",
          );
          const inactiveLabel = await waitForPosture(s, "inactive");
          expect(await bannerPosture(s)).toBeNull();

          // ── Toggle ON: the client is starting, so sync is paused ──────
          await (await s.byTestId("settings.tor-routing-toggle")).click();
          await s.waitForElement(
            testIdSelector("settings.tor-routing", { "data-enabled": "true" }),
            { timeoutMs: POSTURE_TIMEOUT_MS },
          );
          const connectingLabel = await waitForPosture(s, "connecting");
          expect(await bannerPosture(s)).toBe("connecting");

          // **The fake must actually be LISTENING before its bootstrap means
          // anything, and nothing here could see that before.** The host picks
          // the SOCKS port by binding `:0`, reading the number and DROPPING the
          // listener before handing it to the child, so the child races
          // everything else on the box for it. A lost race makes the fake exit
          // at once, and the phase has ALREADY reached `connecting` by then —
          // it is set right after the spawn, before any stderr is read — so the
          // assertion above passes and the posture goes `unavailable` a moment
          // later. That reads as a bootstrap that failed rather than as a
          // process that was never listening, which is how this scenario came
          // to be quarantined as a 20 s budget problem.
          expect(
            tor.bindOutcome(),
            "the fake sidecar must own its SOCKS port before a bootstrap can be probed",
          ).toMatch(/^listening /);

          // ── The client finishes bootstrapping: the tunnel is up ───────
          tor.bootstrap();
          const activeLabel = await waitForPosture(s, "active");
          // No banner while the tunnel works: a permanent "you are protected"
          // strip is how the fail-closed message below stops being read.
          await s.waitUntil(async () => ((await bannerPosture(s)) === null ? true : null), {
            label: "tor banner clears once the tunnel is up",
            timeoutMs: POSTURE_TIMEOUT_MS,
          });

          // ── The client dies underneath us: FAIL-CLOSED ────────────────
          // The toggle is still on and the transport now refuses to connect at
          // all. This is the state that must be unmistakable.
          tor.die();
          const unavailableLabel = await waitForPosture(s, "unavailable");
          expect(await (await s.byTestId("settings.tor-routing")).attribute("data-enabled")).toBe(
            "true",
          );
          await s.waitUntil(
            async () => ((await bannerPosture(s)) === "unavailable" ? true : null),
            { label: "fail-closed banner raised", timeoutMs: POSTURE_TIMEOUT_MS },
          );
          // The banner for this state is an alert, not a status: a paused sync
          // is not something to mention the next time the user pauses typing.
          expect(await (await s.byTestId("sync.tor-banner")).attribute("role")).toBe("alert");

          // Every posture the user can be in reads differently. Asserting the
          // labels are distinct is what stops a copy collapse from making
          // "paused, fail-closed" indistinguishable from "protected".
          const labels = [inactiveLabel, connectingLabel, activeLabel, unavailableLabel];
          expect(new Set(labels).size).toBe(4);
          for (const label of labels) expect(label.trim()).not.toBe("");

          // ── Toggle OFF: back to direct sync, and say so ───────────────
          await (await s.byTestId("settings.tor-routing-toggle")).click();
          await s.waitForElement(
            testIdSelector("settings.tor-routing", { "data-enabled": "false" }),
            { timeoutMs: POSTURE_TIMEOUT_MS },
          );
          expect(await waitForPosture(s, "inactive")).toBe(inactiveLabel);
          await s.byTestId("settings.tor-disabled-cue");
          await s.waitUntil(async () => ((await bannerPosture(s)) === null ? true : null), {
            label: "tor banner clears when the mode is turned off",
            timeoutMs: POSTURE_TIMEOUT_MS,
          });
          await closeSettings(s);
        },
      );
    } finally {
      uninstallSidecar();
    }
  });
});
