// Attachment sync-progress UI (MYND-423). A compact list of in-flight attachment
// transfers (resumable upload/download over the opaque-ciphertext range transport),
// each with a progress bar + byte readout + status. Resume-aware: a paused/resumed
// transfer keeps its transferred-so-far position. Design canon: monochrome + accent,
// 1px hairlines, no card shadows, token-only styles, sentence-case, no emoji.
//
// Standalone + self-contained: it reads `useAttachmentTransfers()` (a mock registry
// pending the MYND-424 client sync engine) and renders its own empty state, so it is
// ready to mount (e.g. in a sidebar/status surface) once the engine + B5 editor land.

import type { CSSProperties } from "react";
import { useTranslation } from "react-i18next";
import i18n from "../../i18n";
import { formatBytes } from "./format";
import {
  type AttachmentTransfer,
  useAttachmentTransfers,
} from "../../hooks/useAttachmentTransfers";

const ROOT_STYLE: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: "var(--space-3)",
  width: "100%",
};

const HEADING_STYLE: CSSProperties = {
  fontSize: "var(--text-sm)",
  fontWeight: "var(--weight-medium)" as CSSProperties["fontWeight"],
  color: "var(--fg-2)",
  margin: 0,
};

const EMPTY_STYLE: CSSProperties = {
  fontSize: "var(--text-sm)",
  color: "var(--fg-3)",
  margin: 0,
};

const ROW_STYLE: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: "var(--space-1)",
  paddingBottom: "var(--space-2)",
  borderBottom: "1px solid var(--line-1)",
};

const ROW_TOP_STYLE: CSSProperties = {
  display: "flex",
  flexDirection: "row",
  alignItems: "baseline",
  justifyContent: "space-between",
  gap: "var(--space-2)",
};

const NAME_STYLE: CSSProperties = {
  fontSize: "var(--text-sm)",
  color: "var(--fg-1)",
  overflow: "hidden",
  textOverflow: "ellipsis",
  whiteSpace: "nowrap",
};

const META_STYLE: CSSProperties = {
  fontSize: "var(--text-xs)",
  color: "var(--fg-3)",
  fontFamily: "var(--font-mono)",
  flexShrink: 0,
};

const TRACK_STYLE: CSSProperties = {
  position: "relative",
  height: 4,
  background: "var(--paper-3)",
  borderRadius: 2,
  overflow: "hidden",
};

function fillStyle(pct: number, status: AttachmentTransfer["status"]): CSSProperties {
  return {
    position: "absolute",
    inset: 0,
    width: `${pct}%`,
    background: status === "error" ? "var(--danger, var(--fg-2))" : "var(--accent)",
    opacity: status === "paused" ? 0.5 : 1,
    transition: "width var(--duration-fast) var(--ease-standard)",
  };
}

function directionLabel(d: AttachmentTransfer["direction"]): string {
  return d === "upload" ? "↑" : "↓";
}

function statusText(t: AttachmentTransfer): string {
  switch (t.status) {
    case "done":
      return i18n.t("sync.attachments.status.done");
    case "error":
      return i18n.t("sync.attachments.status.failedWillRetry");
    case "paused":
      return i18n.t("sync.attachments.status.paused");
    default:
      return `${formatBytes(t.transferred)} / ${formatBytes(t.total)}`;
  }
}

function TransferRow({ t }: { t: AttachmentTransfer }) {
  const { t: translate } = useTranslation();
  const pct = t.total > 0 ? Math.min(100, Math.round((t.transferred / t.total) * 100)) : 0;
  return (
    <div
      style={ROW_STYLE}
      data-testid="attachments.sync-progress-row"
      data-transfer-id={t.id}
      data-direction={t.direction}
      data-status={t.status}
    >
      <div style={ROW_TOP_STYLE}>
        <span style={NAME_STYLE} title={t.name}>
          <span aria-hidden="true">{directionLabel(t.direction)}</span> {t.name}
        </span>
        <span style={META_STYLE}>{statusText(t)}</span>
      </div>
      <div
        style={TRACK_STYLE}
        role="progressbar"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={pct}
        aria-label={
          t.direction === "upload"
            ? translate("sync.attachments.aria.uploading", { name: t.name })
            : translate("sync.attachments.aria.downloading", { name: t.name })
        }
      >
        <div style={fillStyle(pct, t.status)} />
      </div>
    </div>
  );
}

/**
 * AttachmentSyncProgress lists in-flight attachment transfers. Renders nothing
 * but a quiet empty state when idle (the common case). The `hideWhenEmpty` prop
 * lets a host surface omit it entirely when there is nothing to show.
 */
export function AttachmentSyncProgress({
  hideWhenEmpty = false,
}: {
  hideWhenEmpty?: boolean;
}) {
  const { t } = useTranslation();
  const transfers = useAttachmentTransfers();

  if (transfers.length === 0 && hideWhenEmpty) {
    return null;
  }

  return (
    <section style={ROOT_STYLE} data-testid="attachments.sync-progress">
      <p style={HEADING_STYLE}>{t("sync.attachments.heading")}</p>
      {transfers.length === 0 ? (
        <p style={EMPTY_STYLE} data-testid="attachments.sync-progress-empty">
          {t("sync.attachments.empty")}
        </p>
      ) : (
        transfers.map((t) => <TransferRow key={t.id} t={t} />)
      )}
    </section>
  );
}
