// The model catalogue: every artefact Myne's own origin can serve, whether or
// not it is installed (myne-md/myne#867).
//
// ── Why this is a modal and not a section ───────────────────────────────────
// The download rows used to be a section of the AI panel, directly under the
// per-role assignment rows, and the two read as two answers to the same
// question. They are not: assignment asks "which file does this role use", the
// catalogue asks "what can I get". A panel that renders both inline makes the
// reader work out which of two neighbouring blocks is the one that installs
// something. So the catalogue is opened from an icon at the right of the Models
// heading, and the panel keeps one block whose job is assignment.
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

import { useEffect, useRef, useState, type CSSProperties } from "react";
import { useTranslation } from "react-i18next";

import { removeModel, type DownloadArtifactId } from "../../lib/ai-model-download";
import {
  cancelModelDownloadFor,
  startModelDownload,
  useModelDownload,
} from "../../lib/ai-download-store";
import { Button } from "../primitives/Button";
import { ModalShell } from "../primitives/ModalShell";
import { ModelPathButton } from "./ModelPathButton";
import { SettingRow } from "./SettingRow";
import { HELPER_STYLE } from "./panel-styles";

/**
 * What the origin serves, in the order the catalogue lists it.
 *
 * A local roster rather than a host query, because the host has no "list the
 * artefacts" command and adding one would cost a capability row, a web
 * capability classification and a caller check for a list the client already
 * has. The cost is that a new artefact needs a row here as well as its id in
 * `DownloadArtifactId`; the compiler finds that, since the id field is typed by
 * the union.
 */
const MODEL_ARTIFACTS: readonly {
  id: DownloadArtifactId;
  /** The model-store role this artefact registers. Remove acts on the role. */
  role: string;
  labelKey: string;
  sizeKey: string;
}[] = [
  {
    id: "embedding-e5-small",
    role: "embedding",
    labelKey: "settings.ai.modelEmbeddingLabel",
    sizeKey: "settings.ai.downloadEmbeddingSize",
  },
  {
    id: "tag",
    role: "tag",
    labelKey: "settings.ai.downloadTagLabel",
    sizeKey: "settings.ai.downloadTagSize",
  },
];

const ROW_GROUP_STYLE: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: "var(--space-2)",
};

/** One artefact: its state, its provenance, and the one action its state
 *  enables. Moved out of `AiPanel.tsx` unchanged by myne-md/myne#867. */
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
  // unmounting when the catalogue closes, and survives the user switching
  // Settings panels (myne-md/myne#814).
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
          </div>
        )
      }
    />
  );
}

interface AiModelCatalogueProps {
  open: boolean;
  onClose: () => void;
  /** The role to stored-path map the panel already holds. */
  modelPaths: Record<string, string | null>;
  aiEnabled: boolean;
  /** Re-read the stored paths after a download completes or a model is removed. */
  onChanged: () => void;
  onShowToast?: (message: string) => void;
}

export function AiModelCatalogue({
  open,
  onClose,
  modelPaths,
  aiEnabled,
  onChanged,
  onShowToast,
}: AiModelCatalogueProps) {
  const { t } = useTranslation();
  return (
    <ModalShell
      open={open}
      onClose={onClose}
      labelId="ai-catalogue-title"
      title={t("settings.ai.downloadsLabel")}
      width={520}
      testId="ai.catalogue"
    >
      <div style={ROW_GROUP_STYLE}>
        <p style={HELPER_STYLE}>{t("settings.ai.downloadsHelper")}</p>
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
    </ModalShell>
  );
}
