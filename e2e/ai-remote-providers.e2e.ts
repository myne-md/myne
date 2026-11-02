// The remote-provider consent flow, end to end on the real tauri-driver
// harness (ai-remote-providers myne#415 task 16).
//
// == WHAT THIS PROVES, AND WHAT IT DOES NOT ==
// **A fake fixture proves the plumbing, not the network** — the honesty bound
// the tor lane states about itself, and it applies here too. Nothing in this
// scenario reaches a real provider, and a green run is not evidence that a
// real OpenRouter or Ollama Cloud round trip works.
//
// == WHAT IS COVERED HERE ==
//   arp1 — the consent flow and the default-off posture, driven through the
//          REAL panel with nothing stubbed: Developer mode → Settings → AI →
//          no provider named → select one → the consent screen appears and
//          carries all four disclosures → cancel stores nothing → accept →
//          the missing-key state → paste a key → the stored state → revoke →
//          back to the never-configured state. A fixture listener counts
//          connections throughout and must see **zero**.
//   arp2 — that the wiring is LIVE: with a provider, a consent, a key and a
//          model all stored, the host's own capability report names the remote
//          backend — and the surfaces SYNC-14/SYNC-16 bar from that arm still
//          report available, because they fall back to the local one.
//
// == WHAT IS NOT COVERED HERE, AND WHY — READ THIS BEFORE "FIXING" IT ==
// The three remote FAILURE states (unauthorized / quota exhausted / provider
// unreachable) and the indicator naming the provider on a real remote answer
// are not driven here, because a request that actually reaches a provider
// cannot be faked without a production test hook, which `e2e/AGENTS.md`
// forbids outright ("Zero test hooks"):
//
//   * `ProviderHost` has a PRIVATE field and is minted only from the
//     compiled-in `PROVIDER_HOSTS` table, so a scenario cannot point the arm
//     at `127.0.0.1`. That is deliberate — it is the property that stops a
//     tampered `vault.prefs` redirecting note text.
//   * Even with a redirect, the transport verifies against the static
//     `webpki-roots` bundle with no `.dangerous()` escape, so a local
//     fixture's certificate cannot chain. Also deliberate, and asserted by
//     `there_is_no_verification_bypass_in_this_module`.
//
// **An earlier draft of this file attributed the WHOLE gap to those two
// properties, and that was wrong.** At the time the remote arm was not wired
// at all — `authorize_remote` and `RemoteEngine` had no caller outside their
// own files and `resolve_backends` registered no `Remote`-class backend — so
// there was no production path to drive, with or without a hook. Tasks 17 and
// 18 closed that, which is what arp2 below can now assert. What remains is
// only the far side of a real TLS connection.
//
// Those halves are covered at the level where they CAN be driven honestly:
// `provider_gate.rs::default_off_proof` and `state.rs::selection_proof` (two
// accept-counting probes, each with a control arm), `provider_transport.rs`
// (the status→cause mapping and the untrusted-certificate refusal), and
// `provider_registry.rs::remote_engine_tests` (the transport→engine mapping's
// pairwise distinctness). Closing the last of the E2E gap needs a design
// decision — a build-variant host table, the way `local-inference-stub` is a
// build variant — not a hook, and that decision is not this task's to make.
//
// KDF: weak generator fixture (SYNC-9 — params are vault.meta-resident).

import { expect, it } from "vitest";
import { describeE2E, scenario } from "./support/scenario";
import { seedVault } from "./support/fixtures";
import {
  dismissImporterOffer,
  enableDeveloperMode,
  pageSeatInvoke,
  pickSelect,
  unlockToEditor,
} from "./support/flows";
import { KEY, pressKey } from "./support/keyboard";
import { startFakeOllama, type FakeOllama } from "./support/fake-ollama";
import { type Session } from "./support/webdriver";

/** Open Settings → the AI panel.
 *
 *  Developer mode gates the whole rail group and is turned on through the
 *  shipped `enableDeveloperMode` helper — **not** through
 *  `pageSeatInvoke("plugin:prefs|set_developer_mode")`, which is what the first
 *  draft did and why both scenarios timed out on the AI rail entry for 15 s.
 *  A raw IPC pref write bypasses `writePref`, so the prefs NONCE is never
 *  bumped, so no sibling `usePrefs` instance learns the value changed and the
 *  open modal keeps rendering the old rail for the rest of the session. That is
 *  the exact failure `scripts/check-prefs-nonce.mjs` exists to prevent in
 *  production code, and it bites a scenario the same way.
 *
 *  It is also `e2e/AGENTS.md`'s rule stated plainly: build on the layers. */
async function openAiPanel(s: Session): Promise<void> {
  await enableDeveloperMode(s);
  const rail = await s.waitUntil(
    async () => (await s.byTestIdAll("settings.tab-ai")).at(0) ?? null,
    { label: "the AI rail entry (developer group)", timeoutMs: 15_000 },
  );
  await rail.click();
  await s.waitUntil(async () => (await s.byTestIdAll("settings.ai-panel")).at(0) ?? null, {
    label: "the AI panel",
    timeoutMs: 15_000,
  });
}

/** Turn the AI beta on through the real toggle. Every provider control in the
 *  panel is `disabled` while it is off — the same co-gate every other dependent
 *  control has — so a scenario that skips this reaches a field WebDriver
 *  refuses to focus, which is how the first run of this file failed. */
async function enableAiBeta(s: Session): Promise<void> {
  const checked = async () =>
    await (await s.byTestId("ai.enable-toggle")).attribute("aria-checked");
  if ((await checked()) !== "true") {
    await (await s.byTestId("ai.enable-toggle")).click();
    await s.waitUntil(async () => ((await checked()) === "true" ? true : null), {
      label: "the AI beta opt-in to take",
      timeoutMs: 15_000,
    });
  }
}

/** The host's own view of which backend answers, over production IPC. */
async function capabilityReport(s: Session): Promise<Record<string, unknown>> {
  const res = await pageSeatInvoke(
    s,
    "plugin:local-inference|ai_capability_report",
    {},
    15_000,
  );
  expect(res.err).toBeUndefined();
  return res.ok as Record<string, unknown>;
}

describeE2E("arp1 remote-provider consent flow (default-off, no real provider)", () => {
  // Vault-count precondition: 1 (weak KDF).
  it("routes a first selection through consent, and reaches nothing until a key is stored", async () => {
    // The fixture exists to be NOT contacted. It is a plain listener; nothing
    // in this scenario should ever connect to it, and the count is what says so.
    const fake: FakeOllama = await startFakeOllama();
    let password = "";
    try {
      await scenario(
        "arp1-remote-provider-consent",
        { seed: (dir) => { password = seedVault(dir).password; } },
        async (app) => {
          const s = app.session;
          await unlockToEditor(s, password);
          await dismissImporterOffer(s);
          await openAiPanel(s);
          await enableAiBeta(s);

          // ── nothing named: no provider control is selected, and the trust
          //    copy is the in-process one ──
          const invariant = await s.byTestId("ai.trust-invariant");
          expect(await invariant.textContent()).toContain("never sends your notes anywhere");
          const headline = await s.byTestId("ai.trust-headline");
          expect(await headline.textContent()).toContain("entirely on your device");
          expect(fake.accepts()).toBe(0);

          // The host agrees with the copy: nothing remote is selected.
          expect((await capabilityReport(s)).backend_class).not.toBe("remote");

          // ── the picker offers the closed set, all four rows ──
          // myne-md/myne#970. Two of them are OpenCode products on ONE host,
          // separated by path in the registry, so the row a user picks is the
          // only thing that decides which path a request takes. Asserted here
          // rather than only in a unit test because the panel's list is a
          // hand-written copy of the host's `KNOWN_AI_PROVIDERS`: a row dropped
          // from one side leaves a provider a user can select but never reach.
          {
            const trigger = await s.byTestId("ai.provider-choice");
            await trigger.scrollIntoView();
            await trigger.click();
            for (const wire of ["ollama-cloud", "openrouter", "opencode-zen", "opencode-go"]) {
              await s.waitForElement(
                `[data-testid="ai.provider-choice-option"][data-value="${wire}"]`,
              );
            }
            await pressKey(s, KEY.ESCAPE);
          }

          // ── selecting a provider shows the consent dialog and stores nothing ──
          await pickSelect(s, "ai.provider-choice", "openrouter");
          await s.waitUntil(
            async () => (await s.byTestIdAll("ai-consent.screen")).at(0) ?? null,
            { label: "the consent dialog", timeoutMs: 15_000 },
          );
          // All EIGHT disclosures are on screen BEFORE the accepting action:
          // and the accepting action exists nowhere else, so there is no route
          // that skips them.
          for (const id of [
            "ai-consent.what",
            "ai-consent.when",
            "ai-consent.who",
            "ai-consent.cannot-verify",
            "ai-consent.revoke",
            "ai-consent.scope",
            // How it travels (myne-md/myne#456). The clause is new and the
            // roster is what keeps it on the screen: a disclosure that can be
            // dropped without a test failing is a disclosure that gets dropped.
            "ai-consent.connection",
            // What never leaves (myne-md/myne#675). Same doctrine: the
            // excluded-folders clause is a disclosure, so it joins the roster
            // rather than relying on the unit suite alone.
            "ai-consent.excluded",
          ]) {
            const el = await s.byTestId(id);
            expect((await el.textContent())?.length ?? 0).toBeGreaterThan(20);
          }

          // ── Esc closes the consent dialog and NOT the Settings modal ──
          // Both surfaces listen for Escape on `window`, so an ungated press
          // closes the dialog and the shell under it: the user declines a
          // consent and the whole of Settings vanishes, which reads as a crash.
          // The shell stands its global keys down while a child dialog is up.
          await pressKey(s, KEY.ESCAPE);
          await s.waitUntil(
            async () => ((await s.byTestIdAll("ai-consent.screen")).length === 0 ? true : null),
            { label: "Esc closes the consent dialog", timeoutMs: 15_000 },
          );
          await s.byTestId("settings.modal");
          const afterEsc = await pageSeatInvoke(s, "plugin:prefs|prefs_read", {}, 15_000);
          expect((afterEsc.ok as { ai_provider?: unknown }).ai_provider ?? null).toBeNull();

          // ── cancel: nothing stored, and the controls come back ──
          await pickSelect(s, "ai.provider-choice", "openrouter");
          await s.waitUntil(
            async () => (await s.byTestIdAll("ai-consent.cancel")).at(0) ?? null,
            { label: "the consent dialog, reopened", timeoutMs: 15_000 },
          );
          await (await s.byTestId("ai-consent.cancel")).click();
          await s.waitUntil(
            async () => ((await s.byTestIdAll("ai-consent.screen")).length === 0 ? true : null),
            { label: "the consent dialog closes", timeoutMs: 15_000 },
          );
          const afterCancel = await pageSeatInvoke(s, "plugin:prefs|prefs_read", {}, 15_000);
          expect((afterCancel.ok as { ai_provider?: unknown }).ai_provider ?? null).toBeNull();

          // ── accept: the provider and the consent are stored together ──
          await pickSelect(s, "ai.provider-choice", "openrouter");
          await s.waitUntil(
            async () => (await s.byTestIdAll("ai-consent.accept")).at(0) ?? null,
            { label: "the accept action", timeoutMs: 15_000 },
          );
          await (await s.byTestId("ai-consent.accept")).click();
          await s.waitUntil(
            async () => (await s.byTestIdAll("ai.provider-key-input")).at(0) ?? null,
            { label: "the key field, once a provider is named", timeoutMs: 15_000 },
          );

          // Consent is STORED, not merely displayed — asserted positively so
          // the revoke assertion below cannot pass by the field never existing.
          //
          // The stored value is DEVICE-SCOPED (`protocol::prefs::CONSENT_DEVICE_SUFFIX`),
          // and asserting the bare wire name here would assert the legacy shape
          // the gate now refuses: `consent_is_device_scoped` requires the suffix,
          // so a bare `openrouter` reaching this field means an agreement made on
          // another device has synced in and would authorize sending note text to
          // a remote provider from THIS one. The suffix is the whole point of the
          // field, so the scenario names it.
          const consented = await pageSeatInvoke(s, "plugin:prefs|prefs_read", {}, 15_000);
          expect((consented.ok as { ai_provider_consent?: unknown }).ai_provider_consent).toBe(
            "openrouter@device",
          );

          // ── consented, but no key: the panel says so, distinctly from
          //    "no consent" ──
          const keyState = await s.byTestId("ai.provider-key-state");
          expect(await keyState.textContent()).toContain("No key is stored");
          expect(fake.accepts()).toBe(0);

          // ── the model chooser cannot ask before a key exists ──
          const load = await s.byTestId("ai.provider-model-load");
          expect(await load.attribute("disabled")).not.toBeNull();
          const modelState = await s.byTestId("ai.provider-model-state");
          expect(await modelState.textContent()).toContain("Load the list");

          // ── paste a key: the panel flips to the stored state and never
          //    renders the value back ──
          const keyField = await s.byTestId("ai.provider-key-input");
          await keyField.replaceText("sk-e2e-fixture-key");
          // Enter, which is one of the two acts that store a key. **It used to
          // be the ONLY one available here and blur was the other**, which is
          // what myne-md/myne#867 removed: a field that commits when it loses
          // focus stores a key the user never confirmed. The two acts now are
          // Enter and the confirm control beside the field
          // (`ai.provider-key-save`), and this scenario drives the keyboard
          // one because that is the path a paste-then-Enter takes.
          await pressKey(s, KEY.ENTER);
          await s.waitUntil(
            async () => {
              const el = (await s.byTestIdAll("ai.provider-key-state")).at(0);
              if (!el) return null;
              return (await el.textContent())?.includes("A key is stored") ? true : null;
            },
            { label: "the stored-key state", timeoutMs: 15_000 },
          );
          expect(await (await s.byTestId("ai.provider-key-input")).attribute("value")).not.toBe(
            "sk-e2e-fixture-key",
          );

          // ── revoke by clearing the provider: back to never-configured ──
          await pickSelect(s, "ai.provider-choice", "none");
          await s.waitUntil(
            async () => ((await s.byTestIdAll("ai.provider-key-input")).length === 0 ? true : null),
            { label: "the key control disappears", timeoutMs: 15_000 },
          );
          const afterRevoke = await pageSeatInvoke(s, "plugin:prefs|prefs_read", {}, 15_000);
          const view = afterRevoke.ok as {
            ai_provider?: unknown;
            ai_provider_consent?: unknown;
            ai_provider_model?: unknown;
          };
          expect(view.ai_provider ?? null).toBeNull();
          expect(view.ai_provider_consent ?? null).toBeNull();
          expect(view.ai_provider_model ?? null).toBeNull();

          // ── the whole walk contacted nothing ──
          expect(fake.accepts()).toBe(0);
          expect(fake.paths()).toEqual([]);
        },
      );
    } finally {
      await fake.close();
    }
  });
});

describeE2E("arp2 the remote arm is wired, and the bars fall back rather than break", () => {
  // Vault-count precondition: 1 (weak KDF).
  it("names the remote backend once everything is stored, and keeps the local surfaces working", async () => {
    const fake: FakeOllama = await startFakeOllama();
    let password = "";
    try {
      await scenario(
        "arp2-remote-arm-wired",
        { seed: (dir) => { password = seedVault(dir).password; } },
        async (app) => {
          const s = app.session;
          await unlockToEditor(s, password);
          await dismissImporterOffer(s);
          await openAiPanel(s);

          // The AI beta itself is one of the five preconditions, and the panel
          // is where a user turns it on — so it is turned on here, through the
          // real control.
          await enableAiBeta(s);

          // Everything stored, through production IPC rather than a seeded
          // file: these are the same commands the panel calls, and the point of
          // the scenario is the HOST's resulting view.
          for (const [cmd, args] of [
            ["plugin:prefs|set_ai_provider", { provider: "openrouter" }],
            ["plugin:prefs|set_ai_provider_consent", { grantedFor: "openrouter" }],
            ["plugin:prefs|set_ai_provider_key", { key: "sk-e2e-fixture-key" }],
            ["plugin:prefs|set_ai_provider_model", { model: "e2e/fixture-model" }],
          ] as const) {
            const res = await pageSeatInvoke(s, cmd, args, 15_000);
            expect(res.err, `${cmd} must succeed`).toBeUndefined();
          }

          // THE assertion this scenario exists for. Before tasks 17–18 this
          // read `in_process_local` no matter what the user configured, because
          // no `Remote`-class backend was registered at all.
          const report = await s.waitUntil(
            async () => {
              const r = await capabilityReport(s);
              return r.backend_class === "remote" ? r : null;
            },
            { label: "the host to select the remote backend", timeoutMs: 15_000 },
          );
          expect(report.backend_id).toBe("remote");

          // And the bars mean "barred from the remote arm", not "barred": the
          // surfaces that may never go remote still report available, because
          // they fall back to the local one. A build with no model reports
          // `no_model` here — never `remote_barred`, which is the regression
          // this asserts against.
          for (const feature of ["auto_tag", "transcription"] as const) {
            const f = report[feature] as { cause?: string | null };
            expect(f?.cause ?? null, `${feature} must not be barred`).not.toBe("remote_barred");
          }

          // Nothing in any of this touched a socket the fixture can see.
          expect(fake.accepts()).toBe(0);
        },
      );
    } finally {
      await fake.close();
    }
  });
});
