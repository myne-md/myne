// On-demand AI model download over a local fixture origin (myne-md/myne#805
// task 8). Drives the real download command on the `local-inference-stub` build
// against `support/model-fixture-origin.ts`: no live network.
//
// The scenario covers:
//   mdo1: the first-run AI onboarding surface appears once after unlock and is
//          skippable;
//   mdo2: a successful verified download (fixture bytes matching the compiled-in
//          digest) lands;
//   mdo3: **the mismatch branch**: the origin serves corrupted bytes, the host
//          names the failure (a `store` error whose `detail` is
//          `DigestMismatch`) and registers nothing, and the artefact can be
//          retried.
//
// mdo3 is the one that matters. A green happy path proves the plumbing; the
// refusal proves the trust anchor, which is the whole reason the digest is
// compiled into the binary instead of read from `SHA256SUMS`.
//
// The origin env var is read ONLY by the stub build (`download.rs::download_origin`),
// so this redirection is impossible on a shipped binary: the same discipline
// `fake-ollama` relies on for the loopback runtime.
//
// Gated on `MYNE_E2E_AI=1` AND the stub build, paired by `scripts/e2e-ai-buildrun.sh`.

import { describe, expect, it } from "vitest";
import { describeE2E, scenario } from "./support/scenario";
import { seedVault } from "./support/fixtures";
import {
  dismissImporterOffer,
  ipcOk,
  pageSeatInvoke,
  unlockToEditor,
} from "./support/flows";
import {
  FIXTURE_EMBEDDING_BYTES,
  startFakeModelOrigin,
} from "./support/model-fixture-origin";
import type { Session } from "./support/webdriver";

const aiDescribe = process.env.MYNE_E2E_AI === "1" ? describeE2E : describe.skip;

/** Download the fixture artefact via the real IPC command, returning the
 *  installed path. Use {@link pageSeatInvoke} directly for the arm that expects
 *  a rejection. */
async function downloadFixture(session: Session, id: string): Promise<string> {
  const out = await ipcOk(
    session,
    "plugin:local-inference|download_model",
    { artifact: "fixture-embedding", downloadId: id },
    60_000,
  );
  return out as string;
}

/** The stored embedding model path, or `null` when none is registered. */
async function embeddingPath(session: Session): Promise<string | null> {
  const out = await ipcOk(session, "plugin:local-inference|get_model_path", {
    role: "embedding",
  });
  return out as string | null;
}

aiDescribe("mdo AI model download (on-demand, fixture origin)", () => {
  it("mdo1 the onboarding surface appears once and is skippable", async () => {
    const origin = await startFakeModelOrigin();
    try {
      let password = "";
      await scenario(
        "mdo1-onboarding-once",
        {
          seed: (dir) => void (password = seedVault(dir).password),
          env: { MYNE_E2E_MODEL_ORIGIN: origin.origin },
          // **The onboarding IS this suite's subject**, so the harness must not
          // have marked it seen before the app mounts (`session.ts` seeds
          // `myne.aiOnboardingSeen` for every other scenario, because the
          // surface's backdrop swallows every click and nothing dismisses it).
          firstRunSurfaces: true,
        },
        async (app) => {
          await unlockToEditor(app.session, password);
          // The surface renders once after unlock.
          await app.session.byTestId("aiOnboarding.screen");
          // The trust invariant is rendered verbatim (load-bearing copy).
          await app.session.byTestId("aiOnboarding.trust-invariant");
          // **Dismiss the importer offer FIRST, and the order is not cosmetic.**
          // Both first-run surfaces are open at once, and each is a `ModalShell`
          // whose backdrop is `useOverlayInert`'s target: the LATER one in the
          // DOM is the top layer and marks everything under it inert, so the
          // onboarding's own buttons stop being clickable while the offer's
          // backdrop covers them. Measured: the Skip click timed out with
          // "element interactable + clicked" while the Skip button sat in the
          // page source, enabled, under the offer's backdrop.
          await dismissImporterOffer(app.session);
          // Skip writes the device-local seen flag and closes it.
          await (await app.session.byTestId("aiOnboarding.skip")).click();
          // Nothing was fetched by merely showing the surface.
          expect(origin.requests()).toBe(0);
        },
      );
    } finally {
      await origin.close();
    }
  });

  it("mdo2 a verified download lands", async () => {
    const origin = await startFakeModelOrigin();
    try {
      let password = "";
      await scenario(
        "mdo2-verified-download",
        {
          seed: (dir) => void (password = seedVault(dir).password),
          env: { MYNE_E2E_MODEL_ORIGIN: origin.origin },
          // **The onboarding IS this suite's subject**, so the harness must not
          // have marked it seen before the app mounts (`session.ts` seeds
          // `myne.aiOnboardingSeen` for every other scenario, because the
          // surface's backdrop swallows every click and nothing dismisses it).
          firstRunSurfaces: true,
        },
        async (app) => {
          await unlockToEditor(app.session, password);
          // Offer first, then the onboarding: both are `ModalShell`s and the
          // top one marks the other inert (see mdo1).
          await dismissImporterOffer(app.session);
          await (await app.session.byTestId("aiOnboarding.skip")).click();

          const installed = await downloadFixture(app.session, "mdo2-a");
          expect(installed.endsWith("model.safetensors")).toBe(true);
          expect(origin.requests()).toBeGreaterThan(0);

          // The role now resolves to the installed file.
          const stored = await embeddingPath(app.session);
          expect(stored).not.toBeNull();
          expect(stored?.endsWith("model.safetensors") ?? false).toBe(true);
          void FIXTURE_EMBEDDING_BYTES;
        },
      );
    } finally {
      await origin.close();
    }
  });

  it("mdo3 corrupted bytes are refused, named, and register nothing", async () => {
    const origin = await startFakeModelOrigin();
    try {
      let password = "";
      await scenario(
        "mdo3-checksum-refused",
        {
          seed: (dir) => void (password = seedVault(dir).password),
          env: { MYNE_E2E_MODEL_ORIGIN: origin.origin },
          // **The onboarding IS this suite's subject**, so the harness must not
          // have marked it seen before the app mounts (`session.ts` seeds
          // `myne.aiOnboardingSeen` for every other scenario, because the
          // surface's backdrop swallows every click and nothing dismisses it).
          firstRunSurfaces: true,
        },
        async (app) => {
          await unlockToEditor(app.session, password);
          // Offer first, then the onboarding: both are `ModalShell`s and the
          // top one marks the other inert (see mdo1).
          await dismissImporterOffer(app.session);
          await (await app.session.byTestId("aiOnboarding.skip")).click();

          // The origin now serves bytes that do NOT match the compiled-in digest.
          origin.serveCorrupt("tampered bytes served by a hostile origin");

          // Expect a rejection; `pageSeatInvoke` surfaces `err` rather than
          // throwing, so read the payload directly.
          const rejected = await pageSeatInvoke(
            app.session,
            "plugin:local-inference|download_model",
            { artifact: "fixture-embedding", downloadId: "mdo3-a" },
            60_000,
          );
          expect(rejected.err).toBeDefined();
          // A digest mismatch travels as `ModelDownloadCommandError::Store`, so
          // the wire shape is `{ kind: "store", detail: "DigestMismatch" }`
          // (`ModelStoreError` unit variants serialize to their variant name).
          // Asserting the transport `kind` here would fail on every run and
          // leave the trust-anchor branch unverified.
          const err = rejected.err as { kind?: string; detail?: string };
          expect(err.kind).toBe("store");
          expect(err.detail).toBe("DigestMismatch");

          // Nothing was registered: no stored path for the role.
          expect(await embeddingPath(app.session)).toBeNull();

          // Retry: restore correct bytes and the same artefact downloads cleanly.
          origin.serveCorrupt(FIXTURE_EMBEDDING_BYTES);
          const installed = await downloadFixture(app.session, "mdo3-b");
          expect(installed.endsWith("model.safetensors")).toBe(true);
        },
      );
    } finally {
      await origin.close();
    }
  });
});
