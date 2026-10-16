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
import { KEY } from "./support/keyboard";
import {
  createNote,
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
/** The resting cause AND the sentence that goes with it, read from the SAME
 *  element in ONE round trip, after the value has stopped moving.
 *
 *  These used to be two reads against two elements. Both derive from the same
 *  `resting` value in `AiChatTab.tsx`, so they cannot disagree WITHIN a render —
 *  but two WebDriver round trips are not within a render, and the backend probe
 *  resolves while the panel is open. ad2 caught exactly that: it read a cause
 *  that was not `no-provider`, the state then settled, and it read a body that
 *  was the no-provider sentence — so it asserted a contradiction that never
 *  existed at any single moment, and reported it as a product defect.
 *
 *  `ai.status-no-model` carries `data-ai-cause` itself, so one element answers
 *  both. The settle loop then requires the same cause twice in a row before
 *  anything is asserted about it. */
async function restingState(s: Session): Promise<{ cause: string | null; body: string }> {
  const read = async (): Promise<{ cause: string | null; body: string } | null> =>
    s.execute<{ cause: string | null; body: string } | null>(
      "var el = document.querySelector('[data-testid=\"ai.status-no-model\"]');" +
        "if (el) return { cause: el.getAttribute('data-ai-cause'), body: el.textContent || '' };" +
        "var c = document.querySelector('[data-testid=\"ai.chrome-status\"]');" +
        "return c ? { cause: c.getAttribute('data-ai-cause'), body: '' } : null;",
    );
  let previous: string | null | undefined;
  return s.waitUntil(
    async () => {
      const now = await read();
      if (now === null) return null;
      const settled = previous !== undefined && previous === now.cause;
      previous = now.cause;
      return settled ? now : null;
    },
    { label: "AI resting state settled", timeoutMs: 20_000 },
  );
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
  it("names the setup problem the backend actually has", async () => {
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
          const state = await restingState(s);
          cause = state.cause;
          body = state.body;
        },
      ),
    );
    // **The id moved with myne-md/myne#867, and the assertion moved with it.**
    // `no-provider` was a bucket this surface computed from four arms, and it
    // existed mostly because everything the bucket did not recognise fell into
    // it: a vault with a provider named and no consent recorded read "No
    // provider". The id is now the host's own cause (`EngineError::kind()`), so
    // what this pins is that a fresh vault with AI on and nothing configured
    // reads as a SETUP problem rather than as a fault, whichever of the two
    // causes the stub reports for this lever.
    expect(["not_ready", "no_model"]).toContain(cause);
    // The load-bearing half of the sentence: naming the fix is what lets a user
    // tell a deliberate absence from a broken app.
    expect(body.toLowerCase()).toMatch(/nothing is ready|no model here to run/);
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
          const state = await restingState(s);
          cause = state.cause;
          body = state.body;
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

          // **A note has to be OPEN before anything can be typed.** `unlockToEditor`
          // lands on the editor stage with no tab active, so `.cm-content` does not
          // exist and `typeIntoEditor` waits out its whole budget on
          // `editor located + focused`. This scenario is the only one in the file
          // that types, which is why it was the only one red; the artefact shows
          // the chat tab present and no CodeMirror node at all.
          await createNote(s, "ad3notealfa7k2m9qx4w8e5rj0aa");

          // Type something and select it, then run the palette action.
          await typeIntoEditor(s, "the quick brown fox");
          // Select it — the rewrite acts on a selection and no-ops without one,
          // which would make the toast's absence mean the wrong thing.
          // **Sent to the ELEMENT, not through the Actions API, and that is the
          // whole fix.** Two selection attempts failed here before this one:
          // `Ctrl+A` (which is anyway the SCOPED select-all in this editor,
          // `editor/src/keymap.ts`) and then `pressKey(HOME, {shift})`. Both go
          // through `POST /actions`, which delivers to whatever holds FOCUS.
          // `typeIntoEditor` lands its text with `Element.sendKeys`, which
          // targets the element directly and works with or without focus, so
          // the text arriving proved nothing about where focus was. The
          // selection keys went somewhere else, `state.selection.main` stayed
          // empty, `resolveRewriteRange` returned null, and the scenario blamed
          // the backend for a selection nobody had made.
          //
          // `Element.sendKeys` takes W3C sticky modifiers: U+E008 (Shift) stays
          // down for the rest of the sequence, so this is Shift+Home at the
          // editor, independent of focus.
          const content = await s.waitForElement(
            '[data-testid="editor.content"] .cm-content',
          );
          await content.sendKeys(KEY.SHIFT + KEY.HOME);
          // **Verify the selection rather than assume it.** The comment above
          // says the rewrite no-ops without one, and that is exactly why the
          // absence has to be ruled out HERE: without this the scenario cannot
          // tell "the backend failed and said nothing" from "there was nothing
          // selected", and it spent its budget blaming the first for the second.
          // Read through the DOM selection, which is what a user would see
          // highlighted — no app hook, same class as the harness's other
          // `execute` reads.
          // **Assert the selection is INSIDE the editor, not merely non-empty.**
          // A length-only check passed while the rewrite still saw an empty
          // `state.selection`, which is the ambiguity that cost three attempts:
          // a DOM selection somewhere else on the page satisfies "length > 0"
          // and tells CodeMirror nothing. Anchoring it to `.cm-content` is what
          // makes the check mean what the next line depends on.
          await s.waitUntil(
            async () =>
              (await s.execute<boolean>(
                "var sel = window.getSelection();" +
                  "if (!sel || sel.rangeCount === 0 || sel.isCollapsed) return false;" +
                  "var n = sel.anchorNode;" +
                  "var el = n && n.nodeType === 1 ? n : n && n.parentElement;" +
                  // `.cm-focused` is the load-bearing half. CodeMirror owns a
                  // selection in its STATE only while it holds focus; a native
                  // DOM selection inside `.cm-content` on an unfocused editor
                  // satisfies every weaker check and tells CM6 nothing, which is
                  // exactly what the previous two probes here passed on while
                  // `resolveRewriteRange` still read `main.empty`.
                  "if (!el || !el.closest('.cm-content')) return false;" +
                  "return !!document.querySelector('.cm-editor.cm-focused');",
              ))
                ? true
                : null,
            { label: "a non-empty selection inside a FOCUSED editor", timeoutMs: 5_000 },
          );
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
