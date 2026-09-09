import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { normalizeTagSuggestError } from "../../src/lib/ai-tags";
import { normalizeProviderError } from "../../src/lib/engine-error";
import { normalizeTranscribeError } from "../../src/lib/transcribe";

// Drift lock for the `EngineError` cause taxonomy (ai-provider-seam task 5,
// SYNC-5).
//
// The Rust half is compile-checked: `EngineError::kind`'s `match` fails to
// build on a forgotten variant. The TypeScript half had NOTHING. `CAUSE_BY_TAG`
// in `src/lib/transcribe.ts` and `normalizeTagSuggestError` in
// `src/lib/ai-tags.ts` are hand-written tables, and a Rust variant they have
// never heard of falls silently into their catch-all `"failed"` — the user is
// told "it failed" for a cause the backend named precisely. Nothing in the tree
// noticed, which is why #189 filed the vocabulary into #188: adding a backend
// and its causes in one change is how a table gets missed.
//
// The roster below is PARSED FROM THE RUST SOURCE rather than copied. A copy is
// a third place to forget.

// `myne-core`, not `src-tauri`, since myne-md/myne#456 moved the inference seam
// there. The move made this test fail by NAME, `ENOENT` on a path that no
// longer exists: which is the right failure and is why the path is a constant
// rather than a glob: a glob would have found some other `error.rs` and compared
// the TS taxonomy against the wrong Rust enum, silently.
const ERROR_RS = fileURLToPath(
  new URL("../../core/src/inference/error.rs", import.meta.url),
);

/** Every `EngineError::Variant => "tag"` arm of `kind()`, read from the source. */
function rustTaxonomy(): { variant: string; tag: string }[] {
  const src = readFileSync(ERROR_RS, "utf8");
  const body = src.slice(src.indexOf("pub fn kind("));
  const arms = [...body.matchAll(/EngineError::(\w+)\s*=>\s*"([a-z_]+)"/g)];
  return arms.map((m) => ({ variant: m[1], tag: m[2] }));
}

/**
 * Causes a surface deliberately does not distinguish, each with the reason.
 *
 * An entry here is a claim: "this cause cannot reach this surface, or is
 * correctly collapsed into its catch-all". It is reviewed like any other claim
 * — the point of listing it is that the alternative (silence) is
 * indistinguishable from having forgotten.
 */
const NOT_APPLICABLE: Record<string, Record<string, string>> = {
  transcribe: {
    inference_failed: "generation-only; transcription reports its own failure",
    embedding_failed: "embedding-only; never reached from the transcribe path",
    deferred:
      "the compute-priority stand-down is an auto-tag concept; transcription is user-initiated and never yields",
    transcription_failed:
      "correctly collapsed: this IS the transcribe surface's own runtime failure, and TranscribeErrorKind has no more specific state than \"failed\" to render for it",
    timeout:
      "speech-to-text has no backend that can time out: no remote provider accepts audio and a local runtime does not serve it (decisions.md 2026-08-09)",
    unreachable: "same — transcription is in-process only",
    refused: "same — transcription is in-process only",
    remote_barred:
      "transcription is user-initiated and in-process only, so the SYNC-14 bar can never fire on this path",
    consent_missing:
      "the provider consent gate is only consulted when a request is about to go to a provider, and transcription never sends one (myne-md/myne#456)",
    no_credential:
      "transcription never reaches a provider, so there is no credential for it to be missing (myne#415)",
    unauthorized: "same — no provider, no credential to be rejected",
    quota_exhausted: "same — no provider, no quota to exhaust",
    policy_refused:
      "same — a policy refusal is a provider's decision inside a 200 reply, and transcription never sends one (myne#466)",
    empty_completion:
      "a completion is generation's output; transcription produces a transcript, and an empty one is TranscriptionFailed's business",
    local_model_missing:
      "generation-only: the stale marker this names is generation.path, and transcription resolves through effective_transcription_model, which falls back to the bundled default rather than reporting a gone override (myne#466)",
    request_rejected:
      "transcription is in-process only, so no request is ever built for a provider to reject (myne#547)",
  },
  provider: {
    // `feature_off` USED to be here, claiming "the AI beta gate is checked
    // host-side before a provider is selected, so this never arrives from a
    // provider call". myne-md/myne#456 made that false: the agent's remote arm
    // runs `authorize_remote`, which checks `ai_enabled` FIRST and returns
    // `FeatureOff`, and on a phone the AI tab can be open when the pref flips.
    // It is a handled cause now, with its own sentence, so the entry is gone
    // rather than reworded.
    vault_locked:
      "a provider request only runs from an unlocked vault; the lock tears the transcript down instead",
    no_model:
      "this arm has no local model — the model is named by the user and its absence is a NoCredential-shaped setup problem, not a missing file",
    model_load_failed: "same — nothing is loaded on this side",
    inference_failed:
      "a provider failure arrives as a status, which maps to unauthorized / quota_exhausted / the catch-all; this variant is the in-process runtime's",
    embedding_failed:
      "embedding is barred from a remote backend unconditionally (SYNC-16), so it never fails this way",
    transcription_failed: "no provider accepts audio (decisions.md 2026-08-09)",
    deferred:
      "only a backend that serializes compute can defer, and this one runs out of process — Backend::serializes_compute is false for it",
    audio_too_long:
      "no provider accepts audio (decisions.md 2026-08-09), so this refusal is raised only by the in-process WAV decoder and never arrives from a provider call (myne#510)",
  },
  tagSuggest: {
    feature_off:
      "auto-tag has its own pref gate, checked host-side before the engine is touched",
    vault_locked: "the tag pass only runs while unlocked",
    no_model:
      "collapses into not_ready for this surface — the band simply does not appear",
    model_load_failed: "same collapse; the band does not appear",
    inference_failed: "collapses into the catch-all; there is no distinct UI",
    embedding_failed: "embedding-only; never reached from the tag path",
    transcription_failed: "transcription-only",
    timeout:
      "auto-tag runs on the bundled task-model with no override picker, so it has no provider to time out against (threat-model.md, decisions.md 2026-08-09)",
    unreachable: "same — bundled model only",
    refused: "same — bundled model only",
    no_credential:
      "auto-tag is barred from a remote backend unconditionally (SYNC-14), so it can never need a credential",
    unauthorized: "same — the bar fires before any credential is consulted",
    quota_exhausted: "same — nothing is ever billed on this path",
    policy_refused:
      "same — the SYNC-14 bar means no provider is ever asked, so none can refuse under its own policy (myne#466)",
    consent_missing:
      "same again: the SYNC-14 bar fires before the consent gate is reached, so auto-tag can never be refused for a consent nobody was asked for (myne-md/myne#456)",
    empty_completion:
      "collapses into not_ready for this surface: a tag pass that produced nothing shows no band, and there is nothing for the user to rephrase — the pass has no prompt they wrote",
    local_model_missing:
      "auto-tag runs on the BUNDLED task-model, which has no marker file and no picker at all (ModelRole::TagSuggestion), so there is no recorded path that could go stale",
    request_rejected:
      "the SYNC-14 bar means auto-tag never reaches a provider, so none can reject its request (myne#547)",
    audio_too_long:
      "transcription-only (myne#510): the tag pass is handed note TEXT and never opens an audio attachment, so the WAV decoder's ceiling is not on its path",
  },
};

/**
 * Ask a normalizer what it makes of a tag. A cause is "handled" when the
 * normalizer distinguishes it — i.e. answers something other than its
 * catch-all.
 */
function handles(
  surface: "transcribe" | "tagSuggest" | "provider",
  tag: string,
  variant: string,
): boolean {
  if (surface === "provider") {
    return (
      normalizeProviderError(tag) !== "failed" ||
      normalizeProviderError(variant) !== "failed"
    );
  }
  if (surface === "transcribe") {
    const byTag = normalizeTranscribeError(tag).kind;
    const byVariant = normalizeTranscribeError(variant).kind;
    return byTag !== "failed" || byVariant !== "failed";
  }
  const byTag = normalizeTagSuggestError(tag).kind;
  const byVariant = normalizeTagSuggestError(variant).kind;
  return byTag !== "failed" || byVariant !== "failed";
}

describe("EngineError cause taxonomy", () => {
  const taxonomy = rustTaxonomy();

  it("parses a non-trivial roster out of the Rust source", () => {
    // Guards the guard: a regex that silently matched nothing would make every
    // assertion below vacuously true — the exact shape this file exists to stop.
    expect(taxonomy.length).toBeGreaterThanOrEqual(9);
    expect(taxonomy.map((t) => t.tag)).toContain("not_ready");
  });

  it("emits each tag exactly once", () => {
    const tags = taxonomy.map((t) => t.tag);
    expect(new Set(tags).size).toBe(tags.length);
  });

  for (const surface of ["transcribe", "tagSuggest", "provider"] as const) {
    it(`${surface}: every Rust cause is either handled or declared not-applicable`, () => {
      const unaccounted = taxonomy
        .filter(
          ({ tag, variant }) =>
            !handles(surface, tag, variant) && !NOT_APPLICABLE[surface][tag],
        )
        .map(({ variant, tag }) => `${variant} ("${tag}")`);

      expect(
        unaccounted,
        `${surface} silently collapses these EngineError causes into its catch-all. ` +
          `Either map them in the normalizer, or add each to NOT_APPLICABLE.${surface} with the reason it cannot reach this surface.`,
      ).toEqual([]);
    });

    // **An exemption becomes stale in TWO ways, and this file only checked
    // one.** The obvious one is the Rust variant going away. The other is the
    // surface starting to HANDLE the cause, which leaves a reasoned claim that
    // "this cannot reach here" sitting beside a normalizer that distinguishes
    // it: the record then argues against the code, and a later reader deciding
    // whether a fifth surface needs the cause reads the wrong answer. Found by
    // myne-md/myne#456, which handled `feature_off` on the provider surface
    // while its exemption stayed green saying the cause never arrives.
    it(`${surface}: no not-applicable entry for a cause it actually handles`, () => {
      const byTag = new Map(taxonomy.map((t) => [t.tag, t.variant]));
      const contradicted = Object.keys(NOT_APPLICABLE[surface]).filter((tag) => {
        const variant = byTag.get(tag);
        return variant !== undefined && handles(surface, tag, variant);
      });
      expect(
        contradicted,
        `${surface} distinguishes these causes AND declares them not-applicable. ` +
          `Remove the NOT_APPLICABLE entry: it is a claim the normalizer contradicts.`,
      ).toEqual([]);
    });

    it(`${surface}: no stale not-applicable entry`, () => {
      const known = new Set(taxonomy.map((t) => t.tag));
      const stale = Object.keys(NOT_APPLICABLE[surface]).filter(
        (tag) => !known.has(tag),
      );
      expect(
        stale,
        `these tags are declared not-applicable but no longer exist in the Rust enum — a stale exemption is how the next one gets waved through`,
      ).toEqual([]);
    });
  }
});
