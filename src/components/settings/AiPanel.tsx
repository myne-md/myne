// Settings → AI panel (local-ai epic, ai-ux-surface MYND-408, task 4).
//
// The opt-in surface for the experimental, LOCAL-ONLY AI features: an
// `ai_enabled` toggle (SYNC-12), the threat-model-bounded trust affordance
// (SYNC-16 — the load-bearing headline + a "How does this work?" disclosure), a
// per-role side-load model picker (SYNC-1 — the user brings their own files;
// Myne NEVER downloads them), and an `ai_excluded_folders` editor (SYNC-14, same
// set encoding as deliberate_folders).
//
// Model acquisition (SYNC-1/2, no-egress): Myne has no network egress path by
// construction, so it cannot and will not fetch a model. The "Recommended
// models" links open in the user's OWN browser via the opener plugin (an OS
// handoff, not a Myne fetch — the same affordance the About panel uses for the
// threat-model doc); the user downloads there and side-loads the files with the
// pickers. Three roles: a Qwen2-family GGUF for generation (summaries / chat /
// writing), an all-MiniLM-L6-v2 embedding model for semantic search / Q&A, and
// a Whisper GGUF for speech-to-text transcription (MYND-270).
//
// Honesty discipline: the trust copy renders the `load-bearing-copy.ts`
// constants VERBATIM (never i18n'd, E2E-pinned by literal equality); it makes
// no absolute-privacy claim past the threat model (A7/A13 acknowledged).

import { useEffect, useState, type CSSProperties } from "react";
import { useTranslation } from "react-i18next";
import { open as openFileDialog } from "@tauri-apps/plugin-dialog";
import { openUrl } from "@tauri-apps/plugin-opener";

import type { ModelRole } from "../../lib/ai-model-store";
import { usePrefs } from "../../hooks/usePrefs";
import { loadModelPath, saveModelPath } from "../../lib/ai-model-store";
import {
  AI_TRUST_DISCLOSURE,
  AI_TRUST_HEADLINE,
} from "../../lib/load-bearing-copy";
import { Switch } from "../primitives/Switch";
import { BetaBadge } from "./BetaBadge";
import { BLOCK_STYLE, HELPER_STYLE, LABEL_STYLE, PANEL_ROOT_STYLE } from "./panel-styles";

// Panel header row — the panel title carries the "Beta" badge so the beta
// framing is visible inside the panel (not only on the Labs rail entry).
const HEADER_ROW_STYLE: CSSProperties = {
  display: "flex",
  alignItems: "center",
};

const TITLE_STYLE: CSSProperties = {
  margin: 0,
  fontSize: "var(--text-lg)",
  fontWeight: "var(--weight-semibold)" as CSSProperties["fontWeight"],
  color: "var(--fg-1)",
};

const TOGGLE_ROW_STYLE: CSSProperties = {
  display: "flex",
  alignItems: "center",
  justifyContent: "space-between",
  gap: "var(--space-3)",
};

const LINK_STYLE: CSSProperties = {
  fontSize: 13,
  color: "var(--accent)",
  textDecoration: "underline",
  background: "none",
  border: 0,
  padding: 0,
  marginTop: "var(--space-1)",
  cursor: "pointer",
  fontFamily: "inherit",
  display: "inline-flex",
  alignItems: "center",
  gap: 4,
  alignSelf: "flex-start",
};

/**
 * Recommended side-load models — STARTING POINTS, not guaranteed-compatible until
 * the Candle engine is smoke-tested against them (the `engine_candle.rs` model
 * tests are `#[ignore]`d pending a fixture model). The `url`s open in the user's
 * BROWSER (never fetched by Myne — SYNC-1/2 no-egress); the user downloads there
 * and picks the files with the per-role pickers. Names/URLs are proper nouns, so
 * they live here as constants, not i18n. Refine once the engine is smoke-tested.
 */
const RECOMMENDED_MODEL: Record<ModelRole, { name: string; url: string }> = {
  generation: {
    name: "Qwen2.5-1.5B-Instruct (GGUF)",
    url: "https://huggingface.co/Qwen/Qwen2.5-1.5B-Instruct-GGUF",
  },
  embedding: {
    name: "all-MiniLM-L6-v2",
    url: "https://huggingface.co/sentence-transformers/all-MiniLM-L6-v2",
  },
  transcription: {
    name: "whisper-base (multilingual)",
    url: "https://huggingface.co/openai/whisper-base",
  },
};

/** Per-role side-load file filter for the OS picker (SYNC-1). */
// File-picker filters. The `name` is user-visible in the OS dialog, so it is
// stored as an i18n KEY and resolved with `t()` at usage (never frozen at module
// scope — src/CLAUDE.md i18n discipline); the extensions are stable data.
const MODEL_FILTER: Record<ModelRole, { nameKey: string; extensions: string[] }> = {
  generation: { nameKey: "settings.ai.modelFilter.gguf", extensions: ["gguf"] },
  embedding: {
    nameKey: "settings.ai.modelFilter.safetensors",
    extensions: ["safetensors"],
  },
  transcription: {
    // The Whisper engine loads via `WhisperVarBuilder::from_gguf`
    // (`engine_candle.rs::load_transcription`), so the override picker must
    // offer `.gguf` — a `.safetensors` pick fails `from_gguf` at load time.
    nameKey: "settings.ai.modelFilter.gguf",
    extensions: ["gguf"],
  },
};

interface AiPanelProps {
  onShowToast?: (message: string) => void;
}

/** A single model role's block: heading → recommended-model browser link + the
 *  required-files hint → the side-load path + "Choose…" picker. */
function ModelRoleBlock(props: {
  roleLabel: string;
  filesText: string;
  recommendName: string;
  onOpenRecommend: () => void;
  path: string | null;
  noneLabel: string;
  chooseLabel: string;
  onChoose: () => void;
  disabled: boolean;
  testIdRecommend: string;
  testIdSelect: string;
  testIdChoose: string;
}) {
  return (
    <div style={{ marginTop: "var(--space-3)" }}>
      <label style={LABEL_STYLE}>{props.roleLabel}</label>
      <div>
        <button
          type="button"
          data-testid={props.testIdRecommend}
          onClick={props.onOpenRecommend}
          style={LINK_STYLE}
        >
          {props.recommendName}
          <span aria-hidden="true">↗</span>
        </button>
      </div>
      <p style={{ ...HELPER_STYLE, margin: "2px 0 0" }}>{props.filesText}</p>
      <div style={{ ...TOGGLE_ROW_STYLE, marginTop: "var(--space-1)" }}>
        <span
          data-testid={props.testIdSelect}
          style={{
            fontSize: 13,
            color: props.path === null ? "var(--fg-3)" : "var(--fg-1)",
            fontFamily: "var(--font-mono)",
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
          }}
          title={props.path ?? undefined}
        >
          {props.path ?? props.noneLabel}
        </span>
        <button
          type="button"
          data-testid={props.testIdChoose}
          disabled={props.disabled}
          onClick={props.onChoose}
          style={{
            font: "inherit",
            fontSize: 13,
            padding: "var(--space-1) var(--space-2)",
            borderRadius: "var(--radius-1)",
            border: "1px solid var(--line-1)",
            background: "var(--paper-2)",
            color: "var(--fg-1)",
            cursor: props.disabled ? "default" : "pointer",
            opacity: props.disabled ? 0.5 : 1,
            whiteSpace: "nowrap",
          }}
        >
          {props.chooseLabel}
        </button>
      </div>
    </div>
  );
}

export function AiPanel({ onShowToast }: AiPanelProps) {
  const { t } = useTranslation();
  const { prefs, setAiEnabled, setAiExcludedFolders } = usePrefs(onShowToast);

  const [disclosureOpen, setDisclosureOpen] = useState(false);
  const [modelPaths, setModelPaths] = useState<Record<ModelRole, string | null>>({
    generation: null,
    embedding: null,
    transcription: null,
  });
  // Local edit buffer for the excluded-folders textarea (one folder/line); the
  // backend NFC-sorts + dedups the set on encode, so the raw lines are fine.
  const [excludedDraft, setExcludedDraft] = useState<string>(
    prefs.ai_excluded_folders.join("\n"),
  );

  const aiEnabled = prefs.ai_enabled;

  // Load the persisted device-local model paths on open (both roles). A missing
  // command (the `local-inference` feature is off) degrades silently to no
  // persisted path — the panel stays usable.
  useEffect(() => {
    let alive = true;
    (["generation", "embedding", "transcription"] as const).forEach((role) => {
      loadModelPath(role)
        .then((p) => {
          if (alive) setModelPaths((prev) => ({ ...prev, [role]: p }));
        })
        .catch(() => {
          /* feature off / not set — keep local state */
        });
    });
    return () => {
      alive = false;
    };
  }, []);

  const chooseModel = async (role: ModelRole) => {
    const picked = await openFileDialog({
      multiple: false,
      directory: false,
      filters: [
        { name: t(MODEL_FILTER[role].nameKey), extensions: MODEL_FILTER[role].extensions },
      ],
    });
    if (typeof picked !== "string") return;
    // Persist device-locally; the accepted (normalized) path is what we show. A
    // failure (e.g. path inside the vault tree, or the feature is off) falls back
    // to the picked path in local state + a toast.
    try {
      const accepted = await saveModelPath(role, picked);
      setModelPaths((prev) => ({ ...prev, [role]: accepted }));
    } catch {
      setModelPaths((prev) => ({ ...prev, [role]: picked }));
      onShowToast?.(t("settings.ai.modelSaveFailed"));
    }
  };

  const openRecommend = (role: ModelRole) => {
    // Opens in the user's OWN browser (OS handoff via the opener plugin) — Myne
    // never touches the network (SYNC-2 no-egress). A rejection is non-fatal.
    openUrl(RECOMMENDED_MODEL[role].url).catch((err) => {
      if (import.meta.env.DEV) {
        console.warn("AiPanel: openUrl(recommended model) rejected", err);
      }
    });
  };

  const commitExcluded = () => {
    const folders = excludedDraft
      .split("\n")
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
    void setAiExcludedFolders(folders);
  };

  return (
    <div data-testid="settings.ai-panel" style={PANEL_ROOT_STYLE}>
      {/* Panel header — title + Beta badge (local-ai epic MYND-408). */}
      <div style={HEADER_ROW_STYLE}>
        <h3 style={TITLE_STYLE}>{t("settings.ai.title")}</h3>
        <BetaBadge testId="ai.beta-badge" />
      </div>

      {/* Opt-in toggle. */}
      <div style={BLOCK_STYLE}>
        <div style={TOGGLE_ROW_STYLE}>
          <label style={LABEL_STYLE} htmlFor="ai-enable-toggle">
            {t("settings.ai.enableLabel")}
          </label>
          <Switch
            checked={aiEnabled}
            onChange={(next) => void setAiEnabled(next)}
            ariaLabel={t("settings.ai.enableLabel")}
            testId="ai.enable-toggle"
          />
        </div>
        <p style={HELPER_STYLE}>{t("settings.ai.enableHelper")}</p>
      </div>

      {/* Trust affordance — load-bearing copy, rendered verbatim (SYNC-16). */}
      <div style={BLOCK_STYLE}>
        <p data-testid="ai.trust-headline" style={{ ...LABEL_STYLE, lineHeight: 1.5 }}>
          {AI_TRUST_HEADLINE}
        </p>
        <button
          type="button"
          data-testid="ai.trust-disclosure-toggle"
          aria-expanded={disclosureOpen}
          onClick={() => setDisclosureOpen((o) => !o)}
          style={{
            background: "none",
            border: "none",
            padding: 0,
            marginTop: "var(--space-1)",
            color: "var(--fg-2)",
            font: "inherit",
            fontSize: 13,
            textDecoration: "underline",
            cursor: "pointer",
          }}
        >
          {t("settings.ai.disclosureToggle")}
        </button>
        {disclosureOpen && (
          <p data-testid="ai.trust-disclosure" style={{ ...HELPER_STYLE, lineHeight: 1.5 }}>
            {AI_TRUST_DISCLOSURE}
          </p>
        )}
      </div>

      {/* Models — side-load only, no in-app download (SYNC-1/2). Recommended
          links open in the user's browser; the pickers take the downloaded
          files. Three roles: text (GGUF) + search/embedding (safetensors) +
          speech-to-text (Whisper GGUF). */}
      <div style={BLOCK_STYLE} data-testid="ai.models-section">
        <label style={LABEL_STYLE}>{t("settings.ai.modelsLabel")}</label>
        <p style={HELPER_STYLE}>{t("settings.ai.modelsHelper")}</p>

        <ModelRoleBlock
          roleLabel={t("settings.ai.modelGenerationLabel")}
          filesText={t("settings.ai.recommendedFilesGeneration")}
          recommendName={RECOMMENDED_MODEL.generation.name}
          onOpenRecommend={() => openRecommend("generation")}
          path={modelPaths.generation}
          noneLabel={t("settings.ai.modelNone")}
          chooseLabel={t("settings.ai.modelChoose")}
          onChoose={() => void chooseModel("generation")}
          disabled={!aiEnabled}
          testIdRecommend="ai.model-recommend-generation"
          testIdSelect="ai.model-select"
          testIdChoose="ai.model-choose"
        />

        <ModelRoleBlock
          roleLabel={t("settings.ai.modelEmbeddingLabel")}
          filesText={t("settings.ai.recommendedFilesEmbedding")}
          recommendName={RECOMMENDED_MODEL.embedding.name}
          onOpenRecommend={() => openRecommend("embedding")}
          path={modelPaths.embedding}
          noneLabel={t("settings.ai.modelNone")}
          chooseLabel={t("settings.ai.modelChoose")}
          onChoose={() => void chooseModel("embedding")}
          disabled={!aiEnabled}
          testIdRecommend="ai.model-recommend-embedding"
          testIdSelect="ai.model-select-embedding"
          testIdChoose="ai.model-choose-embedding"
        />

        {/* Speech-to-text (voice-to-text MYND-552, SYNC-V3): the ASR / Whisper
            role — side-load only, disabled when AI is off, distinct testids. */}
        <ModelRoleBlock
          roleLabel={t("settings.ai.modelTranscriptionLabel")}
          filesText={t("settings.ai.recommendedFilesTranscription")}
          recommendName={RECOMMENDED_MODEL.transcription.name}
          onOpenRecommend={() => openRecommend("transcription")}
          path={modelPaths.transcription}
          noneLabel={t("settings.ai.modelNone")}
          chooseLabel={t("settings.ai.modelChoose")}
          onChoose={() => void chooseModel("transcription")}
          disabled={!aiEnabled}
          testIdRecommend="ai.model-recommend-transcription"
          testIdSelect="ai.model-select-transcription"
          testIdChoose="ai.model-choose-transcription"
        />
      </div>

      {/* Excluded folders — same canonical set encoding as deliberate_folders. */}
      <div style={BLOCK_STYLE}>
        <label style={LABEL_STYLE} htmlFor="ai-excluded-folders">
          {t("settings.ai.excludedLabel")}
        </label>
        <textarea
          id="ai-excluded-folders"
          data-testid="ai.excluded-folders"
          value={excludedDraft}
          disabled={!aiEnabled}
          onChange={(e) => setExcludedDraft(e.target.value)}
          onBlur={commitExcluded}
          rows={3}
          spellCheck={false}
          placeholder={t("settings.ai.excludedPlaceholder")}
          style={{
            marginTop: "var(--space-1)",
            width: "100%",
            resize: "vertical",
            font: "inherit",
            fontSize: 13,
            fontFamily: "var(--font-mono)",
            color: "var(--fg-1)",
            background: "var(--paper-2)",
            border: "1px solid var(--line-1)",
            borderRadius: "var(--radius-1)",
            padding: "var(--space-2)",
          }}
        />
        <p style={HELPER_STYLE}>{t("settings.ai.excludedHelper")}</p>
      </div>
    </div>
  );
}
