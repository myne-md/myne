// The model catalogue: every artefact Myne's own origin can serve, whether or
// not it is installed (myne-md/myne#867, inlined as a table by myne-md/myne#885).
//
// ── Why this is an inline table and not a modal ─────────────────────────────
// myne-md/myne#867 task 2 put this list behind a download icon at the right of
// the `Models` heading, inside a `ModalShell`. The requester's own report was
// that the modal's padding was wrong AND that the models should be listed the
// way the other model rows are listed, in a presentation that reads more cleanly
// than a stack of blocks. So the list renders inline in the `Models` topic (the
// icon and the modal are gone) and it is a TABLE: one header row naming the
// columns, one row per artefact carrying the same cells, so two artefacts are
// scannable side by side instead of read as two paragraphs.
//
// The row shape is the one the attachments library's list view already draws
// (`AttachmentsLibrary.tsx`'s `LIST_ROW_STYLE`: a CSS grid, an uppercase
// `--fg-3` header row, a `--line-1` hairline under every row), which is why this
// composes a grid rather than inventing a second table idiom. There is no
// `Table` primitive in `src/components/primitives/`; a two-row list does not earn
// one, and the guard `scripts/check-primitive-adoption.mjs` counts raw
// interactive elements rather than layout containers, so the grid is a layout
// choice rather than a bypass.
//
// The header row is `aria-hidden`: it is a visual aid, and without table
// semantics on the rows it would be read out of context as "Model Size State".
// Each row's own text is self-describing.
//
// ── What a row guarantees ───────────────────────────────────────────────────
// The roster is compiled in (`DownloadArtifactId`), and nothing here constructs
// a URL or a digest: the host owns both, verifies every file against a SHA-256
// baked into the binary, and only then registers it in the device-local model
// store. `ai-model-download.ts` is the whole TS surface.
//
// Rows render whether or not the artefact is installed, which is the point: a
// catalogue that lists only what you already have cannot answer "what can I
// get". An installed row offers Remove and nothing else, because a Download
// button beside an installed model reads as "this is not installed" on the very
// row whose job is to say that it is (myne-md/myne#848).
//
// ── Where the download state lives ──────────────────────────────────────────
// `ai-download-store.ts` is module scope precisely so a transfer survives this
// component unmounting, which is what makes it survive a TOPIC change: the panel
// mounts only the active topic's body, so switching away unmounts this table and
// switching back remounts it with the transfer still in flight (myne-md/myne#814,
// myne-md/myne#885).

import { useEffect, useId, useRef, useState, type CSSProperties } from "react";
import { useTranslation } from "react-i18next";

import { removeModel, type DownloadArtifactId } from "../../lib/ai-model-download";
import {
  cancelModelDownloadFor,
  startModelDownload,
  useModelDownload,
} from "../../lib/ai-download-store";
import { Button } from "../primitives/Button";
import { Icon } from "../primitives/Icon";
import { Tooltip } from "../primitives/Tooltip";
import { VISUALLY_HIDDEN } from "../primitives/visuallyHidden";
import { ModelPathButton } from "./ModelPathButton";
import { ERROR_STYLE, HELPER_STYLE } from "./panel-styles";
import { useSettingsCompact } from "./settingsCompact";

interface ModelArtifact {
  /** The model-store role this artefact registers. Remove acts on the role. */
  role: string;
  labelKey: string;
  sizeKey: string;
}

/**
 * What the origin serves, in the order the catalogue lists it.
 *
 * A local roster rather than a host query, because the host has no "list the
 * artefacts" command and adding one would cost a capability row, a web
 * capability classification and a caller check for a list the client already
 * has.
 *
 * **Keyed by the union, and that is the whole guarantee** (myne-md/myne#867
 * review). The array this replaced was typed `{ id: DownloadArtifactId; … }[]`,
 * which the compiler reads as "every id here is a member of the union" and NOT
 * as "every member of the union is here": a third artefact added to the union
 * compiled, shipped, and simply never appeared in the catalogue, while the
 * comment above it claimed the compiler would find it. A `Record` keyed by the
 * union fails to BUILD the day the union grows.
 *
 * `MODEL_ARTIFACTS` below is derived rather than restated, so the list order is
 * the record's own key order (`Object.keys` is insertion order for these
 * non-integer keys) and there is no second place to fall behind.
 */
const MODEL_ARTIFACT_ROWS: Record<DownloadArtifactId, ModelArtifact> = {
  "embedding-e5-small": {
    role: "embedding",
    labelKey: "settings.ai.modelEmbeddingLabel",
    sizeKey: "settings.ai.downloadEmbeddingSize",
  },
  tag: {
    role: "tag",
    labelKey: "settings.ai.downloadTagLabel",
    sizeKey: "settings.ai.downloadTagSize",
  },
};

const MODEL_ARTIFACTS: readonly (ModelArtifact & { id: DownloadArtifactId })[] = (
  Object.keys(MODEL_ARTIFACT_ROWS) as DownloadArtifactId[]
).map((id) => ({ id, ...MODEL_ARTIFACT_ROWS[id] }));

const CATALOGUE_STYLE: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: "var(--space-2)",
};

/**
 * The three columns, on every row including the header: model, state, action.
 *
 * The size used to be a column of its own and it was the widest cell in the
 * row, so the table read as a sentence column with a name squeezed beside it
 * (myne-md/myne#885 visual pass). It is the NAME's detail, so it rides the name's
 * tooltip, and the name's dotted underline says the tooltip is there.
 *
 * `minmax(0, …)` rather than a bare `1fr`: a grid item's default `min-width:
 * auto` refuses to shrink below its longest word, so a long label would push the
 * action column past the panel's right edge in the longer locales. The action
 * column never shrinks below its content, because it is a control and must
 * never be squeezed, but it is also a `1fr` share rather than `auto`: the
 * Models topic draws TWO tables in these columns, and an `auto` track sized by
 * each table's own buttons ("Download" in one, "Choose file…" in the other)
 * put the two STATE columns at different offsets (myne-md/myne#867).
 */
export const COLUMNS = "minmax(0, 2fr) minmax(0, 1fr) minmax(max-content, 1fr)";

/**
 * **ONE grid for the whole table, and every row a subgrid of it**
 * (myne-md/myne#867, on the user's read: "this table is crooked"). Each row used
 * to be its own grid with these same three tracks, and the `auto` action track
 * is sized by its OWN row's content: "Remove" plus the folder button on one row,
 * "Download" on another, nothing at all in the header. So the two `fr` tracks
 * split a different remainder on every row, and the STATE heading sat a
 * different distance from the left than the states under it. A subgrid shares
 * the parent's tracks, so the widest action in the table sizes that column for
 * every row, the header included.
 */
export const TABLE_STYLE: CSSProperties = {
  display: "grid",
  gridTemplateColumns: COLUMNS,
  columnGap: "var(--space-3)",
  minWidth: 0,
};

export const ROW_STYLE: CSSProperties = {
  display: "grid",
  gridColumn: "1 / -1",
  gridTemplateColumns: "subgrid",
  alignItems: "center",
  padding: "var(--space-2) 0",
  borderBottom: "1px solid var(--line-1)",
  minWidth: 0,
};

/** The narrow-dialog restack, the same flip `SettingRow` makes (#391): below the
 *  compact threshold the four columns become a column of lines rather than four
 *  crushed cells. The header row is dropped with it, because it names columns
 *  that are no longer side by side. */
export const ROW_COMPACT_STYLE: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  alignItems: "flex-start",
  gap: "var(--space-1)",
  padding: "var(--space-2) 0",
  borderBottom: "1px solid var(--line-1)",
};

export const HEADER_ROW_STYLE: CSSProperties = {
  ...ROW_STYLE,
  padding: "var(--space-1) 0",
  borderBottom: "1px solid var(--line-2)",
};

export const HEADER_CELL_STYLE: CSSProperties = {
  fontFamily: "var(--font-sans)",
  fontSize: "var(--text-xs)",
  fontWeight: "var(--weight-semibold)" as CSSProperties["fontWeight"],
  letterSpacing: "0.04em",
  textTransform: "uppercase",
  color: "var(--fg-3)",
};

/** A flex box rather than a bare inline span (myne-md/myne#867): as an inline
 *  formatting context it held the tooltip's wrapper on a line box with room
 *  reserved for descenders under it, so the name sat a few pixels ABOVE the
 *  state and the actions it shares a row with. */
export const NAME_CELL_STYLE: CSSProperties = {
  display: "flex",
  alignItems: "center",
  minWidth: 0,
};

// The dotted underline is the affordance that the name has a tooltip, the
// convention an `<abbr>` carries: a reader who never hovers loses nothing, since
// the size also reaches assistive technology through `aria-describedby`.
export const NAME_STYLE: CSSProperties = {
  fontSize: "var(--text-base)",
  fontWeight: "var(--weight-medium)" as CSSProperties["fontWeight"],
  color: "var(--fg-1)",
  textDecorationLine: "underline",
  textDecorationStyle: "dotted",
  textDecorationColor: "var(--fg-3)",
  textUnderlineOffset: "0.25em",
  cursor: "help",
};

export const STATE_CELL_STYLE: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: "var(--space-2)",
  minWidth: 0,
};

export const ACTION_CELL_STYLE: CSSProperties = {
  display: "flex",
  alignItems: "center",
  // Held to the right edge: the track is a share of the width, wider than
  // the controls in it.
  justifyContent: "flex-end",
  gap: "var(--space-2)",
  flexShrink: 0,
};

/**
 * A model's state, as a glyph AND a word (myne-md/myne#867, on the user's read:
 * "an icon beside the state, a check for installed and a cross for not").
 *
 * Shared by both model tables, the verified catalogue and the files chosen by
 * hand, so "is this model available" reads the same way in both. The glyph is
 * `aria-hidden`: the word beside it is the state, and the glyph is how a scan
 * finds the rows that still need something without reading each one. The
 * `testId` sits on the WORD, so a scenario reading the state reads text.
 */
export function ModelStateLabel(props: {
  ok: boolean;
  text: string;
  testId: string;
  describedBy?: string;
}) {
  const colour = props.ok ? "var(--accent)" : "var(--fg-3)";
  return (
    <span
      style={{ display: "inline-flex", alignItems: "center", gap: "var(--space-1)", minWidth: 0 }}
      data-state={props.ok ? "ok" : "missing"}
    >
      <span aria-hidden="true" style={{ display: "inline-flex", flex: "none", color: colour }}>
        <Icon name={props.ok ? "circle-check" : "circle-x"} size={14} />
      </span>
      <span
        data-testid={props.testId}
        aria-describedby={props.describedBy}
        style={{
          fontSize: "var(--text-sm)",
          color: colour,
          fontFamily: "var(--font-mono)",
          minWidth: 0,
          overflow: "hidden",
          textOverflow: "ellipsis",
          whiteSpace: "nowrap",
        }}
      >
        {props.text}
      </span>
    </span>
  );
}

/** The row's failure line. Spans the grid so it reads under the row rather than
 *  inside a cell, and it stays INSIDE the row so the row's own text carries the
 *  message (the E2E lane asserts the failure on the row). */
const ERROR_LINE_STYLE: CSSProperties = {
  ...ERROR_STYLE,
  gridColumn: "1 / -1",
};

/** One artefact: its state, its provenance, and the one action its state
 *  enables. Moved out of `AiPanel.tsx` unchanged by myne-md/myne#867, and from a
 *  `SettingRow` to a table row by myne-md/myne#885. */
function CatalogueRow(props: {
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
  // unmounting when the topic changes, and survives the user switching Settings
  // panels (myne-md/myne#814).
  const download = useModelDownload(props.artifact);
  const [error, setError] = useState<string | null>(null);
  const [removing, setRemoving] = useState(false);
  const compact = useSettingsCompact();
  // The size is the row's description: it is what the state and the progress
  // readout are about, so both point their `aria-describedby` at it. The id is
  // generated rather than written, because this component renders once per
  // artefact and a literal would collide.
  const sizeId = useId();

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
    <div
      style={compact ? ROW_COMPACT_STYLE : ROW_STYLE}
      data-testid={`ai.download-row-${props.artifact}`}
      data-setting-anchor={`ai.download.${props.artifact}`}
    >
      <span style={NAME_CELL_STYLE}>
        <Tooltip label={props.sizeText}>
          {/* Focusable, so the size in the tooltip is reachable from the
              keyboard as well as by hover (myne-md/myne#867 review, D6). */}
          <span
            tabIndex={0}
            style={NAME_STYLE}
            data-testid={`ai.download-name-${props.artifact}`}
          >
            {props.label}
          </span>
        </Tooltip>
        <span id={sizeId} style={VISUALLY_HIDDEN}>
          {props.sizeText}
        </span>
      </span>
      <div style={STATE_CELL_STYLE}>
        {downloading ? (
          <>
            <div
              data-testid={`ai.download-progress-${props.artifact}`}
              role="progressbar"
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={percent}
              aria-describedby={sizeId}
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
              aria-describedby={sizeId}
              style={{
                fontSize: "var(--text-sm)",
                color: "var(--fg-2)",
                fontFamily: "var(--font-mono)",
                minWidth: "4ch",
              }}
            >
              {t("settings.ai.downloadingPercent", { percent })}
            </span>
          </>
        ) : (
          <ModelStateLabel
            ok={props.path !== null && props.path !== ""}
            text={
              props.path
                ? t("settings.ai.downloadInstalled")
                : t("settings.ai.downloadNotInstalled")
            }
            testId={`ai.download-state-${props.artifact}`}
            describedBy={sizeId}
          />
        )}
      </div>
      <div style={ACTION_CELL_STYLE}>
        {downloading ? (
          <Button
            variant="ghost"
            onClick={() => cancelModelDownloadFor(props.artifact)}
            data-testid={`ai.download-cancel-${props.artifact}`}
          >
            {t("settings.ai.downloadCancel")}
          </Button>
        ) : (
          <>
            {/* **Which FILE this row is using** (myne-md/myne#848). Two rows
                that both said "Installed" were two unexplained rows: a model
                fetched by the app and one chosen from a file picker are
                different promises about where the bytes came from, and the one
                fact that is always true and always knowable is the path. The
                path is the provenance; a mechanism ("downloaded", "side-loaded")
                would be a claim the panel cannot make from `loadModelPath`
                alone, and the download store resets with the session. */}
            <ModelPathButton
              path={props.path}
              label={props.label}
              revealLabel={t("settings.ai.modelShowInFolder")}
              testId={`ai.model-provenance-${props.artifact}`}
              panelTestId={`ai.model-provenance-panel-${props.artifact}`}
            />
            {props.path === null ? (
              <Button
                variant="secondary"
                disabled={!props.aiEnabled || busy}
                onClick={() => void startModelDownload(props.artifact)}
                data-testid={`ai.download-button-${props.artifact}`}
              >
                {t("settings.ai.downloadInstall")}
              </Button>
            ) : (
              <Button
                variant="ghost"
                disabled={!props.aiEnabled || busy}
                onClick={() => void remove()}
                data-testid={`ai.remove-button-${props.artifact}`}
              >
                {t("settings.ai.modelRemove")}
              </Button>
            )}
          </>
        )}
      </div>
      {error != null && error !== "" && (
        <p role="alert" style={ERROR_LINE_STYLE}>
          {error}
        </p>
      )}
    </div>
  );
}

interface AiModelCatalogueProps {
  /** The role to stored-path map the panel already holds. */
  modelPaths: Record<string, string | null>;
  aiEnabled: boolean;
  /** Re-read the stored paths after a download completes or a model is removed. */
  onChanged: () => void;
  onShowToast?: (message: string) => void;
}

/**
 * The catalogue table, inline in the `Models` topic.
 *
 * `data-setting-anchor="ai.downloads"` is the settings search's scroll target,
 * which is where the registry entry already pointed: it used to land on the row
 * whose button opened the modal, and it lands on the list itself now that the
 * list is the surface (myne-md/myne#885).
 */
export function AiModelCatalogue({
  modelPaths,
  aiEnabled,
  onChanged,
  onShowToast,
}: AiModelCatalogueProps) {
  const { t } = useTranslation();
  const compact = useSettingsCompact();
  return (
    <div
      style={CATALOGUE_STYLE}
      data-testid="ai.catalogue"
      data-setting-anchor="ai.downloads"
    >
      <p style={HELPER_STYLE}>{t("settings.ai.downloadsHelper")}</p>
      <div style={compact ? { display: "flex", flexDirection: "column" } : TABLE_STYLE}>
        {!compact && (
          <div style={HEADER_ROW_STYLE} aria-hidden="true">
            <span style={HEADER_CELL_STYLE}>{t("settings.ai.catalogueColModel")}</span>
            <span style={HEADER_CELL_STYLE}>{t("settings.ai.catalogueColState")}</span>
            <span />
          </div>
        )}
        {MODEL_ARTIFACTS.map((artifact) => (
          <CatalogueRow
            key={artifact.id}
            artifact={artifact.id}
            role={artifact.role}
            label={t(artifact.labelKey)}
            sizeText={t(artifact.sizeKey)}
            path={modelPaths[artifact.role] ?? null}
            aiEnabled={aiEnabled}
            onChanged={onChanged}
            {...(onShowToast === undefined ? {} : { onShowToast })}
          />
        ))}
      </div>
    </div>
  );
}
