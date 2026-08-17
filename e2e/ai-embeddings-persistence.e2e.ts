// AI embedding-index persistence flow suite (ai-embeddings-persistence
// MYND-453 task 8). Drives the `vault.embeddings` (`MYR1`) persistence lifecycle
// end to end on the real tauri-driver harness, against the
// **`local-inference-stub` build variant** (the deterministic `StubEngine` — no
// model file in the repo; SYNC-5). The audited production bundle never enables
// that feature, so this suite runs ONLY when the AI-feature binary is under test
// — gated on `MYNE_E2E_AI=1`, which the feature-flagged build sets (see
// `docs/dev/e2e.md`).
//
//   aep1 — enable AI → select an embedding model → create a note → then walk the
//          persistence lifecycle across in-session lock/re-unlock cycles and
//          assert the OBSERVABLE outcome of each hydrate via the
//          `ai.hydration-probe` testid:
//            (a) COLD BUILD    — first hydrate with a model + notes but no blob
//                                on disk  → loaded-from-blob=false, reembedded>0
//                                (it also WRITES vault.embeddings).
//            (b) PERSISTENCE HIT — re-unlock with the blob present, identity
//                                matching, note nonces unchanged → NO re-embed:
//                                loaded-from-blob=true, reembedded=0.
//            (c) MODEL-SWAP REBUILD — swap the selected embedding model (a
//                                different file → a different model_hash → the
//                                §9.17.4 model-identity mismatch) → the persisted
//                                blob is discarded, full rebuild:
//                                loaded-from-blob=false, reembedded>0.
//
// Legs (b) and (c) are the two acceptance criteria of task 8 (persistence hit +
// model-swap rebuild); leg (a) is the necessary precondition that first writes
// the blob. They share the (heavy: four unlocks) setup, so they live in one
// story rather than re-rolling the vault per leg.
//
// == Why this works on the STUB build ==
// `hydrate_ai_vectors` only loads/writes `vault.embeddings` when it can build a
// stable `EmbeddingsIdentity`, whose `model_hash` is the SHA-256 of the SELECTED
// embedding model file (`model_store`). That hashing is build-agnostic — it
// hashes whatever bytes the file holds — so selecting a small FAKE embedding
// file via the real `set_model_path` IPC makes persistence engage on the stub
// build too (the stub `embed()` supplies the vectors; the model file supplies
// the identity). Swapping to a second fake file with different bytes changes the
// hash and drives the identity-mismatch rebuild — no real MiniLM needed.
//
// == Observable signal (SYNC-8 data-testid) ==
// The detached embed-on-unlock walk emits `ai://vectors-hydrated` with bounded,
// id-free counters; `src/notes/components/AiHydrationProbe.tsx` reflects the last
// event onto `data-loaded-from-blob` / `data-reembedded` / `data-embedded` /
// `data-seq` on the hidden `ai.hydration-probe` element. The counters carry no
// note_id / vector / nonce (DENY-list clean). `data-seq` increments per event so
// the harness can wait for the NEXT hydrate after each re-unlock even when the
// payload repeats.
//
// The hard no-egress guarantee is the Rust gate (`ai-no-network-check.sh` +
// `no_egress.rs`); this behavioral suite asserts the persistence flow completes
// locally, never re-embedding on a clean hit and always rebuilding on a swap.
//
// KDF: weak generator fixture (SYNC-9 — params are vault.meta-resident).

import { describe, expect, it } from "vitest";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describeE2E, scenario } from "./support/scenario";
import { seedVault } from "./support/fixtures";
import {
  createNote,
  dismissImporterOffer,
  enableAi,
  lockAndReunlock,
  pageSeatInvoke,
  typeIntoEditor,
  unlockToEditor,
  waitForSaved,
} from "./support/flows";
import { type Session } from "./support/webdriver";

/** Only run when the binary under test is the AI-feature (`local-inference-stub`)
 *  build — the default production bundle has no AI commands, so these testids
 *  never appear there. The feature-flagged build sets `MYNE_E2E_AI=1`. */
const aiDescribe = process.env.MYNE_E2E_AI === "1" ? describeE2E : describe.skip;

/** Two FAKE embedding model files, laid down OUTSIDE the vault tree so
 *  `set_selected_model` accepts them (it rejects `<app_data_dir>/vaults/…`). The
 *  bytes differ so the two files hash to different `model_hash`es — that is what
 *  drives the model-swap identity mismatch. `.safetensors` matches the embedding
 *  role's picker filter, though the stub never opens the file. */
const FAKE_MODEL_DIR = "fake-models";
const FAKE_EMBED_A = "embed-a.safetensors";
const FAKE_EMBED_B = "embed-b.safetensors";

/** Lay down the two fake embedding files under `<appDataDir>/fake-models/`. */
function seedFakeModels(appDataDir: string): void {
  const dir = join(appDataDir, FAKE_MODEL_DIR);
  mkdirSync(dir, { recursive: true });
  // Distinct byte contents → distinct SHA-256 → distinct model identity.
  writeFileSync(join(dir, FAKE_EMBED_A), "fake-embedding-model-A-bytes-v1");
  writeFileSync(join(dir, FAKE_EMBED_B), "fake-embedding-model-B-different-bytes-v1");
}

/** Absolute path of a fake model, as `set_model_path` will see it. The E2E and
 *  the app share the isolated `<XDG_DATA_HOME>/md.myne.desktop` = `appDataDir`,
 *  which the Rust `app_data_dir` resolves to identically. */
function fakeModelPath(appDataDir: string, file: string): string {
  return join(appDataDir, FAKE_MODEL_DIR, file);
}

/** Select `file` as the EMBEDDING model via the real `set_model_path` IPC from
 *  the page seat (no OS file dialog to drive; the picker is the ONLY other entry
 *  and it's a native dialog WebDriver can't reach — the sanctioned `pageSeatInvoke`
 *  path for a backend command, `e2e/CLAUDE.md`). This is what gives
 *  `hydrate_ai_vectors` a stable model identity so persistence engages, and — on
 *  the swap — changes that identity. Asserts the command resolved (no `err`). */
async function selectEmbeddingModel(
  s: Session,
  appDataDir: string,
  file: string,
): Promise<void> {
  const res = await pageSeatInvoke(
    s,
    "plugin:local-inference|set_model_path",
    { role: "embedding", path: fakeModelPath(appDataDir, file) },
    15_000,
  );
  // The accepted (normalized) path comes back as `ok`; a reject would carry
  // `err` (e.g. InsideVaultTree). Boolean-shape assert only — the path is the
  // test's own fixture value, but keep the failure output path-free.
  expect(res.err).toBeUndefined();
  expect(res.ok).toBeDefined();
}

/** The current `ai.hydration-probe` `data-seq`, or -1 when the probe has not yet
 *  fired (no hydrate event this session). The probe is absent until the first
 *  event, so a missing element reads as -1. */
async function currentHydrationSeq(s: Session): Promise<number> {
  const found = await s.byTestIdAll("ai.hydration-probe");
  if (found.length === 0) return -1;
  const seq = await found[0].attribute("data-seq");
  return seq === null ? -1 : Number(seq);
}


/** Wait for the NEXT hydrate event (a `data-seq` strictly greater than
 *  `afterSeq`) and return the probe's asserted counters. A generous budget: the
 *  walk is detached + model-bound (even the stub runs under `spawn_blocking`),
 *  and the full-suite host is under cumulative load. */
async function waitForHydrationAfter(
  s: Session,
  afterSeq: number,
): Promise<{ loadedFromBlob: boolean; reembedded: number; embedded: number }> {
  const probe = await s.waitUntil(
    async () => {
      const found = await s.byTestIdAll("ai.hydration-probe");
      if (found.length === 0) return null;
      const seq = Number((await found[0].attribute("data-seq")) ?? "-1");
      return seq > afterSeq ? found[0] : null;
    },
    { label: "next ai://vectors-hydrated event", timeoutMs: 30_000 },
  );
  return {
    loadedFromBlob: (await probe.attribute("data-loaded-from-blob")) === "true",
    reembedded: Number((await probe.attribute("data-reembedded")) ?? "0"),
    embedded: Number((await probe.attribute("data-embedded")) ?? "0"),
  };
}

aiDescribe("aep1 AI embedding-index persistence (cold build → hit → model-swap rebuild)", () => {
  // Vault-count precondition: 1 (weak KDF). Requires the local-inference-stub build.
  it("re-unlock serves the persisted index (no re-embed); a model swap forces a full rebuild", async () => {
    let password = "";
    await scenario(
      "aep1-ai-embeddings-persistence",
      {
        seed: (dir) => {
          password = seedVault(dir).password;
          seedFakeModels(dir);
        },
      },
      async (app) => {
        const s = app.session;
        const { appDataDir } = app;

        // ── Session 1: enable AI, select a model, create a note ──
        // The first unlock runs BEFORE ai_enabled/model are set, so its hydrate
        // is a no-op (gated off). We arm persistence here, then let the
        // lock/re-unlock cycles below exercise it.
        await unlockToEditor(s, password);
        await dismissImporterOffer(s);
        await enableAi(s);
        // Pick model A → a stable embedding identity so hydrate persists the blob.
        await selectEmbeddingModel(s, appDataDir, FAKE_EMBED_A);

        // A note on disk is what there is to embed (a fresh vault has none). The
        // stub's fixed-vector embed still produces resident vectors + a nonce
        // manifest, which is all the persistence lifecycle needs.
        await createNote(s, "aep1notealfa7k2m9qx4w8e5rj0aa");
        await typeIntoEditor(s, "The mitochondria is the powerhouse of the cell.");
        await waitForSaved(s);

        // **Diagnostic gate, and it earns its place.** The hydrate walk has SIX
        // silent early returns before it can emit (`hydrate.rs`
        // `hydrate_ai_vectors`: no active vault, prefs read failure,
        // `ai_enabled` off, no `LocalInferenceState`, a remote-refused
        // `embedding_engine`, `notes_dir_for`). When the event does not arrive,
        // the scenario's only report is a 30 s timeout, which names none of
        // them and reads as a hung backend. Asserting the two preconditions the
        // scenario itself SET means a broken setup fails here, by name, instead
        // of as an unexplained wait later.
        const prefsNow = await pageSeatInvoke(s, "plugin:prefs|prefs_read", {}, 10_000);
        expect(
          (prefsNow.ok as { ai_enabled?: boolean } | undefined)?.ai_enabled,
          "ai_enabled must be on before the walk can run at all",
        ).toBe(true);
        const capability = await pageSeatInvoke(
          s,
          "plugin:local-inference|ai_capability_report",
          {},
          10_000,
        );
        expect(
          (capability.ok as { backend_class?: string } | undefined)?.backend_class,
          "the walk refuses a remote backend outright, so a remote class here " +
            "would explain the missing event",
        ).not.toBe("remote");

        // ── (a) COLD BUILD: lock → re-unlock #1 ──
        // With ai_enabled + model set + one note on disk but NO blob yet, this
        // hydrate does a cold build and WRITES vault.embeddings.
        let seq = await currentHydrationSeq(s);
        await lockAndReunlock(s, password);
        const cold = await waitForHydrationAfter(s, seq);
        expect(cold.loadedFromBlob).toBe(false); // nothing to load — cold start
        expect(cold.reembedded).toBeGreaterThan(0); // the note was embedded fresh
        expect(cold.embedded).toBeGreaterThan(0);

        // ── (b) PERSISTENCE HIT: lock → re-unlock #2 ──
        // The blob now exists, the identity matches (same model A), and the note
        // nonce is unchanged → the index is served from disk, ZERO re-embeds.
        seq = await currentHydrationSeq(s);
        await lockAndReunlock(s, password);
        const hit = await waitForHydrationAfter(s, seq);
        expect(hit.loadedFromBlob).toBe(true); // served from vault.embeddings
        expect(hit.reembedded).toBe(0); // NO full re-walk — the whole point
        expect(hit.embedded).toBeGreaterThan(0); // still populated (from the blob)

        // ── (c) MODEL-SWAP REBUILD: swap model → lock → re-unlock #3 ──
        // Selecting model B (different bytes → different model_hash) invalidates
        // the persisted identity (§9.17.4). The next hydrate finds the blob but
        // rejects it on the identity mismatch → full rebuild.
        await selectEmbeddingModel(s, appDataDir, FAKE_EMBED_B);
        seq = await currentHydrationSeq(s);
        await lockAndReunlock(s, password);
        const rebuilt = await waitForHydrationAfter(s, seq);
        expect(rebuilt.loadedFromBlob).toBe(false); // identity mismatch → discarded
        expect(rebuilt.reembedded).toBeGreaterThan(0); // full re-embed under model B
        expect(rebuilt.embedded).toBeGreaterThan(0);
      },
    );
  });
});
