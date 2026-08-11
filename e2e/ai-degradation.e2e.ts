// The AI chat resting states, driven against a deliberately faulted backend
// (ai-backend-degradation myne#191 tasks 2–3).
//
// Runs against the **`local-inference-stub` build variant** — gated on
// `MYNE_E2E_AI=1`, like every other inference suite — because the fault lever
// (`MYNE_E2E_AI_FAULT`) is compiled only into that build. In an ordinary build
// the environment read does not exist, so setting the variable does nothing and
// these scenarios would silently assert against a working backend.
//
// == WHY THIS FILE EXISTS ==
// `StubEngine::tag_model_available()` answers `true` on purpose, so before the
// lever landed **no scenario had ever driven an unavailable backend** and every
// degradation path shipped with zero E2E coverage. The claim under test is not
// "an empty state renders" — it is that the states are DIFFERENT: a user whose
// runtime is merely not running must not be told to redo a setup they already
// did.
//
// The lever is set on `process.env` around `scenario()` rather than through a
// launch option: `launchApp` spawns tauri-driver with `...process.env` and the
// app inherits it, so this is the existing seam rather than a new one. It is
// cleared in a `finally` so a later spec in the same worker cannot inherit it.
//
// KDF: weak generator fixture (SYNC-9 — params are vault.meta-resident).

import { describe, expect, it } from "vitest";
import { describeE2E, scenario } from "./support/scenario";
import { seedVault } from "./support/fixtures";
import { KEY, pressChord } from "./support/keyboard";
import {
  closeSettings,
  dismissImporterOffer,
  enableDeveloperMode,
  runPaletteAction,
  typeIntoEditor,
  unlockToEditor,
} from "./support/flows";
import { type Session } from "./support/webdriver";

/** Only run against the `local-inference-stub` build (sets `MYNE_E2E_AI=1`) —
 *  the fault lever does not exist in any other binary. */
const aiDescribe = process.env.MYNE_E2E_AI === "1" ? describeE2E : describe.skip;

/** Turn the AI beta on through the real toggle, then open the chat tab. */
async function openChatWithAiOn(s: Session): Promise<void> {
  await enableDeveloperMode(s);
  await (await s.byTestId("settings.tab-ai")).click();
  await s.byTestId("settings.ai-panel");
  if ((await (await s.byTestId("ai.enable-toggle")).attribute("aria-checked")) !== "true") {
    await (await s.byTestId("ai.enable-toggle")).click();
    await s.waitUntil(
      async () =>
        (await (await s.byTestId("ai.enable-toggle")).attribute("aria-checked")) === "true"
          ? true
          : null,
      { label: "the AI beta opt-in to take", timeoutMs: 15_000 },
    );
  }
  await closeSettings(s);
  // Through the palette, the way `ai-chat.e2e.ts` does — the chat tab has no
  // direct affordance and a hand-rolled route would be a second one to keep
  // working.
  await runPaletteAction(s, "ai.open-chat", "chat");
  await s.byTestId("ai.chat-tab");
}

/** The resting cause the tab reports — a fixed identifier, never content. */
async function restingCause(s: Session): Promise<string | null> {
  return await (await s.byTestId("ai.chrome-status")).attribute("data-ai-cause");
}

async function restingBody(s: Session): Promise<string> {
  return (await (await s.byTestId("ai.status-no-model")).textContent()) ?? "";
}

/** Run one scenario with the stub faulted, and never leak the lever. */
async function withFault<T>(fault: string, run: () => Promise<T>): Promise<T> {
  process.env.MYNE_E2E_AI_FAULT = fault;
  try {
    return await run();
  } finally {
    delete process.env.MYNE_E2E_AI_FAULT;
  }
}

aiDescribe("ad1 the chat resting state names the cause it actually has", () => {
  // Vault-count precondition: 1 (weak KDF). Requires the local-inference-stub build.
  it("says no provider when the backend has nothing to answer with", async () => {
    let password = "";
    let cause: string | null = null;
    let body = "";
    await withFault("unavailable", () =>
      scenario(
        "ad1-no-provider",
        { seed: (dir) => { password = seedVault(dir).password; } },
        async (app) => {
          const s = app.session;
          await unlockToEditor(s, password);
          await dismissImporterOffer(s);
          await openChatWithAiOn(s);
          cause = await restingCause(s);
          body = await restingBody(s);
        },
      ),
    );
    expect(cause).toBe("no-provider");
    // The load-bearing half of the sentence: naming what stays quiet is what
    // lets a user tell a deliberate absence from a broken app.
    expect(body).toContain("chat, summaries, rewriting and semantic search");
  });
});

aiDescribe("ad2 a backend that is present and failing reads differently", () => {
  // Vault-count precondition: 1 (weak KDF). Requires the local-inference-stub build.
  it("does not tell a user with a broken backend to go and set one up", async () => {
    let password = "";
    let cause: string | null = null;
    let body = "";
    await withFault("failing", () =>
      scenario(
        "ad2-provider-failing",
        { seed: (dir) => { password = seedVault(dir).password; } },
        async (app) => {
          const s = app.session;
          await unlockToEditor(s, password);
          await dismissImporterOffer(s);
          await openChatWithAiOn(s);
          cause = await restingCause(s);
          body = await restingBody(s);
        },
      ),
    );
    // `failing` keeps `tag_model_available() == true` — the model exists, it
    // errors — so this is NOT the no-provider state.
    expect(cause).not.toBe("no-provider");
    // And the sentence must not send them to a setup they have already done.
    expect(body).not.toContain("Set one up in Settings");
  });
});

aiDescribe("ad3 an explicit AI action always answers, even when it cannot run", () => {
  // Vault-count precondition: 1 (weak KDF). Requires the local-inference-stub build.
  it("toasts when a rewrite cannot happen, instead of doing nothing at all", async () => {
    let password = "";
    await withFault("unavailable", () =>
      scenario(
        "ad3-rewrite-answers",
        { seed: (dir) => { password = seedVault(dir).password; } },
        async (app) => {
          const s = app.session;
          await unlockToEditor(s, password);
          await dismissImporterOffer(s);
          await openChatWithAiOn(s);

          // Type something and select it, then run the palette action.
          await typeIntoEditor(s, "the quick brown fox");
          // Select it — the rewrite acts on a selection and no-ops without one,
          // which would make the toast's absence mean the wrong thing.
          await pressChord(s, KEY.CONTROL, "a");
          await runPaletteAction(s, "ai.rewrite-selection", "rewrite");

          // The whole point: BEFORE this fix the user got no toast, no error and
          // no document change — indistinguishable from the action never firing.
          const toast = await s.waitUntil(
            async () => (await s.byTestIdAll("editor.toast")).at(0) ?? null,
            { label: "the rewrite failure toast", timeoutMs: 20_000 },
          );
          expect((await toast.textContent()) ?? "").toContain("nothing was rewritten");
        },
      ),
    );
  });
});
