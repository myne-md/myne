// The plain-file surface (myne-md/myne#788).
//
// A full window surface with its own RAM-only tab strip, rendered over whatever
// vault stage the app is on. It exists in every vault state by decision: a
// locked vault or a device with no vault still opens the user's files.
//
// The marker strip is a requirement, not decoration: the issue's own words are
// that the surface "must not read as a private action", so the distinction
// between an encrypted note and a local file is text plus icon plus colour
// together, present for as long as the surface is.
//
// Styling is token-bound (`docs/design/colors_and_type.css`) with no visual
// literals, so the surface follows every built-in palette and the token
// ratchet stays flat (`scripts/check-token-adoption.mjs`: a new file starts at
// zero). The custom vault palette never reaches here (MYT1 is vault content).

import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { CMEditor } from "@myne/editor";
import { Icon } from "../components/primitives/Icon";
import { ImportPlainFileButton } from "../components/plain/ImportPlainFileButton";
import { OpenFileButton } from "./OpenFileButton";
import { setPlainSurfaceActive } from "./surfaceMode";
import {
  close,
  edit,
  flushAll,
  resolveCopyWithSave,
  resolveReload,
  resolveOverwrite,
  save,
  setActive,
  usePlainFileState,
} from "./store";

/** The conflict banner's copy arm: busy + failure state around the store call. */
function ConflictCopyButton({ handle }: { handle: number }) {
  const { t } = useTranslation();
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);

  const copy = async () => {
    setBusy(true);
    setFailed(false);
    const outcome = await resolveCopyWithSave(handle);
    // "cancelled" is not a failure: the user closed the save dialog, so the
    // banner stays and says nothing new.
    if (outcome === "failed") setFailed(true);
    setBusy(false);
  };

  return (
    <>
      <button
        data-testid="plain-file.conflict.copy"
        disabled={busy}
        onClick={() => void copy()}
        style={{
          border: "1px solid var(--line-1)",
          borderRadius: "var(--radius-2)",
          background: "var(--paper)",
          color: "var(--fg-1)",
          padding: "var(--space-1) var(--space-2)",
          cursor: "pointer",
          opacity: busy ? 0.6 : 1,
        }}
      >
        {t("plainFile.conflict.copy")}
      </button>
      {failed && (
        <span
          role="alert"
          data-testid="plain-file.conflict.copy-error"
          style={{ color: "var(--danger)", fontSize: "var(--text-xs)" }}
        >
          {t("plainFile.conflict.copyFailed")}
        </span>
      )}
    </>
  );
}

export function PlainFileScreen() {
  const { t } = useTranslation();
  const { files, activeHandle } = usePlainFileState();
  const active = files.find((file) => file.handle === activeHandle) ?? null;

  useEffect(() => {
    // The open subscription + drain live at App level (they must exist before
    // the first file); this effect only marks which surface owns the host.
    setPlainSurfaceActive(true);
    return () => {
      setPlainSurfaceActive(false);
      // Best-effort flush on unmount: the autosave idle pass may not have run.
      void flushAll();
    };
  }, []);

  useEffect(() => {
    const onBeforeUnload = () => {
      void flushAll();
    };
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => window.removeEventListener("beforeunload", onBeforeUnload);
  }, []);

  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        height: "100%",
        minHeight: 0,
        background: "var(--paper)",
        color: "var(--fg-1)",
      }}
    >
      <div
        role="note"
        data-testid="plain-file.marker"
        style={{
          display: "flex",
          alignItems: "center",
          gap: "var(--space-2)",
          padding: "var(--space-2) var(--space-3)",
          background: "var(--paper-2)",
          borderBottom: "1px solid var(--line-1)",
          color: "var(--fg-2)",
          fontSize: "var(--text-sm)",
        }}
      >
        <Icon
          name="file-text"
          style={{ color: "var(--fg-2)" }}
          aria-hidden="true"
        />
        <span>{t("plainFile.marker")}</span>
      </div>

      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: "var(--space-1)",
          padding: "var(--space-1) var(--space-2)",
          background: "var(--paper-2)",
          borderBottom: "1px solid var(--line-1)",
        }}
      >
        <div
          role="tablist"
          aria-label={t("plainFile.tabs")}
          style={{
            display: "flex",
            alignItems: "center",
            gap: "var(--space-1)",
            overflowX: "auto",
            minWidth: 0,
          }}
        >
          {files.map((file) => {
            const isActive = file.handle === activeHandle;
            const dirty = file.status === "editing" || file.status === "saving";
            return (
              <div
                key={file.handle}
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: "var(--space-1)",
                  padding: "var(--space-1) var(--space-2)",
                  borderRadius: "var(--radius-2)",
                  background: isActive ? "var(--paper)" : "transparent",
                  color: isActive ? "var(--fg-1)" : "var(--fg-2)",
                  flexShrink: 0,
                }}
              >
                <button
                  role="tab"
                  aria-selected={isActive}
                  data-testid="plain-file.tab"
                  onClick={() => setActive(file.handle)}
                  style={{
                    border: "none",
                    background: "transparent",
                    color: "inherit",
                    font: "inherit",
                    cursor: "pointer",
                  }}
                >
                  {file.name}
                  {dirty ? " •" : ""}
                </button>
                <button
                  aria-label={t("plainFile.closeTab", { name: file.name })}
                  data-testid="plain-file.close"
                  onClick={() => void close(file.handle)}
                  style={{
                    border: "none",
                    background: "transparent",
                    color: "var(--fg-2)",
                    cursor: "pointer",
                  }}
                >
                  ×
                </button>
              </div>
            );
          })}
        </div>
        <OpenFileButton />
        {/* The one-shot vault crossing: acts on the ACTIVE tab, so it renders
            only while a tab is open. Rendered from `src/components/plain/`
            because it is the component allowed to reach vault modules (the
            plain-surface import guard); this surface only places it. */}
        {active !== null && <ImportPlainFileButton handle={active.handle} />}
      </div>

      {active?.status === "error" && (
        <div
          role="alert"
          data-testid="plain-file.save-error"
          style={{
            display: "flex",
            alignItems: "center",
            gap: "var(--space-2)",
            padding: "var(--space-2) var(--space-3)",
            background: "var(--paper-2)",
            borderBottom: "1px solid var(--line-1)",
            color: "var(--fg-1)",
            fontSize: "var(--text-sm)",
          }}
        >
          <span>{t("plainFile.saveError")}</span>
          <button
            data-testid="plain-file.save-error.retry"
            onClick={() => void save(active.handle)}
            style={{
              border: "1px solid var(--line-1)",
              borderRadius: "var(--radius-2)",
              background: "var(--paper)",
              color: "var(--fg-1)",
              padding: "var(--space-1) var(--space-2)",
              cursor: "pointer",
            }}
          >
            {t("plainFile.retry")}
          </button>
        </div>
      )}

      {active?.status === "conflict" && (
        <div
          role="alert"
          data-testid="plain-file.conflict"
          style={{
            display: "flex",
            alignItems: "center",
            gap: "var(--space-2)",
            padding: "var(--space-2) var(--space-3)",
            background: "var(--paper-2)",
            borderBottom: "1px solid var(--line-1)",
            color: "var(--fg-1)",
            fontSize: "var(--text-sm)",
          }}
        >
          <span>{t("plainFile.conflict.body")}</span>
          <button
            data-testid="plain-file.conflict.reload"
            onClick={() => resolveReload(active.handle)}
            style={{
              border: "1px solid var(--line-1)",
              borderRadius: "var(--radius-2)",
              background: "var(--paper)",
              color: "var(--fg-1)",
              padding: "var(--space-1) var(--space-2)",
              cursor: "pointer",
            }}
          >
            {t("plainFile.conflict.reload")}
          </button>
          <button
            data-testid="plain-file.conflict.overwrite"
            onClick={() => resolveOverwrite(active.handle)}
            style={{
              border: "1px solid var(--line-1)",
              borderRadius: "var(--radius-2)",
              background: "var(--paper)",
              color: "var(--fg-1)",
              padding: "var(--space-1) var(--space-2)",
              cursor: "pointer",
            }}
          >
            {t("plainFile.conflict.overwrite")}
          </button>
          {/* The third arm (task 14): keep the user's text as a copy of their
              choosing instead of choosing between the two files. */}
          <ConflictCopyButton handle={active.handle} />
        </div>
      )}

      <div style={{ flex: 1, minHeight: 0, overflow: "auto" }}>
        {active ? (
          <CMEditor
            key={active.handle}
            // `noteId: null` is the prop's own modelled answer for "this is
            // not a vault note" (required, so a mount site cannot forget it).
            // The name doubles as the editor body's accessible name.
            noteId={null}
            noteTitle={active.name}
            value={active.content}
            onChange={(next) => edit(active.handle, next)}
            onBlur={() => void save(active.handle)}
          />
        ) : (
          <div
            style={{
              padding: "var(--space-3)",
              color: "var(--fg-2)",
              fontSize: "var(--text-sm)",
            }}
          >
            {t("plainFile.empty")}
          </div>
        )}
      </div>
    </div>
  );
}
