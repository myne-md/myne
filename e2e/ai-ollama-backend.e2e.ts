// The user-named local model runtime, end to end on the real tauri-driver
// harness (ai-ollama-local task 9).
//
// == WHAT THIS PROVES, AND WHAT IT DOES NOT ==
// **The fixture proves the plumbing, not the network.** A canned loopback
// responder shows that Myne builds the request, sends it to the address the
// user named, and surfaces what comes back. It says nothing about a real
// Ollama, and a green run here is not evidence that a real round trip works —
// that one is owed by hand, per task 5's progress note.
//
// == THE TWO ARMS, AND WHY BOTH ARE NEEDED ==
//   aob1 — NO endpoint configured → an AI call produces **zero accepts** on the
//          fixture. This is the default-state half of the invariant in
//          `decisions.md` 2026-08-09 ("no byte leaves the device unless the
//          user has named a provider"), demonstrated rather than asserted:
//          `resolve_backends` does not even register the runtime arm, so there
//          is nothing to select.
//   aob2 — endpoint configured → the same call **connects**, hits
//          `/api/generate`, and the fixture's text comes back through the IPC.
//
// aob2 is the control arm, in the sense
// `rustls_transport.rs::proxy_down_fails_closed_with_no_direct_connection_attempt`
// means it: *"the control arm at the end is what makes the zero meaningful."*
// A probe that can never see a connection is not a probe, and aob1 alone would
// pass against a fixture on the wrong port, a fixture that never started, or a
// counter that is wired to nothing.
//
// == GATING: NONE, DELIBERATELY ==
// Nine of the ten existing AI scenarios are gated on `MYNE_E2E_AI=1` because
// they need the `local-inference-stub` build variant's deterministic engine.
// This one needs **no model and no stub**: the fixture supplies the answers,
// and `local-inference` is in `default`, so any ordinary build carries the
// commands. Gating it would have added a tenth permanently-skipped scenario
// that looks like coverage. Recorded in `myne-agents/docs/dev/e2e.md`'s env-knob table.
//
// One interaction was checked before deciding: under `local-inference-stub`,
// `resolve_backend` returns `StubEngine` unconditionally — but the runtime arm
// is registered by `resolve_backends`, which is NOT feature-gated, so the
// scenario is correct on both builds. On the stub build the in-process arm the
// zero-arm falls back to is the stub; on the default build it is Candle with no
// model. Neither opens a socket, which is the only property aob1 asserts.
//
// == NO VAULT, NO UNLOCK ==
// `plugin:local-inference|infer` takes no vault state and no `ai_enabled`
// gate — it is engine-only. So both arms run against a fresh boot with no
// vault, which keeps the scenario about the backend rather than about a login.
//
// KDF: not applicable — no vault is created.

import { expect, it } from "vitest";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { describeE2E, scenario } from "./support/scenario";
import { dismissImporterOffer, pageSeatInvoke, unlockToEditor } from "./support/flows";
import { seedVault } from "./support/fixtures";
import {
  endpointConfigJson,
  FAKE_COMPLETION,
  startFakeOllama,
  type FakeOllama,
} from "./support/fake-ollama";

/** Ask the host for a completion through the real IPC surface. Generous
 *  budget: the default build may construct a Candle engine on the way. */
async function askForCompletion(
  s: Parameters<typeof pageSeatInvoke>[0],
): Promise<{ ok?: unknown; err?: unknown }> {
  return pageSeatInvoke(
    s,
    "plugin:local-inference|infer",
    { prompt: "say something" },
    30_000,
  );
}

describeE2E("aob AI local model runtime (fake Ollama over loopback)", () => {
  it("connects only once an endpoint is named, and never before", async () => {
    // ONE fixture across both arms, so the zero-arm's counter is the same
    // object the connecting arm later increments. Two fixtures would let a
    // silently-dead counter read as a passing zero.
    const fake: FakeOllama = await startFakeOllama();
    try {
      // ── aob1: nothing configured → nothing connects ──
      await scenario("aob1-no-endpoint-no-connection", {}, async (app) => {
        const res = await askForCompletion(app.session);
        // The call resolves one way or the other — a stub answers, a
        // model-less Candle refuses with NotReady. Both are fine; what must
        // NOT have happened is a socket.
        expect(res).toBeDefined();
        expect(fake.accepts()).toBe(0);
        expect(fake.paths()).toEqual([]);
      });

      // ── aob2: endpoint named → it connects, and the answer comes back ──
      let password = "";
      await scenario(
        "aob2-configured-endpoint-connects",
        {
          // The device-local file is the real SYNC-14 surface, so no UI
          // driving is needed to point the app at the fixture — which keeps
          // this scenario about the backend rather than about typing.
          seedConfig: (configDir) => {
            writeFileSync(
              join(configDir, "ai-endpoint.json"),
              endpointConfigJson(fake),
            );
          },
          // A vault, UNLOCKED below. Inference refuses against a locked vault
          // (`VaultLocked`) — correctly: prompts are built from note content,
          // so there is nothing to infer over and nothing that should leave.
          // This arm had no vault at all, so it answered `VaultLocked` before
          // opening a socket, and `fake.accepts()` stayed at zero. Which means
          // the scenario that exists to prove the endpoint CONNECTS had never
          // once proved it: aob1's zero and aob2's zero were the same zero.
          seed: (dir) => void (password = seedVault(dir).password),
        },
        async (app) => {
          await unlockToEditor(app.session, password);
          await dismissImporterOffer(app.session);
          const res = await askForCompletion(app.session);
          expect(res.err, "inference must reach the endpoint once a vault is open").toBeUndefined();
          expect(res.ok).toBe(FAKE_COMPLETION);
          expect(fake.accepts()).toBeGreaterThan(0);
          expect(fake.paths().some((p) => p.startsWith("/api/generate"))).toBe(true);
        },
      );
    } finally {
      await fake.close();
    }
  });
});
