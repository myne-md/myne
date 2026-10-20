// Settings → AI panel (local-ai epic, ai-ux-surface MYND-408, task 4).
//
// The opt-in surface for AI on this client, and since myne-md/myne#885 it is
// organised as TOPICS rather than one scroll: `Answering` (the master switch, the
// trust card, the local runtime address, the remote provider with its key and
// model), `Models` (the per-role file assignment rows with the model catalogue,
// SYNC-1, myne-md/myne#805, myne-md/myne#867, and the side-load disclosure),
// `Tagging` (the `auto_tag_enabled` switch, MYND-651, together with the tag
// role's own model row), `Limits` (the `ai_excluded_folders` editor, SYNC-14, the
// same set encoding as deliberate_folders, and the chat history budget) and
// `Advanced` (the meeting prompt and the memory surface).
//
// **The catalogue is an inline table in `Models`, not a modal** (myne-md/myne#885,
// reversing myne-md/myne#867 task 2): the requester asked for the models to be
// listed the way the other model rows are listed, in a presentation cleaner than
// a stack of blocks, and the download icon that opened the modal went with it.
//
// **The grouping is the requester's own** ("her konunun model seçimini de kendi
// içine koyup" - each topic's model choice inside its own topic), which is what
// makes `Tagging` a topic rather than one switch filed under Models: the tag role
// is a real `ModelRole` with a real file to point at, and it belongs with the
// switch that uses it. The roster lives in `settingsTopics.ts`; the strip is
// rendered by `SettingsModal`, because it belongs in the content column's first
// row rather than inside the scrolling panel it divides.
//
// **The master switch and the trust card are the first things in `Answering`**
// (myne-md/myne#867). Whether AI runs at all is the panel's first question, and
// it used to be the fourth thing a reader met, with the provider and its key
// filed under a writing heading.
//
// Model acquisition is two paths now, and the distinction matters. A **download**
// is Myne fetching an artefact from its own origin on an explicit click, verified
// against a digest compiled into the binary (myne-md/myne#805), so it is no
// longer true that Myne never fetches a model. A **side-load** is the user
// bringing their own file, which the "Recommended models" links support by
// opening in the user's OWN browser via the opener plugin (an OS handoff, not a
// Myne fetch, the same affordance the About panel uses for the threat-model
// doc). Three roles: a Qwen2-family GGUF for generation (summaries / chat /
// writing), a Whisper GGUF for speech-to-text transcription (MYND-270), and a
// small Qwen2 GGUF for tag suggestions.
//
// Honesty discipline: the trust copy renders the `load-bearing-copy.ts`
// constants VERBATIM (never i18n'd, E2E-pinned by literal equality); it makes
// no absolute-privacy claim past the threat model (A7/A13 acknowledged).

import { consentIsDeviceScoped } from "@myne/copy";
import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
} from "react";
import { useTranslation } from "react-i18next";
import { open as openFileDialog } from "../../platform/dialog";
import {
  readAutoApplyTags,
  subscribeAutoApplyTags,
  writeAutoApplyTags,
} from "../../lib/autoApplyTags";
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
import { Icon } from "../primitives/Icon";
import type { IconName } from "../../lib/icons";
import { IconButton } from "../primitives/IconButton";
import { Button } from "../primitives/Button";
import { Select } from "../primitives/Select";
import { SearchableSelect } from "../primitives/SearchableSelect";
import {
  listFolderPaths,
  type FolderPathOption,
} from "../../notes/listFolderPaths";
import { AiProviderConsent } from "./AiProviderConsent";
import { Switch } from "../primitives/Switch";
import { CHAT_HISTORY_BUDGET_MAX } from "../../lib/agent-run";
import { SettingRow } from "./SettingRow";
import { SettingsTopicPanel } from "./SettingsTabs";
import { SettingsSection } from "./SettingsSection";
import { MemorySection } from "./MemorySection";
import {
  AiModelCatalogue,
  ACTION_CELL_STYLE as TABLE_ACTION_CELL_STYLE,
  HEADER_CELL_STYLE as TABLE_HEADER_CELL_STYLE,
  HEADER_ROW_STYLE as TABLE_HEADER_ROW_STYLE,
  ModelStateLabel,
  NAME_STYLE as TABLE_NAME_STYLE,
  ROW_COMPACT_STYLE as TABLE_ROW_COMPACT_STYLE,
  ROW_STYLE as TABLE_ROW_STYLE,
  STATE_CELL_STYLE as TABLE_STATE_CELL_STYLE,
  TABLE_STYLE,
} from "./AiModelCatalogue";
import { useSettingsCompact } from "./settingsCompact";
import { VISUALLY_HIDDEN } from "../primitives/visuallyHidden";
import { Tooltip } from "../primitives/Tooltip";
import { ModelPathButton, fileNameOf } from "./ModelPathButton";
import {
  BLOCK_STYLE,
  MULTILINE_STYLE,
  HELPER_STYLE,
  LABEL_STYLE,
  PANEL_ROOT_STYLE,
  TOGGLE_ROW_STYLE,
} from "./panel-styles";

/** The intent headings are gone: they are the topic tabs now (myne-md/myne#885).
 *
 *  myne-md/myne#848 gave these headings a rule and the panel's own label size so
 *  the four groups were recognisable while scrolling one flat list. This change
 *  goes further and removes the scroll itself: each group is a tab in the strip at
 *  the top of the panel, so the heading would only repeat the tab the user just
 *  clicked. The three private style constants that drew it
 *  (`GROUP_HEADING_STYLE`, `GROUP_HEADING_TEXT_STYLE`,
 *  `GROUP_HEADING_ROW_STYLE`) go with it rather than staying behind as dead
 *  tokens, which is also what leaves one section treatment in the tree instead of
 *  two - `SettingsSection` is the other, and the panels that still need an
 *  in-body group use that (task 1 of the same feature).
 */
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

/** The excluded-folders box, read as folder paths: one per line, trimmed, blanks
 *  dropped.
 *
 *  **One reading of the box, two callers** (myne-md/myne#848). The commit path
 *  and the picker's append path each spelled this same split/trim/filter out,
 *  which meant the picker's own "already in the list" test compared against a
 *  second opinion about what the list contained. */
function folderLines(text: string): string[] {
  return text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

/**
 * **What is answering, as a glyph** (myne-md/myne#848).
 *
 * The trust block's sentence already says where the notes go, and it is
 * load-bearing copy that must not be reworded. What it lacked was a form: three
 * plain paragraphs in the middle of a panel read as one more setting, and the
 * one question a user arrives at this panel with, "does anything of mine leave
 * this machine?", had no answer you could take in without reading.
 *
 * So the state picks the glyph AND the tint, and the three are the honest three:
 * on-device compute, a program on this computer, and the network. `cpu` is the
 * AI panel's own rail glyph and `globe` is what `cloud-off` is the negation of;
 * neither is a mood.
 */
function trustGlyph(kind: AiTrustState["kind"]): {
  icon: IconName;
  fg: string;
  bg: string;
} {
  switch (kind) {
    case "in-process":
      return { icon: "cpu", fg: "var(--success)", bg: "var(--success-soft)" };
    case "local-runtime":
      return { icon: "hard-drive", fg: "var(--info)", bg: "var(--info-soft)" };
    case "remote":
      return { icon: "globe", fg: "var(--warning)", bg: "var(--warning-soft)" };
  }
}

/** The banner's own box: the panel's recessed surface, with a rule. */
// The glyph FLOATS rather than sitting in a flex column (myne-md/myne#885 visual
// pass): in a two-column flex row every line of the copy started at the glyph's
// right edge, so a two-sentence banner carried a 28px-wide empty gutter down its
// whole height. Floated, the first line sits beside the glyph and the rest runs
// back under it. `flow-root` makes the banner contain the float.
const TRUST_BANNER_STYLE: CSSProperties = {
  display: "flow-root",
  padding: "var(--space-3)",
  background: "var(--paper-2)",
  border: "1px solid var(--line-1)",
  borderRadius: "var(--radius-2)",
  alignSelf: "stretch",
};

const TRUST_GLYPH_STYLE: CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  justifyContent: "center",
  float: "left",
  marginInlineEnd: "var(--space-3)",
  marginBottom: "var(--space-1)",
  width: 28,
  height: 28,
  borderRadius: "var(--radius-2)",
};

// A block, not a flex column: a flex container is its own formatting context and
// would refuse to flow around the floated glyph.
const TRUST_BODY_STYLE: CSSProperties = {
  display: "block",
  minWidth: 0,
};

const TRUST_LINE_STYLE: CSSProperties = {
  ...LABEL_STYLE,
  lineHeight: 1.5,
  margin: "0 0 var(--space-1)",
};

/**
 * One role in the hand-picked models table: which file the role uses, whether
 * one is chosen, and the two actions on it.
 *
 * **A table row, the same shape as the verified catalogue above it**
 * (myne-md/myne#867, on the user's read: "make the outsourced models a table
 * too"). It was a stack of label, link, sentence, file name and button per
 * role, four times over, which read as a form rather than a list of four
 * things in one of two states. The columns are the catalogue's own, imported
 * rather than copied, so the two tables line up and cannot drift apart.
 *
 * What each column holds: the ROLE, with the file requirement in the name's
 * tooltip (the catalogue puts the size there) and the recommended source as a
 * link under it; the STATE, the chosen file's NAME beside a check, or "No file
 * selected" beside a cross (the name, never the path, myne-md/myne#848); and the
 * actions, the folder reveal and the picker.
 */
function SideloadRow(props: {
  roleLabel: string;
  filesText: string;
  recommendName: string;
  onOpenRecommend: () => void;
  path: string | null;
  noneLabel: string;
  chooseLabel: string;
  onChoose: () => void;
  disabled: boolean;
  compact: boolean;
  testIdRecommend: string;
  testIdSelect: string;
  testIdChoose: string;
}) {
  const { t } = useTranslation();
  const filesId = useId();
  const roleId = useId();
  return (
    <div
      style={props.compact ? TABLE_ROW_COMPACT_STYLE : TABLE_ROW_STYLE}
      data-testid={`${props.testIdChoose}-row`}
    >
      <div style={{ display: "flex", flexDirection: "column", alignItems: "flex-start", gap: "var(--space-1)", minWidth: 0 }}>
        {/* Focusable, so the file requirement in the tooltip is reachable from
            the keyboard and not only by hover (myne-md/myne#867 review, D6). */}
        <Tooltip label={props.filesText}>
          <span id={roleId} tabIndex={0} style={TABLE_NAME_STYLE}>
            {props.roleLabel}
          </span>
        </Tooltip>
        <span id={filesId} style={VISUALLY_HIDDEN}>
          {props.filesText}
        </span>
        <button
          type="button"
          data-testid={props.testIdRecommend}
          onClick={props.onOpenRecommend}
          className="myne-text-link"
          style={{ ...LINK_STYLE, fontSize: "var(--text-xs)" }}
        >
          {props.recommendName}
          <span aria-hidden="true">↗</span>
        </button>
      </div>
      <div style={TABLE_STATE_CELL_STYLE}>
        <ModelStateLabel
          ok={props.path !== null}
          text={props.path === null ? props.noneLabel : fileNameOf(props.path)}
          testId={props.testIdSelect}
          describedBy={filesId}
        />
      </div>
      <div style={TABLE_ACTION_CELL_STYLE}>
        <ModelPathButton
          path={props.path}
          label={props.roleLabel}
          revealLabel={t("settings.ai.modelShowInFolder")}
          testId={`${props.testIdChoose}-location`}
          panelTestId={`${props.testIdChoose}-location-panel`}
        />
        {/* Four rows carry a "Choose file…" button, so each names the role
            it assigns through its description; without it a screen reader heard
            the same label four times with nothing tying it to its row
            (myne-md/myne#867 review, D6). */}
        <Button
          variant="secondary"
          data-testid={props.testIdChoose}
          aria-describedby={`${roleId} ${filesId}`}
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

export function AiPanel({ onShowToast, onDialogOpenChange }: AiPanelProps) {
  const { t } = useTranslation();
  const compact = useSettingsCompact();
  const {
    prefs,
    setAiEnabled,
    setAiExcludedFolders,
    setAutoTagEnabled,
    setChatHistoryBudget,
    setMeetingAiPrompt,
  } = usePrefs(onShowToast);
  // Local draft for the meeting-AI prompt textarea: it writes on blur rather
  // than on every keystroke, and resyncs when the stored value changes (a sync
  // from another device, or the Reset control).
  const [meetingPromptDraft, setMeetingPromptDraft] = useState("");
  useEffect(() => {
    setMeetingPromptDraft(prefs.meeting_ai_prompt ?? "");
  }, [prefs.meeting_ai_prompt]);

  const [disclosureOpen, setDisclosureOpen] = useState(false);
  const [modelPaths, setModelPaths] = useState<Record<ModelRole, string | null>>({
    generation: null,
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
  // **What the picker last added, so its trigger can show it** (myne-md/myne#885).
  // The control used to pass `selected={[]}` and therefore stayed on the
  // placeholder forever, which is the same class of defect as one that does not
  // look like its siblings. Local rather than stored: it is a readout of the
  // gesture, and the textarea below remains the authority on what is excluded.
  const [lastPickedFolder, setLastPickedFolder] = useState<string | null>(null);
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
  //
  // **Only the provider consent is a dialog now** (myne-md/myne#885): the model
  // catalogue left its `ModalShell` for an inline table, so there is no second
  // dialog to gate the shell's Esc on.
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
  // Device-local, not a pref (myne-md/myne#908): see `lib/autoApplyTags.ts` for
  // why automatic WRITING is a per-device permission while suggestions are
  // vault content.
  const [autoApply, setAutoApplyState] = useState<boolean>(() => readAutoApplyTags());
  const setAutoApplyTags = useCallback(
    (next: boolean) => {
      writeAutoApplyTags(next);
      setAutoApplyState(next);
    },
    [],
  );
  useEffect(() => subscribeAutoApplyTags(setAutoApplyState), []);

  // Read every role's persisted path from the host. Shared by the mount effect
  // and the download rows' `onChanged`, so a completed download updates the
  // installed state without remounting the panel (myne-md/myne#805).
  const reloadModelPaths = useCallback(() => {
    (["generation", "transcription", "tag"] as const).forEach((role) => {
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
    (["generation", "transcription", "tag"] as const).forEach((role) => {
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

  const commitExcluded = (text: string = excludedDraft) => {
    const folders = folderLines(text);
    void setAiExcludedFolders(mutationFrom(excludedSeedRef.current, folders), folders);
    excludedSeedRef.current = folders;
    // The draft now IS the seed, so a later prefs change may re-seed again.
    excludedTouchedRef.current = false;
  };

  // **A picker, because a path typed by hand is a path that does not match.**
  // The box below is the authority and stays (a user may paste a list, and an
  // exclusion is a privacy control that must not require a picker to work);
  // this only makes the common case typo-free, by appending the picked prefix to
  // the draft and committing it (myne-md/myne#848).
  const [folderPaths, setFolderPaths] = useState<FolderPathOption[]>([]);
  useEffect(() => {
    let live = true;
    void listFolderPaths()
      .then((paths) => {
        if (live) setFolderPaths(paths);
      })
      .catch(() => {
        // A vault whose folders cannot be listed leaves the picker out and the
        // box exactly as it was: the typed path is the authority, so a failed
        // convenience must not take the control away.
      });
    return () => {
      live = false;
    };
  }, []);

  const appendExcludedFolder = (picked: string): void => {
    if (picked.trim().length === 0) return;
    // Before the duplicate check: the trigger reports the GESTURE, and a folder
    // that was already excluded still reads as the one you just picked. The box
    // already holds it, so the two agree.
    setLastPickedFolder(picked);
    const lines = folderLines(excludedDraft);
    if (lines.includes(picked)) return; // already excluded: not a no-op to say so twice
    const next = [...lines, picked].join("\n");
    excludedTouchedRef.current = true;
    setExcludedDraft(next);
    commitExcluded(next);
  };

  const excludedFolderOptions = useMemo(
    () => folderPaths.map((f) => ({ value: f.path, label: f.label })),
    [folderPaths],
  );

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

  // Built once: the Advanced topic places it in the Preferences section in
  // both branches (with AI on, beside the voice preferences; with AI off, alone).
  // Meeting AI prompt (meeting-ai): the user's replacement for the meeting AI
  // pass's reduce instruction. Empty means the built-in default.
  const meetingPrompt = (
    // **A setting row whose control is the reset** (myne-md/myne#867, on the
    // user's read: "the save and reset buttons look nothing alike; make them
    // setting rows with icons"). The reset was a full-width text button under
    // the field and the voice preferences' save a centred link-styled one; both
    // are now a square bordered icon on the row's right, where every other
    // row's control sits, and the field is the row's full-width content.
    <SettingRow
      anchorId="ai.meeting-prompt"
      testId="ai.meeting-prompt"
      label={t("settings.ai.meetingPromptLabel")}
      helper={t("settings.ai.meetingPromptHelper")}
      control={
        <IconButton
          icon="rotate-ccw"
          label={t("settings.ai.meetingPromptReset")}
          tooltip
          bordered
          disabled={!aiEnabled}
          testId="ai.meeting-prompt-reset"
          onClick={() => {
            setMeetingPromptDraft("");
            void setMeetingAiPrompt(null);
          }}
        />
      }
    >
      <textarea
        value={meetingPromptDraft}
        onChange={(e) => setMeetingPromptDraft(e.target.value)}
        onBlur={() => {
          const trimmed = meetingPromptDraft.trim();
          void setMeetingAiPrompt(trimmed === "" ? null : meetingPromptDraft);
        }}
        disabled={!aiEnabled}
        aria-label={t("settings.ai.meetingPromptLabel")}
        data-testid="ai.meeting-prompt-input"
        // **`MULTILINE_STYLE`, which exists for exactly this**
        // (myne-md/myne#848). An unstyled `<textarea>` falls back to the
        // WebView's own white field, so this one was a white box on a dark
        // panel, the only control in the panel that did not come from the
        // tokens.
        style={MULTILINE_STYLE}
        rows={4}
      />
    </SettingRow>
  );

  return (
    <div data-testid="settings.ai-panel" style={PANEL_ROOT_STYLE}>
      {/* No panel title (myne-md/myne#885 visual pass): the rail already names
          the panel and the topic strip sits directly above, so an "AI" heading
          here was a third label for one place, and no other panel carries one. */}

      {/* **Answering**: who or what answers, and what it is allowed to send.
          This is the panel's first topic, and the master switch plus the trust
          card lead it rather than sitting above every group heading: whether AI
          runs at all is the panel's first question (myne-md/myne#867).

          **Each topic's body is wrapped at the SAME indentation on purpose.** A
          wrapper that indented its 400 lines would turn a change about where the
          groups begin into a whitespace diff nobody can read, and what a reviewer
          has to check here is exactly which rows landed in which topic. */}
      <SettingsTopicPanel panelId="ai" topicId="answering">
      {/* Trust affordance, load-bearing copy, rendered verbatim (SYNC-16 /
          SYNC-7). One INVARIANT sentence, always shown, plus one STATE
          sentence selected by which backend is answering: a provider IS a
          server, so the old flat "runs entirely on your device" claim is false
          the moment one is named (`decisions.md` 2026-08-09). */}
      <div style={TRUST_BANNER_STYLE} data-testid="ai.trust-banner">
        {/* Decorative: the headline beside it says the same thing in words, and
            a screen reader announcing a glyph would only repeat it. */}
        <span
          aria-hidden="true"
          data-testid="ai.trust-glyph"
          // Both, because they answer different questions: `data-state` is
          // which state the panel derived, `data-icon` is which glyph it chose
          // for it. Asserting only the first would pass on a mapping that
          // painted one glyph for all three (myne-md/myne#848).
          data-state={trustState.kind}
          data-icon={trustGlyph(trustState.kind).icon}
          style={{
            ...TRUST_GLYPH_STYLE,
            background: trustGlyph(trustState.kind).bg,
            color: trustGlyph(trustState.kind).fg,
          }}
        >
          <Icon name={trustGlyph(trustState.kind).icon} size={16} />
        </span>
        <div style={TRUST_BODY_STYLE}>
        <p data-testid="ai.trust-invariant" style={TRUST_LINE_STYLE}>
          {AI_TRUST_INVARIANT}
        </p>
        <p data-testid="ai.trust-headline" style={TRUST_LINE_STYLE}>
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
            display: "block",
          }}
        >
          {t("settings.ai.disclosureToggle")}
        </button>
        {disclosureOpen && (
          <p data-testid="ai.trust-disclosure" style={{ ...HELPER_STYLE, lineHeight: 1.5, marginTop: "var(--space-1)" }}>
            {aiTrustDisclosure(trustState)}
          </p>
        )}
        {/* What is answering RIGHT NOW (#191 task 5, SYNC-13). A read-only
            caption, deliberately NOT a `SettingRow`: a caption adds no setting,
            and a setting would owe a `settingsSearchIndex.ts` entry plus a
            control the user could operate, which SYNC-19 removed from scope.
            It sits in the trust block because it is the same question that
            block answers, one level more concrete. */}
        <p data-testid="ai.active-provider" style={{ ...HELPER_STYLE, lineHeight: 1.5, marginTop: "var(--space-1)" }}>
          {activeProviderName === undefined
            ? t("settings.ai.providerNothingAnswering")
            : t("settings.ai.providerActive", { name: activeProviderName })}
        </p>
        </div>
      </div>

      {/* Opt-in toggle, BELOW the trust banner (myne-md/myne#885 visual pass):
          the banner says what turning AI on means, so it is read before the
          switch rather than after it. */}
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

      {/* **Choose the provider first, then see only what it needs**
          (myne-md/myne#867, on the user's read: "after the switch I pick the
          provider, local model or remote, and then I see the settings for what
          I picked"). One dropdown answers "where does an answer come from":
          the first option is this device, every other option is a named
          service. The local runtime address is shown only while no service is
          named, and the key and model rows only while one is. A stored local
          address is kept, not cleared, when a service is chosen: the host's
          backend resolution decides what answers, and the trust card above
          reads the union, so hiding the field changes no behaviour.

          Remote provider (ai-remote-providers myne#415 task 14, SYNC-13/18).
          The alternative to a local runtime, and in the panel's shipped
          conventions rather than a new visual language.

          Four things here are deliberate:
          1. `none` is the DEFAULT and the unreachable state, not a disabled
             one: with nothing selected there is no remote path to reach.
          2. The key field NEVER renders a stored value. It cannot: the field
             is serde-skipped out of `prefs_read`, so the panel reads a boolean
             and shows "Add" or "Replace".
          3. First-time selection routes through the consent dialog BEFORE
             anything is stored. Storing first would make the dialog a
             notification. The segmented control shows the pending choice while
             the dialog is up (a control that does not move when clicked reads
             as broken), but that highlight is the only thing that happened:
             cancelling reverts it and no write occurred.
          4. Rotate does not re-ask consent (the recipient is unchanged);
             clearing the provider revokes the key AND the consent, so "turn
             this off" leaves the state of "never turned it on". */}
      <SettingRow
        anchorId="ai.provider"
        testId="ai.provider-section"
        label={t("settings.ai.providerChooseLabel")}
        // The one sentence that is not optional on a trust surface: naming a
        // service sends note text off this device. The rest of the paragraph is
        // behind the question mark beside the label, unchanged.
        helper={t("settings.ai.providerInline")}
        explanation={[t("settings.ai.providerChooseHelper")]}
        control={(helperId, explanationId) => (
          <Select
            options={[
              { value: "none", label: t("settings.ai.providerOnDevice") },
              ...REMOTE_PROVIDERS.map((p) => ({
                value: p.wire,
                label: p.label,
              })),
            ]}
            value={pendingProvider ?? prefs.ai_provider ?? "none"}
            onChange={(v) => chooseProvider(v === "none" ? null : v)}
            aria-label={t("settings.ai.providerChooseLabel")}
            ariaDescribedBy={explanationId ?? helperId}
            testId="ai.provider-choice"
          />
        )}
      >
        <AiProviderConsent
          open={pendingProvider !== null}
          providerLabel={providerLabel(pendingProvider)}
          onAccept={() => void acceptConsent()}
          onCancel={() => setPendingProvider(null)}
        />
      </SettingRow>

      {prefs.ai_provider === null && (
        <>
      {/* Local model runtime (ai-ollama-local task 8, SYNC-17/SYNC-18).

          The alternative to side-loading a file: point Myne at a runtime the
          user already runs on this machine. Three things about this block are
          deliberate and should not be "tidied" away:

          1. The field ships EMPTY. The conventional address is placeholder text
             only: a stored default would be Myne naming an endpoint the user
             did not (`decisions.md` 2026-08-09 default-state invariant).
          2. The disclosure is GENERIC. It says the runtime is a separate
             program with its own network behaviour, and NOT what that program
             fetches or when: a version-specific claim would rot into a false
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

        </>
      )}

      {prefs.ai_provider !== null && (
        <div
          style={BLOCK_STYLE}
          data-testid="ai.provider-remote-section"
        >
            <label
              style={{ ...LABEL_STYLE, marginTop: "var(--space-2)" }}
              htmlFor="ai-provider-key"
            >
              {t("settings.ai.providerKeyLabel")}
            </label>
            {/* **Saving a credential is an act, not a side effect of moving
                on** (myne-md/myne#867). The field used to commit on BLUR, so
                pasting a key and tabbing away stored it, a write the user
                never confirmed, on the one control in this panel whose value
                they can neither see nor correct from here. The confirm is a
                control beside the field, and it is DISABLED while the field is
                empty, because an empty confirm writes an empty string and the
                host reads that as "no key": pressing it would erase the stored
                credential rather than save one.

                Enter still commits. It is the same act with the keyboard, and
                the E2E lane already drives it that way. */}
            <div
              style={{
                ...TOGGLE_ROW_STYLE,
                marginTop: "var(--space-1)",
                gap: "var(--space-2)",
              }}
            >
              <div style={{ flex: 1, minWidth: 0 }}>
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
                  onKeyDown={(e) => {
                    if (e.key === "Enter") {
                      e.preventDefault();
                      void commitKey();
                    }
                  }}
                />
              </div>
              <IconButton
                icon="circle-check"
                label={t("settings.ai.providerKeySave")}
                tooltip
                disabled={!aiEnabled || keyDraft.trim().length === 0}
                testId="ai.provider-key-save"
                onClick={() => void commitKey()}
              />
              {/* The clear is an ICON beside the field rather than a sentence
                  under it, for the same reason the confirm is: both act on the
                  ONE value in that field, and a link further down the panel
                  reads as a different subject (myne-md/myne#867). */}
              {hasKey ? (
                <IconButton
                  icon="trash-2"
                  label={t("settings.ai.providerKeyRevoke")}
                  tooltip
                  disabled={!aiEnabled}
                  testId="ai.provider-key-revoke"
                  onClick={() => void revokeKey()}
                />
              ) : null}
            </div>
            <p data-testid="ai.provider-key-state" style={HELPER_STYLE}>
              {hasKey
                ? t("settings.ai.providerKeyStored")
                : t("settings.ai.providerKeyNone")}
            </p>

            {/* The model chooser (SYNC-24), as a setting row: the chosen model
                sits on the right where every other row's value sits, with the
                load action beside it as a square icon button
                (myne-md/myne#867, on the user's read). Gated on a stored key
                because there is nothing to ask the provider WITH before then:
                a disabled control with a real label, never "coming soon"
                (src/AGENTS.md disabled-control discipline).

                Before the list is loaded the dropdown is DISABLED and shows the
                stored model, so the row states the current choice; loading the
                list is what makes it selectable. The disabled stand-in carries
                its own testid, so "no list yet" and "the list" stay two states a
                scenario can tell apart. */}
            <SettingRow
              label={t("settings.ai.providerModelLabel")}
              helper={t("settings.ai.providerModelHelper")}
              testId="ai.provider-model-row"
              control={
                <div style={{ display: "flex", alignItems: "center", gap: "var(--space-2)" }}>
                  {visibleModels !== null && modelOptions.length > 1 ? (
                    // SearchableSelect, not Select: a provider catalogue runs to
                    // hundreds of entries, which is past where a plain dropdown
                    // is usable (docs/design/README.md "The setting row",
                    // decisions.md 2026-08-01). The synthetic "" option stays:
                    // the primitive's `placeholder` DISPLAYS an empty selection
                    // but offers no way to return to one, and letting a user put
                    // a model back is existing behaviour.
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
                    <SearchableSelect
                      options={
                        prefs.ai_provider_model === null
                          ? []
                          : [
                              {
                                value: prefs.ai_provider_model,
                                label: prefs.ai_provider_model,
                              },
                            ]
                      }
                      selected={
                        prefs.ai_provider_model === null
                          ? []
                          : [prefs.ai_provider_model]
                      }
                      onChange={() => {}}
                      disabled
                      aria-label={t("settings.ai.providerModelLabel")}
                      placeholder={t("settings.ai.providerModelNone")}
                      testId="ai.provider-model-current"
                    />
                  )}
                  <IconButton
                    icon="refresh-cw"
                    label={t("settings.ai.providerModelLoad")}
                    tooltip
                    bordered
                    disabled={!aiEnabled || !hasKey || modelsLoading}
                    testId="ai.provider-model-load"
                    onClick={() => void loadModels()}
                  />
                </div>
              }
            >
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
            {/* Only offered when the filter is actually withholding
                something: a link that always says "show all" while there is
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
            </SettingRow>
        </div>
      )}

      </SettingsTopicPanel>

      {/* **Models**: which file each role uses, and where those files come from.
          One assignment row per role EXCEPT the tag role, which has its own topic
          with the switch that uses it (myne-md/myne#885). Recommended links open
          in the user's browser; the pickers take files the user already has.
          Fetching one from Myne's own origin is the catalogue TABLE above, listed
          inline since myne-md/myne#885. */}
      <SettingsTopicPanel panelId="ai" topicId="models">
      {/* **Tagging**, folded into Models (myne-md/myne#867, on the user's read:
          "put tagging inside models"). It was a topic of its own holding one
          switch and one model row; the model row is now the tag line of the
          table below, and the switch is this section, FIRST in the topic
          (on the user's read: "move tagging to the top of Models"): it is the
          one control here that turns a feature on, so it leads, and the two
          tables of files follow. */}
      <SettingsSection title={t("settings.ai.groupTagging")}>
      {/* Auto-tag (MYND-651). It is a role like the other three, with a file
          you can point at and a catalogue entry you can fetch, and since
          myne-md/myne#867 it has an assignment row of its own instead of being
          reachable only by downloading it. Disabled (not hidden) while the beta
          is off, matching every other dependent control in this panel; the host
          re-reads both flags before it loads a model, so this surface is
          discovery, not enforcement.

          It is ALSO disabled when the build ships no tag model, with the reason
          spelled out, the disabled-control discipline in `src/AGENTS.md`: a
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

      {/* Automatic writing, subordinate to the switch above (myne-md/myne#908).
          Two things this row says without prose: it is disabled until
          suggestions are on (there is nothing to apply otherwise), and it is
          DEVICE-LOCAL, so its helper names that instead of implying it follows
          the vault. */}
      <SettingRow
        anchorId="ai.auto-apply-tags"
        label={t("settings.ai.autoApplyLabel")}
        helper={t("settings.ai.autoApplyHelper")}
        control={(helperId) => (
          <Switch
            checked={autoApply}
            disabled={!aiEnabled || !autoTag || tagModel === false}
            onChange={setAutoApplyTags}
            ariaLabel={t("settings.ai.autoApplyLabel")}
            ariaDescribedBy={helperId}
            testId="ai.auto-apply-tags-toggle"
          />
        )}
      />
      </SettingsSection>

      {/* The catalogue is its own section (myne-md/myne#885): fetching a file
          from Myne's own origin is a different concern from pointing at one you
          already have, and the seam is what separates them. The assignment rows
          below keep their own labelled block, which is where each role's file
          is chosen.

          **The list is inline, not a modal** (myne-md/myne#885, reversing
          myne-md/myne#867 task 2). It used to be opened by a download icon at the
          right of this heading; the icon and the modal are gone, and the table
          renders here with the assignment rows. `AiModelCatalogue` owns the
          `ai.downloads` anchor, which is where the settings search's entry
          already pointed. */}
      <SettingsSection title={t("settings.ai.sections.catalogue")}>
      <AiModelCatalogue
        modelPaths={modelPaths}
        aiEnabled={aiEnabled}
        onChanged={reloadModelPaths}
        {...(onShowToast === undefined ? {} : { onShowToast })}
      />
      </SettingsSection>

      {/* Roles: text (GGUF), speech-to-text (Whisper GGUF) and tagging (GGUF).

          Its own section, titled for what it is (myne-md/myne#885 visual pass):
          the files a role uses when they come from somewhere other than the
          verified catalogue above. A TABLE since myne-md/myne#867, in the
          catalogue's own columns, so the two lists read as one kind of thing
          and their state columns line up. */}
      <SettingsSection title={t("settings.ai.sections.outsourced")}>
      <div
        style={BLOCK_STYLE}
        data-setting-anchor="ai.models"
        data-setting-row="true"
        data-testid="ai.models-section"
      >
        <p style={HELPER_STYLE}>{t("settings.ai.modelsHelper")}</p>
        <div style={compact ? { display: "flex", flexDirection: "column" } : TABLE_STYLE}>
          {!compact && (
            <div style={TABLE_HEADER_ROW_STYLE} aria-hidden="true">
              <span style={TABLE_HEADER_CELL_STYLE}>{t("settings.ai.catalogueColModel")}</span>
              <span style={TABLE_HEADER_CELL_STYLE}>{t("settings.ai.catalogueColState")}</span>
              <span />
            </div>
          )}
          <SideloadRow
            roleLabel={t("settings.ai.modelGenerationLabel")}
            filesText={t("settings.ai.recommendedFilesGeneration")}
            recommendName={RECOMMENDED_MODEL.generation.name}
            onOpenRecommend={() => openRecommend("generation")}
            path={modelPaths.generation}
            noneLabel={t("settings.ai.modelNone")}
            chooseLabel={t("settings.ai.modelChoose")}
            onChoose={() => void chooseModel("generation")}
            disabled={!aiEnabled}
            compact={compact}
            testIdRecommend="ai.model-recommend-generation"
            testIdSelect="ai.model-select"
            testIdChoose="ai.model-choose"
          />
          {/* Speech-to-text (voice-to-text MYND-552, SYNC-V3): the ASR / Whisper
              role (side-load only, disabled when AI is off, distinct testids). */}
          <SideloadRow
            roleLabel={t("settings.ai.modelTranscriptionLabel")}
            filesText={t("settings.ai.recommendedFilesTranscription")}
            recommendName={RECOMMENDED_MODEL.transcription.name}
            onOpenRecommend={() => openRecommend("transcription")}
            path={modelPaths.transcription}
            noneLabel={t("settings.ai.modelNone")}
            chooseLabel={t("settings.ai.modelChoose")}
            onChoose={() => void chooseModel("transcription")}
            disabled={!aiEnabled}
            compact={compact}
            testIdRecommend="ai.model-recommend-transcription"
            testIdSelect="ai.model-select-transcription"
            testIdChoose="ai.model-choose-transcription"
          />
          {/* The tag role. The SAME file requirement as the generation row,
              and therefore the same key: both roles take a Qwen2 GGUF beside a
              tokenizer.json, and a second key holding the identical sentence is
              the duplication `scripts/check-i18n-duplicates.mjs` refuses. It
              joined this table when the Tagging topic folded into Models
              (myne-md/myne#867): a fourth role is a fourth row, not a topic. */}
          <SideloadRow
            roleLabel={t("settings.ai.downloadTagLabel")}
            filesText={t("settings.ai.recommendedFilesGeneration")}
            recommendName={RECOMMENDED_MODEL.tag.name}
            onOpenRecommend={() => openRecommend("tag")}
            path={modelPaths.tag}
            noneLabel={t("settings.ai.modelNone")}
            chooseLabel={t("settings.ai.modelChoose")}
            onChoose={() => void chooseModel("tag")}
            disabled={!aiEnabled}
            compact={compact}
            testIdRecommend="ai.model-recommend-tag"
            testIdSelect="ai.model-select-tag"
            testIdChoose="ai.model-choose-tag"
          />
        </div>
      </div>
      </SettingsSection>

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
      </SettingsTopicPanel>

      {/* **Limits**: what the AI may not see, and the bounds on what an answer
          may cost. */}
      <SettingsTopicPanel panelId="ai" topicId="limits">
      {/* Two sections (myne-md/myne#885): what the AI may read, and what a
          request may carry. They are one topic because both are bounds, and two
          sections because they bound different things. */}
      <SettingsSection title={t("settings.ai.sections.excluded")}>
      {/* Excluded folders, same canonical set encoding as deliberate_folders.
          **A `SettingRow` since myne-md/myne#885**, which is the whole of both
          halves of the requester's report: the picker used to be a bare child of
          a column flex, so it was the one dropdown in the dialog that stretched
          to the full content width, and it sat on its own line under the label.
          In the row's control slot it takes the shared `.myne-select-*` chrome,
          its own 320px width bound and the far-right position every other
          dropdown in the dialog has, on the `Excluded folders` label's own line.

          The textarea stays BELOW the row at full width, which the canon's
          setting-row rule already describes for a second control under a row. It
          carries its own `aria-label` because `SettingRow` renders its label as a
          `span` rather than a `label htmlFor`, so the `id` here binds to nothing
          and the field would be announced unnamed (the same reason every other
          `SettingRow`-hosted control supplies its own name). */}
      <SettingRow
        anchorId="ai.excluded-folders"
        label={t("settings.ai.excludedLabel")}
        control={
          excludedFolderOptions.length > 0 ? (
            <SearchableSelect
              testId="ai.excluded-folders-picker"
              aria-label={t("settings.ai.excludedPickLabel")}
              options={excludedFolderOptions}
              // **The last pick, so the trigger is not stuck on the placeholder**
              // (myne-md/myne#885). It passed `selected={[]}`, so a picker that
              // had just added a folder still read "Pick a folder…", which is the
              // same class of defect as one that does not look like its siblings.
              selected={lastPickedFolder === null ? [] : [lastPickedFolder]}
              placeholder={t("settings.ai.excludedPickPlaceholder")}
              onChange={(next) => appendExcludedFolder(next[0] ?? "")}
            />
          ) : null
        }
      >
        <textarea
          id="ai-excluded-folders"
          data-testid="ai.excluded-folders"
          aria-label={t("settings.ai.excludedLabel")}
          value={excludedDraft}
          disabled={!aiEnabled}
          onChange={(e) => {
            excludedTouchedRef.current = true;
            setExcludedDraft(e.target.value);
          }}
          onBlur={() => commitExcluded()}
          rows={3}
          spellCheck={false}
          placeholder={t("settings.ai.excludedPlaceholder")}
          style={MULTILINE_STYLE}
        />
        <p style={HELPER_STYLE}>{t("settings.ai.excludedHelper")}</p>
      </SettingRow>
      </SettingsSection>

      <SettingsSection title={t("settings.ai.sections.history")}>
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
          the pre-#617 behaviour and a legitimate thing to want.

          It is a LIMIT rather than an Advanced knob (myne-md/myne#885): it
          bounds what an answer may cost, which is the question this topic asks,
          so it sits with the excluded folders rather than one topic away. */}
      <SettingRow
        anchorId="ai.history-budget"
        testId="ai.history-budget"
        label={t("settings.ai.historyBudgetLabel")}
        // The critical sentence, then the whole paragraph behind the question
        // mark (myne-md/myne#885). The moved paragraph is unchanged, and it is
        // the one that says how much MORE of the user's text a larger number
        // sends off the device.
        helper={t("settings.ai.historyBudgetInline")}
        explanation={[t("settings.ai.historyBudgetHelper")]}
        control={(helperId, explanationId) => (
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
            aria-describedby={
              explanationId === undefined
                ? helperId
                : `${helperId} ${explanationId}`
            }
            data-testid="ai.history-budget-input"
            style={{ width: "8ch" }}
          />
        )}
      />
      </SettingsSection>
      </SettingsTopicPanel>

      {/* **Advanced**: the knobs a user reaches for once the rest works: the
          meeting summary prompt and the memory surface, neither of which is a
          boundary on what AI may do (myne-md/myne#885). */}
      <SettingsTopicPanel panelId="ai" topicId="advanced">
      {/* **Two sections** (myne-md/myne#867, on the user's read: "Preferences,
          with the meeting prompt and the voice preferences, and Memory, with
          what the assistant remembers"). Both preferences are standing
          instructions the user writes for the model; memory is what the model
          wrote itself. The voice preferences live in `MemorySection` because
          they share its load, so its `layout` places that half here.

          Memory is absent, not disabled, while AI is off (task 7, the mobile
          twin's posture): with AI off there is no run to learn from and no
          reserved gap. The voice preferences go with it, as they always did. */}
      {aiEnabled ? (
        <MemorySection
          onShowToast={onShowToast ?? (() => {})}
          aiEnabled={aiEnabled}
          layout={({ memory, personality }) => (
            <>
              <SettingsSection title={t("settings.ai.sections.preferences")}>
                {meetingPrompt}
                {personality}
              </SettingsSection>
              <SettingsSection title={t("settings.ai.sections.memory")}>
                {memory}
              </SettingsSection>
            </>
          )}
        />
      ) : (
        <SettingsSection title={t("settings.ai.sections.preferences")}>
          {meetingPrompt}
        </SettingsSection>
      )}
      </SettingsTopicPanel>
    </div>
  );
}
