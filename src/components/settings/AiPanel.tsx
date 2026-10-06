// Settings → AI panel (local-ai epic, ai-ux-surface MYND-408, task 4).
//
// The opt-in surface for the experimental, LOCAL-ONLY AI features: an
// `ai_enabled` toggle (SYNC-12), the threat-model-bounded trust affordance
// (SYNC-16 — the load-bearing headline + a "How does this work?" disclosure), a
// per-role side-load model picker (SYNC-1 — the user brings their own files;
// Myne NEVER downloads them), an `auto_tag_enabled` sub-toggle (MYND-651), and
// an `ai_excluded_folders` editor (SYNC-14, same set encoding as
// deliberate_folders).
//
// Model acquisition (SYNC-1/2): Myne never fetches a model — that half is
// unchanged and is a standing commitment. The reasoning behind it is not: the
// old "Myne has no network egress path by construction" is superseded
// (`decisions.md` 2026-08-09 — a user-named provider may open one, and
// 2026-08-04 already showed the gate never proved that claim anyway). The
// commitment now rests on there being no fetch path in Myne's own code, not on
// the process being unable to reach the network. The "Recommended
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

import { consentIsDeviceScoped } from "@myne/copy";
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type CSSProperties,
} from "react";
import { useTranslation } from "react-i18next";
import { open as openFileDialog } from "../../platform/dialog";
import { openUrl } from "../../platform/opener";

import type {
  EndpointRejection,
  ModelRole,
  ProviderModel,
} from "../../lib/ai-model-store";
import { usePrefs } from "../../hooks/usePrefs";
import {
  endpointRejectionOf,
  listProviderModels,
  loadAiEndpoint,
  loadModelPath,
  saveAiEndpoint,
  saveModelPath,
} from "../../lib/ai-model-store";
import type { ProviderErrorCause } from "../../lib/engine-error";
import { normalizeProviderError, providerErrorKey } from "../../lib/engine-error";
import {
  aiProviderHasKey,
  setAiProvider,
  setAiProviderConsent,
  setAiProviderKey,
  setAiProviderModel,
  mutationFrom,
} from "../../lib/prefs";
import {
  aiCapabilityReport,
  providerLabelOf,
  type AiCapabilityReport,
} from "../../lib/ai-capability";
import {
  AI_TRUST_INVARIANT,
  aiTrustDisclosure,
  aiTrustHeadline,
  type AiTrustState,
} from "../../lib/load-bearing-copy";
import { Input } from "../primitives/Input";
import { Button } from "../primitives/Button";
import { Select } from "../primitives/Select";
import { SearchableSelect } from "../primitives/SearchableSelect";
import { AiProviderConsent } from "./AiProviderConsent";
import { Switch } from "../primitives/Switch";
import { CHAT_HISTORY_BUDGET_MAX } from "../../lib/agent-run";
import { removeModel, type DownloadArtifactId } from "../../lib/ai-model-download";
import {
  cancelModelDownloadFor,
  startModelDownload,
  useModelDownload,
} from "../../lib/ai-download-store";
import { SettingRow } from "./SettingRow";
import { MemorySection } from "./MemorySection";
import {
  BLOCK_STYLE,
  MULTILINE_STYLE,
  HELPER_STYLE,
  LABEL_STYLE,
  PANEL_ROOT_STYLE,
  TOGGLE_ROW_STYLE,
} from "./panel-styles";

const TITLE_STYLE: CSSProperties = {
  margin: 0,
  fontSize: "var(--text-lg)",
  fontWeight: "var(--weight-semibold)" as CSSProperties["fontWeight"],
  color: "var(--fg-1)",
};

const LINK_STYLE: CSSProperties = {
  fontSize: "var(--text-sm)",
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
  gap: "var(--space-1)",
  alignSelf: "flex-start",
  transition: "color var(--duration-fast) var(--ease-standard)",
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
  tag: {
    name: "Qwen2.5-0.5B-Instruct (GGUF)",
    url: "https://huggingface.co/Qwen/Qwen2.5-0.5B-Instruct-GGUF",
  },
};

/**
 * The one local model runtime this row names (SYNC-17). A proper noun and a
 * project URL, so it lives here as a constant rather than in the catalog.
 *
 * The link is the SAME OS handoff the recommended-model links use — the user's
 * own browser opens it. That is what keeps "Myne never downloads models" true
 * without an exception: nothing here fetches, and the row offers no "pull a
 * model" affordance for the same reason.
 */
const LOCAL_RUNTIME = { name: "Ollama", url: "https://ollama.com" };

/**
 * The conventional address, shown ONLY as placeholder text.
 *
 * Storing it as a default would be Myne naming an endpoint the user did not,
 * which is exactly what the default-state invariant forbids (`decisions.md`
 * 2026-08-09): unset must mean the code path is unreachable, not pre-filled.
 * Placeholder-as-hint keeps it discoverable while the stored value stays empty.
 */
const ENDPOINT_PLACEHOLDER = "http://127.0.0.1:11434";

/**
 * The closed set of remote providers, mirroring the host's
 * `KNOWN_AI_PROVIDERS`. Proper nouns, so they live here rather than in the
 * catalog; `none` is the default and is the **unreachable** state, not a
 * disabled one.
 *
 * Not a free-form field, and not a curated list Myne maintains beyond these
 * two: a destination the user types is one the consent screen cannot name.
 */
const REMOTE_PROVIDERS: { wire: string; label: string }[] = [
  { wire: "ollama-cloud", label: "Ollama Cloud" },
  { wire: "openrouter", label: "OpenRouter" },
];

/** One mapping, shared with the chat transcript (#191 task 4) — this used to be
 *  a private copy here, which is why the transcript could not name a provider. */
function providerLabel(wire: string | null): string {
  return providerLabelOf(wire) ?? "";
}

/** Per-role side-load file filter for the OS picker (SYNC-1). */
// File-picker filters. The `name` is user-visible in the OS dialog, so it is
// stored as an i18n KEY and resolved with `t()` at usage (never frozen at module
// scope — src/AGENTS.md i18n discipline); the extensions are stable data.
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
  tag: {
    // The tag role is a Qwen2 GGUF (`load_tag` via `from_gguf`), so the same
    // `.gguf` filter applies.
    nameKey: "settings.ai.modelFilter.gguf",
    extensions: ["gguf"],
  },
};

/**
 * The message for a closed refusal reason.
 *
 * An exhaustive `switch` with **static** quoted keys rather than a template
 * literal: `scripts/check-i18n.mjs` only verifies keys it can read statically,
 * so a computed-key `t()` would let a missing catalog entry ship. This also
 * fails to compile when a fourth `EndpointRejection` arrives, which is the
 * whole point of the Rust side keeping that enum closed.
 */
function endpointRejectionText(
  t: (key: string) => string,
  reason: EndpointRejection,
): string {
  switch (reason) {
    case "malformed":
      return t("settings.ai.endpointRejected.malformed");
    case "unsupported_scheme":
      return t("settings.ai.endpointRejected.unsupportedScheme");
    case "not_loopback":
      return t("settings.ai.endpointRejected.notLoopback");
  }
}

interface AiPanelProps {
  onShowToast?: (message: string) => void;
  /**
   * Raised while this panel has a modal dialog of its own up (the provider
   * consent). The Settings shell listens on `window` for Esc, and so does
   * `ModalShell` — ungated, one Esc press closes both. The shell uses this to
   * stand down while a child dialog owns the key.
   */
  onDialogOpenChange?: (open: boolean) => void;
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
          className="myne-text-link"
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
            fontSize: "var(--text-sm)",
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
        <Button
          variant="secondary"
          data-testid={props.testIdChoose}
          disabled={props.disabled}
          onClick={props.onChoose}
          style={{ fontSize: "var(--text-sm)", whiteSpace: "nowrap" }}
        >
          {props.chooseLabel}
        </Button>
      </div>
    </div>
  );
}

/** One downloadable model the desktop can fetch on demand (myne-md/myne#805).
 *  `artifact` is a compiled-in id; the UI never constructs a URL or a digest.
 *  Shown only when the host resolves a stored path for the role (downloaded or
 *  side-loaded), so the same row answers "is it installed" and "fetch it again". */
function DownloadedModelRow(props: {
  artifact: DownloadArtifactId;
  /** The model-store role this artefact registers (for remove). */
  role: string;
  label: string;
  sizeText: string;
  path: string | null;
  aiEnabled: boolean;
  onChanged: () => void;
  onShowToast?: (message: string) => void;
}) {
  const { t } = useTranslation();
  // The download lives in the module-scope store, so it survives this row
  // unmounting when the user switches Settings panels (myne-md/myne#814).
  const download = useModelDownload(props.artifact);
  const [error, setError] = useState<string | null>(null);
  const [removing, setRemoving] = useState(false);

  const downloading = download.status === "downloading";
  const busy = downloading || removing;
  const percent =
    download.total > 0
      ? Math.min(100, Math.round((download.downloaded / download.total) * 100))
      : 0;

  // Surface a terminal failure once: inline copy plus a toast, one cause to one
  // message (the checksum branch names itself).
  const announcedRef = useRef(false);
  useEffect(() => {
    if (download.status !== "failed") {
      announcedRef.current = false;
      return;
    }
    if (announcedRef.current) return;
    announcedRef.current = true;
    const message =
      download.cause === "checksum"
        ? t("settings.ai.downloadFailedChecksum")
        : t("settings.ai.downloadFailed");
    setError(message);
    props.onShowToast?.(message);
    // `props.onShowToast` and `t` are stable enough for this one-shot; the
    // `announcedRef` guard makes a re-run idempotent.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [download.status, download.cause]);

  // A completed download (this mount or a background one) reloads the stored
  // path so the row flips to "Installed".
  const completedRef = useRef(false);
  useEffect(() => {
    if (download.status === "complete" && !completedRef.current) {
      completedRef.current = true;
      props.onChanged();
    }
    if (download.status !== "complete") completedRef.current = false;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [download.status]);

  const remove = async () => {
    setRemoving(true);
    setError(null);
    try {
      await removeModel(props.role);
      props.onChanged();
    } catch {
      setError(t("settings.ai.downloadFailed"));
    } finally {
      setRemoving(false);
    }
  };

  return (
    <SettingRow
      anchorId={`ai.download.${props.artifact}`}
      label={props.label}
      helper={props.sizeText}
      testId={`ai.download-row-${props.artifact}`}
      error={error}
      control={(helperId) =>
        downloading ? (
          <div
            style={{
              display: "flex",
              gap: "var(--space-2)",
              alignItems: "center",
            }}
          >
            <div
              data-testid={`ai.download-progress-${props.artifact}`}
              role="progressbar"
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={percent}
              style={{
                width: 120,
                height: 6,
                background: "var(--paper-3)",
                borderRadius: "var(--radius-2)",
                overflow: "hidden",
              }}
            >
              <div
                style={{
                  width: "100%",
                  height: "100%",
                  background: "var(--accent)",
                  transformOrigin: "left",
                  // A determinate fill animated with `transform: scaleX`, not
                  // `width`: scaling runs on the compositor, while a `width`
                  // transition lays out and paints every frame
                  // (`scripts/check-motion-canon.mjs`).
                  transform: `scaleX(${percent / 100})`,
                  transition: "transform var(--duration-fast) var(--ease-standard)",
                }}
              />
            </div>
            <span
              data-testid={`ai.download-percent-${props.artifact}`}
              aria-describedby={helperId}
              style={{
                fontSize: "var(--text-sm)",
                color: "var(--fg-2)",
                fontFamily: "var(--font-mono)",
                minWidth: "4ch",
              }}
            >
              {t("settings.ai.downloadingPercent", { percent })}
            </span>
            <Button
              variant="ghost"
              onClick={() => cancelModelDownloadFor(props.artifact)}
              data-testid={`ai.download-cancel-${props.artifact}`}
            >
              {t("settings.ai.downloadCancel")}
            </Button>
          </div>
        ) : (
          <div
            style={{
              display: "flex",
              gap: "var(--space-2)",
              alignItems: "center",
            }}
          >
            <span
              data-testid={`ai.download-state-${props.artifact}`}
              style={{
                fontSize: "var(--text-sm)",
                color: props.path ? "var(--accent)" : "var(--fg-3)",
                fontFamily: "var(--font-mono)",
              }}
              aria-describedby={helperId}
            >
              {props.path
                ? t("settings.ai.downloadInstalled")
                : t("settings.ai.downloadNotInstalled")}
            </span>
            <Button
              variant="secondary"
              disabled={!props.aiEnabled || busy}
              onClick={() => void startModelDownload(props.artifact)}
              data-testid={`ai.download-button-${props.artifact}`}
            >
              {t("settings.ai.downloadReinstall")}
            </Button>
            {props.path && (
              <Button
                variant="ghost"
                disabled={!props.aiEnabled || busy}
                onClick={() => void remove()}
                data-testid={`ai.remove-button-${props.artifact}`}
              >
                {t("settings.ai.modelRemove")}
              </Button>
            )}
          </div>
        )
      }
    />
  );
}

export function AiPanel({ onShowToast, onDialogOpenChange }: AiPanelProps) {
  const { t } = useTranslation();
  const { prefs, setAiEnabled, setAiExcludedFolders, setAutoTagEnabled, setChatHistoryBudget } =
    usePrefs(onShowToast);

  const [disclosureOpen, setDisclosureOpen] = useState(false);
  const [modelPaths, setModelPaths] = useState<Record<ModelRole, string | null>>({
    generation: null,
    embedding: null,
    transcription: null,
    tag: null,
  });
  /** The host's own view of which backend is active (myne-md/myne#466). `null`
   *  until the first report lands, which renders as "nothing is answering" —
   *  the honest reading of "we have not been told yet", and the same thing the
   *  panel showed before any provider was configured. */
  const [capability, setCapability] = useState<AiCapabilityReport | null>(null);
  // Local edit buffer for the excluded-folders textarea (one folder/line); the
  // backend NFC-sorts + dedups the set on encode, so the raw lines are fine.
  const [excludedDraft, setExcludedDraft] = useState<string>(
    prefs.ai_excluded_folders.join("\n"),
  );
  // Local edit buffer for the history-budget input. Empty string is the unset
  // state, which is a real third value rather than a zero: zero means "seed
  // nothing", which is the pre-#617 behaviour and a legitimate choice.
  const [historyBudgetDraft, setHistoryBudgetDraft] = useState<string>(
    prefs.chat_history_budget === null ? "" : String(prefs.chat_history_budget),
  );
  // **Re-synced from `prefs`, which is what makes the clamp visible.** The host
  // stores a lower number than the one typed when it exceeds the ceiling, and
  // `usePrefs` re-reads after a successful write; without this the input kept
  // showing 99999 while 12000 was what a run would use, so the one thing the
  // clamp-at-the-write design needs from the UI was the thing it did not do.
  //
  // Cannot clobber typing: `prefs` changes only on a write, and the write is
  // what this effect is reporting.
  useEffect(() => {
    setHistoryBudgetDraft(
      prefs.chat_history_budget === null ? "" : String(prefs.chat_history_budget),
    );
  }, [prefs.chat_history_budget]);
  // What the draft was seeded from, which is what a commit must diff against.
  // NOT `prefs.ai_excluded_folders` at commit time: the user may have been
  // typing for minutes, and an exclusion a peer added in that window is in the
  // cache and not in the draft, so diffing against the cache would call it a
  // removal and delete it on every device (myne-md/myne#613). An entry that
  // arrived after the seed is in neither side and is therefore never claimed.
  const excludedSeedRef = useRef<string[]>(prefs.ai_excluded_folders);
  // Both of the two above are `useState`/`useRef` INITIALISERS, so they captured
  // the first render's value, and at first render `usePrefs` still holds
  // `DEFAULT_PREFS` (its disk read lands in an effect). That made the textarea
  // render empty over a non-empty stored set, and worse, it made
  // `mutationFrom(seed, folders)` add-only: an exclusion stored before the panel
  // opened could not be removed through this surface AT ALL. Before the
  // add/remove verbs the whole-set write removed it, destructively but
  // effectively, so this regressed the control `docs/threat-model.md` A17 rests
  // its remote-provider mitigation on.
  //
  // Re-seed once, when the read lands. `touchedRef` is what keeps a user who
  // started typing before the read from having their edit replaced: the guard is
  // the reason this is an effect rather than a `key` on the textarea.
  const excludedTouchedRef = useRef(false);
  useEffect(() => {
    if (excludedTouchedRef.current) return;
    excludedSeedRef.current = prefs.ai_excluded_folders;
    setExcludedDraft(prefs.ai_excluded_folders.join("\n"));
  }, [prefs.ai_excluded_folders]);
  // The endpoint edit buffer. Starts empty and STAYS empty until the host says
  // otherwise — the placeholder is the only place the conventional address
  // appears (see `ENDPOINT_PLACEHOLDER`).
  const [endpointDraft, setEndpointDraft] = useState("");
  // The model name at that endpoint. Also starts empty and has NO default —
  // SYNC-24: a pinned tag rots, and Myne picking one on the user's behalf is a
  // choice they did not make. Without it the URL is stored but builds no
  // engine, which is what keeps a half-filled row from silently sending
  // anything.
  const [modelDraft, setModelDraft] = useState("");
  // Which rule refused the last save, or `null`. Never the URL that was
  // refused: the field still holds what the user typed, and the message says
  // what is wrong with it without repeating it into the DOM.
  const [endpointRejection, setEndpointRejection] =
    useState<EndpointRejection | null>(null);
  // What the HOST has stored, as distinct from what is in the field. The trust
  // copy keys off this one — see `trustState` below.
  const [savedEndpoint, setSavedEndpoint] = useState<string | null>(null);
  // Whether the HOST holds a key. The panel never learns the key itself — the
  // field is serde-skipped out of `prefs_read` — so this boolean is the only
  // thing that can distinguish "Add key" from "Replace key".
  const [hasKey, setHasKey] = useState(false);
  // The key currently being typed. Never seeded from storage (there is nothing
  // to seed it from) and cleared the moment it is saved, so a stored
  // credential never sits in React state.
  const [keyDraft, setKeyDraft] = useState("");
  // The provider awaiting consent, or `null`. Selecting a provider whose
  // consent is not already recorded routes HERE first; nothing is stored until
  // the dialog is accepted.
  const [pendingProvider, setPendingProvider] = useState<string | null>(null);
  // Tell the Settings shell a modal of ours is up (see `onDialogOpenChange`).
  // The cleanup is load-bearing: the shell's flag outlives this panel, so
  // unmounting with the dialog open — Settings closed by its own × — would
  // leave Esc gated for every later session.
  useEffect(() => {
    onDialogOpenChange?.(pendingProvider !== null);
    return () => onDialogOpenChange?.(false);
  }, [pendingProvider, onDialogOpenChange]);
  // The provider's own catalogue, and the three states it can be in. `null` is
  // "not asked yet" and is NOT the same as `[]` ("asked, and the provider
  // published none") — collapsing them would tell the user a provider has no
  // models when in fact nobody has looked (SYNC-24 task 17).
  const [models, setModels] = useState<ProviderModel[] | null>(null);
  const [modelsError, setModelsError] = useState<ProviderErrorCause | null>(
    null,
  );
  const [modelsLoading, setModelsLoading] = useState(false);
  // Show what the filter hides. Deliberately component-local rather than a
  // stored preference: the catalogue itself is not persisted either (every
  // visit starts at "Load models"), so a switch that outlived the list it
  // filters would be a setting about nothing — and a persisted field here would
  // owe the whole `PrefsView` + encoder + parser + sync-table + spec §9.5.2
  // chain for a view toggle.
  const [showAllModels, setShowAllModels] = useState(false);

  const aiEnabled = prefs.ai_enabled;
  // Who answers at rest — asked of the HOST, not of the preferences
  // (myne-md/myne#466).
  //
  // This used to read `prefs.ai_provider` alone and carried a comment claiming
  // it could not disagree with the request path because it read "the SAME
  // stored state the host's own gate reads". That was wrong. The gate is
  // `LocalInferenceState::active()`, and it checks SEVEN things — developer
  // mode, the AI beta flag, a recognized provider, matching consent, a stored
  // key, a NON-EMPTY `ai_provider_model`, and that the preferences came from
  // the vault that is unlocked right now — falling back to the local arm the
  // moment any one of them fails. Naming a provider satisfies exactly one of
  // the seven. A user who named a provider and never picked a model therefore
  // read "Answered by <Provider>" here while every request went to the local
  // engine; when that engine then failed, the failure looked like the
  // provider's. Attribution of where a note's text goes is a trust surface, so
  // it has to name what happened, not what was intended.
  //
  // `backendClass` is the host's own verdict. The NAME still comes from the
  // preferences, because only they carry it — but it is shown only for the
  // class the host says is active, so the claim can no longer outrun the fact.
  const backendClass = capability?.backendClass ?? null;
  // Whether this build ships the bundled auto-tag model, derived rather than
  // stored: it is one field of the report the panel already holds, and a second
  // `useState` hydrated from the same callback is a copy that can be updated in
  // one place and not the other. `null` while the report is in flight, so the
  // switch never flickers through a disabled state on open. Unlike every other
  // role there is no side-load fallback, so `false` is permanent for this build
  // and the panel has to say so rather than offer a switch that can only ever
  // persist `true`.
  const tagModel = capability?.autoTag.available ?? null;

  // `undefined` is the "nothing is set up yet" state, NOT an empty string.
  const activeProviderName: string | undefined =
    backendClass === "remote"
      ? providerLabelOf(prefs.ai_provider)
      : backendClass === "loopback_local"
        ? (savedEndpoint ?? undefined)
        : undefined;
  // The trust headline answers a DIFFERENT question from the caption above, and
  // the difference is deliberate. The caption says *who answered*; this says
  // *where this configuration can send your text*. So it stays on the union —
  // remote if the host resolved remote OR a provider is named — rather than on
  // the host's verdict alone.
  //
  // The asymmetry is a safety direction, not an oversight. Over-claiming egress
  // makes a user more careful than they need to be; under-claiming tells
  // someone their text stays on the device while it leaves. Deriving this from
  // `backendClass` alone would under-claim twice: once in the window before the
  // first report lands (`capability` is null, which would read as in-process),
  // and once for a user who named a provider and has not yet picked a model —
  // one keystroke away from egress, on the very panel where they will make it.
  //
  // The endpoint draft is deliberately NOT consulted: a half-typed address is
  // not a configured runtime, and the copy must describe what is in effect
  // rather than what is being typed.
  const trustState: AiTrustState = prefs.ai_provider
    ? { kind: "remote", provider: prefs.ai_provider }
    : backendClass === "loopback_local" || savedEndpoint
      ? { kind: "local-runtime", name: LOCAL_RUNTIME.name }
      : { kind: "in-process" };
  const autoTag = prefs.auto_tag_enabled;

  // Read every role's persisted path from the host. Shared by the mount effect
  // and the download rows' `onChanged`, so a completed download updates the
  // installed state without remounting the panel (myne-md/myne#805).
  const reloadModelPaths = useCallback(() => {
    (["generation", "embedding", "transcription", "tag"] as const).forEach((role) => {
      loadModelPath(role)
        .then((p) => setModelPaths((prev) => ({ ...prev, [role]: p })))
        .catch(() => {
          /* feature off / not set: keep local state */
        });
    });
  }, []);

  // Load the persisted device-local model paths on open (all roles). A missing
  // command (the `local-inference` feature is off) degrades silently to no
  // persisted path — the panel stays usable.
  useEffect(() => {
    let alive = true;
    (["generation", "embedding", "transcription", "tag"] as const).forEach((role) => {
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

  // Load the persisted endpoint on open. A build without the feature, or no
  // configured endpoint, both answer `null` — which is the field's start state
  // anyway, so nothing to distinguish here.
  useEffect(() => {
    let alive = true;
    void loadAiEndpoint().then((endpoint) => {
      if (!alive || !endpoint) return;
      setEndpointDraft(endpoint.url);
      setModelDraft(endpoint.model);
      setSavedEndpoint(endpoint.url || null);
    });
    return () => {
      alive = false;
    };
  }, []);

  useEffect(() => {
    let alive = true;
    void aiProviderHasKey().then((present) => {
      if (alive) setHasKey(present);
    });
    return () => {
      alive = false;
    };
  }, [prefs.ai_provider]);

  // Probe the auto-tag feature once, independently of `ai_enabled`: it is a
  // fact about the build, and a user who turns the beta ON should not have to
  // discover only then that this build has no tag model.
  //
  // Reads the one capability report (SYNC-5) rather than the old
  // `tagModelAvailable()` probe. Same question, better answer: the old probe
  // degraded every rejection to `false` and documented the conflation as
  // deliberate — "the command is missing" and "no blob shipped" being the same
  // fact from the panel's side. That stops being true the moment a backend can
  // be present-but-unreachable, and the report names the cause instead.
  // Rendering that cause is #191's; this panel still shows the same boolean.
  //
  // Re-run when anything `active()` reads changes (myne-md/myne#466): the
  // report now also drives the "who is answering" caption, and a caption that
  // only refreshed on mount would keep claiming the old backend for the rest of
  // the session — the exact staleness this slice exists to remove. `hasKey`
  // is in the list because storing a key is what completes the remote gate,
  // and it is state on this side rather than a preference field.
  useEffect(() => {
    let alive = true;
    void aiCapabilityReport().then((report) => {
      if (!alive) return;
      setCapability(report);
    });
    return () => {
      alive = false;
    };
  }, [
    prefs.ai_enabled,
    prefs.ai_provider,
    prefs.ai_provider_consent,
    prefs.ai_provider_model,
    // `prefs.developer_mode` was in this list until myne-md/myne#456, when it
    // stopped being a precondition in `provider_gate`. The capability report no
    // longer moves when it changes, so re-running the effect on it would be a
    // dependency on a value the answer does not depend on.
    hasKey,
    // `saveAiEndpoint` writes to the device-local model store, not `vault.prefs`,
    // so none of the fields above move when an endpoint is configured. Without
    // this the caption keeps saying nothing is answering while the loopback
    // runtime the user just set up is what answers, which is the staleness this
    // effect's dependency list exists to remove.
    savedEndpoint,
  ]);

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

  const openLocalRuntime = () => {
    // The user's OWN browser, via the same OS handoff as the model links.
    openUrl(LOCAL_RUNTIME.url).catch((err) => {
      if (import.meta.env.DEV) {
        console.warn("AiPanel: openUrl(local runtime) rejected", err);
      }
    });
  };

  const commitEndpoint = async () => {
    const url = endpointDraft.trim();
    try {
      const accepted = await saveAiEndpoint(url, modelDraft.trim());
      setEndpointRejection(null);
      // Show what the host stored, not what was typed — validation normalizes.
      setEndpointDraft(accepted ?? "");
      setSavedEndpoint(accepted ?? null);
    } catch (err) {
      const reason = endpointRejectionOf(err);
      setEndpointRejection(reason);
      if (reason === null) {
        // An IO or parse failure, not a refusal of this URL. A toast rather
        // than an inline message under the field, because the field is not
        // what is wrong.
        onShowToast?.(t("settings.ai.endpointSaveFailed"));
      }
    }
  };

  /** Choosing a provider. First-time selection routes through the consent
   *  screen BEFORE anything is stored — the screen is the asking, and storing
   *  first would make it a notification. */
  const chooseProvider = (wire: string | null) => {
    if (wire === null) {
      // Clearing. The host drops the key and the consent with it, so this is
      // also the revoke path — one action, not three the user must remember.
      void setAiProvider(null);
      setHasKey(false);
      setKeyDraft("");
      return;
    }
    // `consentIsDeviceScoped`, not an equality against the provider name. A
    // legacy bare-name value is what a desktop install that turned Developer
    // mode off holds, and an equality would read it as current and skip the
    // consent screen, which is the upgrade that starts sending note text with
    // no user act (myne-md/myne#456).
    if (consentIsDeviceScoped(prefs.ai_provider_consent, wire)) {
      // Already consented to this exact provider — switching back does not
      // re-ask, because the recipient is one they have already agreed to.
      void setAiProvider(wire);
      return;
    }
    setPendingProvider(wire);
  };

  const acceptConsent = async () => {
    const wire = pendingProvider;
    if (wire === null) return;
    setPendingProvider(null);
    // Order matters: the provider first, because the host clears consent when
    // the selection CHANGES. Recording consent first would have it wiped by
    // the very next write.
    await setAiProvider(wire);
    await setAiProviderConsent(wire);
  };

  const commitKey = async () => {
    const next = keyDraft.trim();
    if (next.length === 0) return;
    await setAiProviderKey(next);
    // Out of React state the instant it is stored. Rotating does NOT touch
    // consent — the recipient has not changed.
    setKeyDraft("");
    setHasKey(true);
  };

  const revokeKey = async () => {
    await setAiProviderKey(null);
    setKeyDraft("");
    setHasKey(false);
    // The catalogue was fetched with that credential and is no longer ours to
    // show. Back to "not asked", not to an empty list.
    setModels(null);
    setModelsError(null);
    setShowAllModels(false);
  };

  /** Ask the provider what it publishes. Explicit rather than automatic: the
   *  call is an egress, and a panel that reaches a provider merely because it
   *  was opened would be sending on nobody's instruction. */
  const loadModels = async () => {
    setModelsLoading(true);
    setModelsError(null);
    try {
      setModels(await listProviderModels());
    } catch (err) {
      setModels(null);
      setModelsError(normalizeProviderError(err));
    } finally {
      setModelsLoading(false);
    }
  };

  const commitExcluded = () => {
    const folders = excludedDraft
      .split("\n")
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
    void setAiExcludedFolders(mutationFrom(excludedSeedRef.current, folders), folders);
    excludedSeedRef.current = folders;
    // The draft now IS the seed, so a later prefs change may re-seed again.
    excludedTouchedRef.current = false;
  };

  // The catalogue, filtered to what this arm can actually use. Myne's remote
  // path calls nothing but chat/completion, so a model that does not read AND
  // write text is an offer that would fail — on a metered API, after billing.
  //
  // Hiding rather than dropping: the host sends its verdict per model instead
  // of filtering, so "show all" is a toggle over the ONE fetch already made,
  // and a model this classification gets wrong stays reachable without a
  // release. See `ProviderModel.text_capable`.
  const textModels = models?.filter((m) => m.text_capable) ?? null;
  const hiddenCount =
    models !== null && textModels !== null ? models.length - textModels.length : 0;
  const visibleModels = (showAllModels ? models : textModels) ?? null;

  // A stored model is ALWAYS offered, even when the filter would hide it — a
  // model chosen before this filter existed, or written by the CLI, is stored
  // and answering. Leaving it out of the options makes SearchableSelect
  // summarise an empty selection, so the panel would show "No model chosen"
  // about a vault that has one.
  const storedModel = prefs.ai_provider_model;
  const modelOptions =
    visibleModels === null
      ? []
      : [
          { value: "", label: t("settings.ai.providerModelNone") },
          ...(storedModel !== null &&
          storedModel !== "" &&
          !visibleModels.some((m) => m.id === storedModel)
            ? [{ value: storedModel, label: storedModel }]
            : []),
          ...visibleModels.map((m) => ({ value: m.id, label: m.id })),
        ];

  return (
    <div data-testid="settings.ai-panel" style={PANEL_ROOT_STYLE}>
      <h3 style={TITLE_STYLE}>{t("settings.ai.title")}</h3>

      {/* Opt-in toggle. */}
      <SettingRow
        anchorId="ai.enable"
        label={t("settings.ai.enableLabel")}
        helper={t("settings.ai.enableHelper")}
        control={(helperId) => (
          <Switch
            checked={aiEnabled}
            onChange={(next) => void setAiEnabled(next)}
            ariaLabel={t("settings.ai.enableLabel")}
            ariaDescribedBy={helperId}
            testId="ai.enable-toggle"
          />
        )}
      />

      {/* Trust affordance — load-bearing copy, rendered verbatim (SYNC-16 /
          SYNC-7). One INVARIANT sentence, always shown, plus one STATE
          sentence selected by which backend is answering: a provider IS a
          server, so the old flat "runs entirely on your device" claim is false
          the moment one is named (`decisions.md` 2026-08-09). */}
      <div style={BLOCK_STYLE}>
        <p data-testid="ai.trust-invariant" style={{ ...LABEL_STYLE, lineHeight: 1.5 }}>
          {AI_TRUST_INVARIANT}
        </p>
        <p data-testid="ai.trust-headline" style={{ ...LABEL_STYLE, lineHeight: 1.5 }}>
          {aiTrustHeadline(trustState)}
        </p>
        <button
          type="button"
          className="myne-text-link"
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
            fontSize: "var(--text-sm)",
            cursor: "pointer",
          }}
        >
          {t("settings.ai.disclosureToggle")}
        </button>
        {disclosureOpen && (
          <p data-testid="ai.trust-disclosure" style={{ ...HELPER_STYLE, lineHeight: 1.5 }}>
            {aiTrustDisclosure(trustState)}
          </p>
        )}
        {/* What is answering RIGHT NOW (#191 task 5, SYNC-13). A read-only
            caption, deliberately NOT a `SettingRow`: a caption adds no setting,
            and a setting would owe a `settingsSearchIndex.ts` entry plus a
            control the user could operate — which SYNC-19 removed from scope.
            It sits in the trust block because it is the same question that
            block answers, one level more concrete. */}
        <p data-testid="ai.active-provider" style={{ ...HELPER_STYLE, lineHeight: 1.5 }}>
          {activeProviderName === undefined
            ? t("settings.ai.providerNothingAnswering")
            : t("settings.ai.providerActive", { name: activeProviderName })}
        </p>
      </div>

      {/* Auto-tag (MYND-651) — a sub-feature of the beta, so it follows the
          enable toggle rather than sitting in Models: the tag pass runs on a
          BUNDLED model, nothing to side-load. Disabled (not hidden) while the
          beta is off, matching every other dependent control in this panel; the
          host re-reads both flags before it loads a model, so this surface is
          discovery, not enforcement.

          It is ALSO disabled when the build ships no tag model, with the reason
          spelled out — the disabled-control discipline in `src/AGENTS.md`: a
          real label, no "coming soon" copy, and it enables itself on the build
          that lands the weights. Without it the switch persists `true` against
          a host that answers `not_ready` forever and a band that never appears,
          which is a control that lies by omission. */}
      <SettingRow
        anchorId="ai.auto-tag"
        label={t("settings.ai.autoTagLabel")}
        helper={t("settings.ai.autoTagHelper")}
        control={(helperId) => (
          <Switch
            checked={autoTag}
            disabled={!aiEnabled || tagModel === false}
            onChange={(next) => void setAutoTagEnabled(next)}
            ariaLabel={t("settings.ai.autoTagLabel")}
            ariaDescribedBy={helperId}
            testId="ai.auto-tag-toggle"
          />
        )}
      >
        {tagModel === false && (
          <p data-testid="ai.auto-tag-unavailable" style={{ ...HELPER_STYLE, color: "var(--fg-2)" }}>
            {t("settings.ai.autoTagUnavailable")}
          </p>
        )}
      </SettingRow>

      {/* How much of the visible conversation an agent run is seeded with
          (myne-md/myne#617).

          **A bound, presented as one.** The number is multiplied by the loop's
          iteration ceiling and, on a remote provider, by characters that leave
          the device, so the helper says what it costs rather than what it
          enables. The host CLAMPS it at the write, which is why this input does
          not: a bound enforced in the control is a bound the next caller does
          not inherit, and `usePrefs` re-reads after a successful write so the
          number shown is the number that stuck rather than the one typed.

          Empty means unset, and unset means the host's own default. That is a
          real third state, not a zero: zero would mean "seed nothing", which is
          the pre-#617 behaviour and a legitimate thing to want. */}
      <SettingRow
        anchorId="ai.history-budget"
        label={t("settings.ai.historyBudgetLabel")}
        helper={t("settings.ai.historyBudgetHelper")}
        control={(helperId) => (
          <Input
            id="ai-history-budget"
            type="number"
            // `SettingRow` renders its label as a `span`, not a `label
            // htmlFor`, so the `id` binds to nothing and the control would be
            // announced as an unnamed spin button carrying a long helper
            // sentence. Every other `SettingRow`-hosted control in this tree
            // supplies its own name for the same reason.
            aria-label={t("settings.ai.historyBudgetLabel")}
            // Gated like every other control in this panel. The budget bounds
            // what an agent run sends, and with AI off there is no run, so an
            // editable field here would be the one row that says otherwise.
            disabled={!aiEnabled}
            min={0}
            max={CHAT_HISTORY_BUDGET_MAX}
            value={historyBudgetDraft}
            onChange={(e) => setHistoryBudgetDraft(e.target.value)}
            onBlur={(e) => {
              // **`badInput` before the empty check, and that order is the
              // whole fix.** For `type="number"` the value IDL attribute
              // returns "" whenever the control holds something it cannot
              // parse, so "abc", "1e" and "--5" all arrive here as the empty
              // string and used to take the clear-the-override branch. A user
              // who select-alls, mistypes and tabs away had their bound reset
              // to the host default with no feedback, which is the opposite of
              // what the comment two lines down promises.
              if (e.target.validity.badInput) {
                setHistoryBudgetDraft(
                  prefs.chat_history_budget === null
                    ? ""
                    : String(prefs.chat_history_budget),
                );
                return;
              }
              const raw = historyBudgetDraft.trim();
              if (raw === "") {
                void setChatHistoryBudget(null);
                return;
              }
              const parsed = Number.parseInt(raw, 10);
              if (!Number.isFinite(parsed) || parsed < 0) {
                // Reject rather than coerce: silently turning nonsense into a
                // number would store a bound the user did not choose. Restoring
                // the shown value is the effect above's job, so this only has to
                // avoid writing.
                setHistoryBudgetDraft(
                  prefs.chat_history_budget === null ? "" : String(prefs.chat_history_budget),
                );
                return;
              }
              void setChatHistoryBudget(parsed);
            }}
            aria-describedby={helperId}
            data-testid="ai.history-budget-input"
            style={{ width: "8ch" }}
          />
        )}
      />

      {/* Models — side-load only, no in-app download (SYNC-1/2). Recommended
          links open in the user's browser; the pickers take the downloaded
          files. Three roles: text (GGUF) + search/embedding (safetensors) +
          speech-to-text (Whisper GGUF). */}
      <div
        style={BLOCK_STYLE}
        data-setting-anchor="ai.models"
        data-setting-row="true"
        data-testid="ai.models-section"
      >
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

      {/* Downloadable models (myne-md/myne#805, `decisions/ai/0628`).
          The AI-shaped weights are no longer bundled: a user who skipped
          onboarding enables AI and fetches them here, and the same rows answer
          "is it installed" from the device-local model store. No file name and
          no quantisation label is shown, only the feature and its size. */}
      <div
        style={BLOCK_STYLE}
        data-setting-anchor="ai.downloads"
        data-setting-row="true"
        data-testid="ai.downloads-section"
      >
        <label style={LABEL_STYLE}>{t("settings.ai.downloadsLabel")}</label>
        <p style={HELPER_STYLE}>{t("settings.ai.downloadsHelper")}</p>
        <DownloadedModelRow
          artifact="embedding-e5-small"
          role="embedding"
          label={t("settings.ai.modelEmbeddingLabel")}
          sizeText={t("settings.ai.downloadEmbeddingSize")}
          path={modelPaths.embedding}
          aiEnabled={aiEnabled}
          onChanged={reloadModelPaths}
          onShowToast={onShowToast}
        />
        <DownloadedModelRow
          artifact="tag"
          role="tag"
          label={t("settings.ai.downloadTagLabel")}
          sizeText={t("settings.ai.downloadTagSize")}
          path={modelPaths.tag}
          aiEnabled={aiEnabled}
          onChanged={reloadModelPaths}
          onShowToast={onShowToast}
        />
      </div>

      {/* Side-load disclosure (myne-md/myne#805). Developer mode lets a user
          point Myne at a model they sourced themselves; the disclosure states
          that plainly, because a side-loaded model is the untrusted-input case
          `threat-model.md` §7 now carries. */}
      <div
        style={BLOCK_STYLE}
        data-setting-anchor="ai.sideload"
        data-setting-row="true"
        data-testid="ai.sideload-disclosure"
      >
        <p style={HELPER_STYLE}>{t("settings.ai.sideloadDisclosure")}</p>
      </div>

      {/* Local model runtime (ai-ollama-local task 8, SYNC-17/SYNC-18).

          The alternative to side-loading a file: point Myne at a runtime the
          user already runs on this machine. Three things about this block are
          deliberate and should not be "tidied" away:

          1. The field ships EMPTY. The conventional address is placeholder text
             only — a stored default would be Myne naming an endpoint the user
             did not (`decisions.md` 2026-08-09 default-state invariant).
          2. The disclosure is GENERIC. It says the runtime is a separate
             program with its own network behaviour, and NOT what that program
             fetches or when — a version-specific claim would rot into a false
             statement Myne made about someone else's software.
          3. A refusal names the RULE, never the input. The user's URL is not
             echoed back into the DOM and no path appears.

          The panel already sits in the `developer` group; there is no second
          gate here on purpose. */}
      <div
        style={BLOCK_STYLE}
        data-setting-anchor="ai.endpoint"
        data-setting-row="true"
        data-testid="ai.endpoint-section"
      >
        <label style={LABEL_STYLE} htmlFor="ai-endpoint">
          {t("settings.ai.endpointLabel")}
        </label>
        <p style={HELPER_STYLE}>{t("settings.ai.endpointHelper")}</p>
        <div>
          <button
            type="button"
            data-testid="ai.endpoint-runtime-link"
            onClick={openLocalRuntime}
            className="myne-text-link"
            style={LINK_STYLE}
          >
            {LOCAL_RUNTIME.name}
            <span aria-hidden="true">↗</span>
          </button>
        </div>
        <p
          data-testid="ai.endpoint-third-party"
          style={{ ...HELPER_STYLE, marginTop: "var(--space-1)" }}
        >
          {t("settings.ai.endpointThirdParty", { name: LOCAL_RUNTIME.name })}
        </p>
        <div style={{ marginTop: "var(--space-1)" }}>
          <Input
            id="ai-endpoint"
            data-testid="ai.endpoint-input"
            mono
            type="text"
            inputMode="url"
            spellCheck={false}
            autoComplete="off"
            disabled={!aiEnabled}
            invalid={endpointRejection !== null}
            value={endpointDraft}
            placeholder={ENDPOINT_PLACEHOLDER}
            aria-describedby={
              endpointRejection !== null ? "ai-endpoint-error" : undefined
            }
            onChange={(e) => {
              setEndpointDraft(e.target.value);
              // Clear a stale refusal as soon as the input changes; leaving it
              // up would attach the old rule to a URL it never judged.
              if (endpointRejection !== null) setEndpointRejection(null);
            }}
            onBlur={() => void commitEndpoint()}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                void commitEndpoint();
              }
            }}
          />
        </div>
        {endpointRejection !== null && (
          <p
            id="ai-endpoint-error"
            data-testid="ai.endpoint-error"
            role="alert"
            style={{ ...HELPER_STYLE, color: "var(--danger)" }}
          >
            {endpointRejectionText(t, endpointRejection)}
          </p>
        )}

        {/* The model name at that address. No default and no suggestion list:
            a pinned tag rots, and on a metered API a default nobody chose is a
            bill nobody chose (SYNC-24). Empty means the URL is stored and no
            engine is built from it — the arm stays off rather than guessing. */}
        <label
          style={{ ...LABEL_STYLE, marginTop: "var(--space-2)" }}
          htmlFor="ai-endpoint-model"
        >
          {t("settings.ai.endpointModelLabel")}
        </label>
        <div style={{ marginTop: "var(--space-1)" }}>
          <Input
            id="ai-endpoint-model"
            data-testid="ai.endpoint-model-input"
            mono
            type="text"
            spellCheck={false}
            autoComplete="off"
            disabled={!aiEnabled}
            value={modelDraft}
            placeholder={t("settings.ai.endpointModelPlaceholder")}
            onChange={(e) => setModelDraft(e.target.value)}
            onBlur={() => void commitEndpoint()}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                void commitEndpoint();
              }
            }}
          />
        </div>
        <p style={HELPER_STYLE}>{t("settings.ai.endpointModelHelper")}</p>
      </div>

      {/* Remote provider (ai-remote-providers myne#415 task 14, SYNC-13/18).
          Below the models section because it is the alternative to them, and
          in the panel's shipped conventions rather than a new visual language.

          Four things here are deliberate:
          1. `none` is the DEFAULT and the unreachable state, not a disabled
             one — with nothing selected there is no remote path to reach.
          2. The key field NEVER renders a stored value. It cannot: the field
             is serde-skipped out of `prefs_read`, so the panel reads a boolean
             and shows "Add" or "Replace".
          3. First-time selection routes through the consent dialog BEFORE
             anything is stored. Storing first would make the dialog a
             notification. The segmented control shows the pending choice while
             the dialog is up — a control that does not move when clicked reads
             as broken — but that highlight is the only thing that happened:
             cancelling reverts it and no write occurred.
          4. Rotate does not re-ask consent (the recipient is unchanged);
             clearing the provider revokes the key AND the consent, so "turn
             this off" leaves the state of "never turned it on". */}
      <div
        style={BLOCK_STYLE}
        data-setting-anchor="ai.provider"
        data-setting-row="true"
        data-testid="ai.provider-section"
      >
        <AiProviderConsent
          open={pendingProvider !== null}
          providerLabel={providerLabel(pendingProvider)}
          onAccept={() => void acceptConsent()}
          onCancel={() => setPendingProvider(null)}
        />
        <label style={LABEL_STYLE}>{t("settings.ai.providerLabel")}</label>
        <p style={HELPER_STYLE}>{t("settings.ai.providerHelper")}</p>
        <div style={{ marginTop: "var(--space-1)" }}>
          <Select
            options={[
              { value: "none", label: t("settings.ai.providerNone") },
              ...REMOTE_PROVIDERS.map((p) => ({
                value: p.wire,
                label: p.label,
              })),
            ]}
            value={pendingProvider ?? prefs.ai_provider ?? "none"}
            onChange={(v) => chooseProvider(v === "none" ? null : v)}
            aria-label={t("settings.ai.providerLabel")}
            testId="ai.provider-choice"
          />
        </div>

        {prefs.ai_provider !== null && (
          <>
            <label
              style={{ ...LABEL_STYLE, marginTop: "var(--space-2)" }}
              htmlFor="ai-provider-key"
            >
              {t("settings.ai.providerKeyLabel")}
            </label>
            <div style={{ marginTop: "var(--space-1)" }}>
              <Input
                id="ai-provider-key"
                data-testid="ai.provider-key-input"
                mono
                type="password"
                spellCheck={false}
                autoComplete="off"
                disabled={!aiEnabled}
                value={keyDraft}
                placeholder={
                  hasKey
                    ? t("settings.ai.providerKeyReplace")
                    : t("settings.ai.providerKeyAdd")
                }
                onChange={(e) => setKeyDraft(e.target.value)}
                onBlur={() => void commitKey()}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    void commitKey();
                  }
                }}
              />
            </div>
            <p data-testid="ai.provider-key-state" style={HELPER_STYLE}>
              {hasKey
                ? t("settings.ai.providerKeyStored")
                : t("settings.ai.providerKeyNone")}
            </p>
            {hasKey && (
              <button
                type="button"
                data-testid="ai.provider-key-revoke"
                disabled={!aiEnabled}
                onClick={() => void revokeKey()}
                className="myne-text-link"
                style={LINK_STYLE}
              >
                {t("settings.ai.providerKeyRevoke")}
              </button>
            )}

            {/* The model chooser (SYNC-24). Gated on a stored key because
                there is nothing to ask the provider WITH before then — a
                disabled control with a real label, never "coming soon"
                (src/AGENTS.md disabled-control discipline). */}
            <label
              style={{ ...LABEL_STYLE, marginTop: "var(--space-2)" }}
              htmlFor="ai-provider-model"
            >
              {t("settings.ai.providerModelLabel")}
            </label>
            <p style={HELPER_STYLE}>
              {t("settings.ai.providerModelHelper")}
            </p>
            <div
              style={{
                ...TOGGLE_ROW_STYLE,
                marginTop: "var(--space-1)",
              }}
            >
              {visibleModels !== null && modelOptions.length > 1 ? (
                // SearchableSelect, not Select: a provider catalogue runs to
                // hundreds of entries, which is past where a plain dropdown is
                // usable — docs/design/README.md "The setting row",
                // decisions.md 2026-08-01. The synthetic "" option stays: the
                // primitive's `placeholder` DISPLAYS an empty selection but
                // offers no way to return to one, and letting a user put a
                // model back is existing behaviour.
                <SearchableSelect
                  options={modelOptions}
                  selected={
                    storedModel !== null && storedModel !== ""
                      ? [storedModel]
                      : []
                  }
                  onChange={(next) => {
                    const picked = next[0];
                    void setAiProviderModel(
                      picked === undefined || picked === "" ? null : picked,
                    );
                  }}
                  aria-label={t("settings.ai.providerModelLabel")}
                  placeholder={t("settings.ai.providerModelNone")}
                  testId="ai.provider-model-select"
                />
              ) : (
                <span
                  data-testid="ai.provider-model-current"
                  style={{
                    fontSize: "var(--text-sm)",
                    color:
                      prefs.ai_provider_model === null
                        ? "var(--fg-3)"
                        : "var(--fg-1)",
                    fontFamily: "var(--font-mono)",
                  }}
                >
                  {prefs.ai_provider_model ??
                    t("settings.ai.providerModelNone")}
                </span>
              )}
              <button
                type="button"
                data-testid="ai.provider-model-load"
                disabled={!aiEnabled || !hasKey || modelsLoading}
                onClick={() => void loadModels()}
                className="myne-text-link"
                style={LINK_STYLE}
              >
                {t("settings.ai.providerModelLoad")}
              </button>
              {/* Only offered when the filter is actually withholding
                  something — a link that always says "show all" while there is
                  nothing more to show implies a list is being kept from the
                  user when it is not. */}
              {hiddenCount > 0 && (
                <button
                  type="button"
                  data-testid="ai.provider-model-show-all"
                  onClick={() => setShowAllModels((v) => !v)}
                  className="myne-text-link"
                  style={LINK_STYLE}
                >
                  {showAllModels
                    ? t("settings.ai.providerModelShowTextOnly")
                    : t("settings.ai.providerModelShowAll")}
                </button>
              )}
            </div>
            {/* Four states, four sentences. `models === null` with no error is
                "nobody has asked yet"; an empty array is "we asked and the
                provider published none"; a non-empty array with nothing
                text-capable is a DIFFERENT fact — the provider does publish
                models, they are just not the kind Myne asks for, and saying
                "published no models" there would be false; an error names the
                refusal from the shared taxonomy. */}
            <p data-testid="ai.provider-model-state" style={HELPER_STYLE}>
              {modelsError !== null
                ? t(providerErrorKey(modelsError))
                : models === null || visibleModels === null
                  ? t("settings.ai.providerModelUnfetched")
                  : models.length === 0
                    ? t("settings.ai.providerModelEmpty")
                    : visibleModels.length === 0
                      ? t("settings.ai.providerModelNoTextModels")
                      : `${t("settings.ai.providerModelCount", {
                          count: visibleModels.length,
                        })}${
                          hiddenCount > 0 && !showAllModels
                            ? ` ${t("settings.ai.providerModelHidden", {
                                count: hiddenCount,
                              })}`
                            : ""
                        }`}
            </p>
          </>
        )}
      </div>

      {/* Excluded folders — same canonical set encoding as deliberate_folders. */}
      <div
        style={BLOCK_STYLE}
        data-setting-anchor="ai.excluded-folders"
        data-setting-row="true"
      >
        <label style={LABEL_STYLE} htmlFor="ai-excluded-folders">
          {t("settings.ai.excludedLabel")}
        </label>
        <textarea
          id="ai-excluded-folders"
          data-testid="ai.excluded-folders"
          value={excludedDraft}
          disabled={!aiEnabled}
          onChange={(e) => {
            excludedTouchedRef.current = true;
            setExcludedDraft(e.target.value);
          }}
          onBlur={commitExcluded}
          rows={3}
          spellCheck={false}
          placeholder={t("settings.ai.excludedPlaceholder")}
          style={MULTILINE_STYLE}
        />
        <p style={HELPER_STYLE}>{t("settings.ai.excludedHelper")}</p>
      </div>

      {/* Agent memory + personality (myne-md/myne#697): the settings half of
          the memory surface (the chat popover is the other). Absent, not
          disabled, when off (task 7, the mobile twin's posture): with AI off
          there is no run to learn from and no reserved gap. */}
      {aiEnabled ? (
        <MemorySection onShowToast={onShowToast ?? (() => {})} aiEnabled={aiEnabled} />
      ) : null}
    </div>
  );
}
