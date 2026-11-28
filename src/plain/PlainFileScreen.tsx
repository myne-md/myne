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

import { useEffect, useLayoutEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { CMEditor } from "@myne/editor";
import i18n from "../i18n";
import { Icon } from "../components/primitives/Icon";
import { Button } from "../components/primitives/Button";
import { hoverSurface } from "../components/primitives/hoverSurface";
import { IconButton } from "../components/primitives/IconButton";
import { StatusMark } from "../components/Spinner";
import { MIN_TARGET } from "../components/primitives/targetSize";
import { ImportPlainFileButton } from "../components/plain/ImportPlainFileButton";
import { confirm as dialogConfirm } from "../platform/dialog";
import { OpenFileButton } from "./OpenFileButton";
import { setPlainSurfaceActive } from "./surfaceMode";
import { registerCloseGuard } from "../lib/close-request";
import {
  close,
  edit,
  flushAll,
  resolveCopyWithSave,
  resolveReload,
  resolveOverwrite,
  save,
  setActive,
  unsettledTabs,
  usePlainFileState,
} from "./store";

/** The close path's question, kept at module scope so the guard registration has
 *  no dependency to resubscribe on: "may the window close with these tabs
 *  unsettled?". Nothing unsettled is a plain `true`, so the common path asks
 *  nothing.
 *
 *  A conflicted or errored tab holds the only copy of text that never landed.
 *  `close` refuses to drop it, so closing the window would drop it silently: ask,
 *  and keep the window (and the banner) open on a refusal or a failed prompt. */
async function confirmDropUnsettledTabs(): Promise<boolean> {
  if (unsettledTabs().length === 0) return true;
  try {
    return await dialogConfirm(i18n.t("plainFile.closePending.message"), {
      title: i18n.t("plainFile.closePending.title"),
      okLabel: i18n.t("plainFile.closePending.okLabel"),
      cancelLabel: i18n.t("plainFile.closePending.cancelLabel"),
    });
  } catch {
    return false;
  }
}

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
      <Button
        variant="secondary"
        data-testid="plain-file.conflict.copy"
        disabled={busy}
        onClick={() => void copy()}
      >
        {t("plainFile.conflict.copy")}
      </Button>
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

  // Mark the host owned in a LAYOUT effect, which React flushes during commit,
  // before any child's PASSIVE effect runs. `CMEditor` creates its
  // `EditorView` (building the attachment-catalog and spell ViewPlugins) in a
  // passive `useEffect`, so a passive effect here would run AFTER it and leave
  // the first render's ambient reads (`catalogList` / `prefsRead` through the
  // editor host) unguarded, reaching the vault. A layout effect here runs
  // before that, and unlike a bare render-body write it stays render-pure and
  // is cleaned up on the abandoned/strict-mode path.
  useLayoutEffect(() => {
    setPlainSurfaceActive(true);
    return () => {
      setPlainSurfaceActive(false);
      // Best-effort flush on unmount: the autosave idle pass may not have run.
      void flushAll();
    };
  }, []);

  useEffect(() => {
    // `pagehide` is the last event WebKit reliably fires on an app quit
    // (Cmd+Q does not route through `onCloseRequested` above). It cannot
    // await, so the write races process teardown and may lose; the intercept
    // is the real flush point. This is the same best-effort arm the vault
    // editor has, not a second guarantee.
    const onPageHide = () => {
      void flushAll();
    };
    window.addEventListener("pagehide", onPageHide);
    return () => window.removeEventListener("pagehide", onPageHide);
  }, []);

  // The plain surface's contribution to the exit intercept (myne-md/myne#788),
  // as a GUARD rather than a listener (myne-md/myne#945 item 05): the one
  // `tauri://close-requested` listener lives in `src/lib/close-request.ts` for
  // the life of the process.
  //
  // It used to register its own, because `Editor.tsx`'s handler lives on the
  // editor screen and the editor screen is NOT mounted while this surface is up
  // (`App.tsx` renders one or the other), so its `onCloseRequested` never saw a
  // close from here. A guard removes that coupling: the surface that is mounted
  // is the surface that contributes, whatever else is not. `beforeunload` is
  // still not a substitute: the platform seam records it as a WARNING with no
  // async guarantee (`src/platform/exit-signals.ts`), so a flush started there is
  // killed halfway.
  useEffect(
    () =>
      registerCloseGuard({
        id: "plain-file",
        onCloseRequest: async () => {
          // Asked BEFORE the flush, and again after it (myne-md/myne#945 review,
          // D8). Before: `flushAll` can hang on a lock the lock task holds, and a
          // guard that never answers is answered by nothing, so a confirmation
          // placed only after it is exactly the arm a hang skips, taking the
          // "only copy of text that never landed" with it. After: the flush may
          // itself leave a tab unsettled, which is a second chance to ask.
          if (!(await confirmDropUnsettledTabs())) return false;
          await flushAll();
          return await confirmDropUnsettledTabs();
        },
      }),
    [],
  );

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
            overflowY: "hidden",
            minWidth: 0,
          }}
        >
          {files.map((file) => {
            const isActive = file.handle === activeHandle;
            // One shape per FACT (`docs/design/README.md`): text merely waiting
            // for the autosave is `circle-dashed`, a write actually in flight
            // is `loader-circle` and spinning. Collapsing them would tell the
            // user a save is happening when it is only scheduled.
            const editing = file.status === "editing";
            const saving = file.status === "saving";
            // A buffer that did NOT land (I/O error, or an external change) is
            // not "dirty" in the same sense, but it must not render like a
            // clean tab either: the banner that explains it renders only for
            // the ACTIVE tab, so a backgrounded failed tab would otherwise be
            // indistinguishable from a saved one.
            const failed = file.status === "error" || file.status === "conflict";
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
                {/* The tab WIDGET: `<Button variant="ghost">` carrying
                    `role="tab"`, so it is the primitive rather than a
                    hand-rolled control while keeping the tab semantics. The
                    inline style strips the button padding and inherits the
                    tab's type, so the row keeps painting the active-tab
                    background (myne-md/myne#788). Hover is asked for here,
                    because `role="tab"` is exempt from ghost's resting fill. */}
                <Button
                  variant="ghost"
                  role="tab"
                  aria-selected={isActive}
                  data-testid="plain-file.tab"
                  onClick={() => setActive(file.handle)}
                  {...hoverSurface()}
                  style={{
                    ...MIN_TARGET,
                    padding: 0,
                    gap: "var(--space-1)",
                    color: "inherit",
                    font: "inherit",
                  }}
                >
                  {file.name}
                  {/* A named icon, not a `•`: `docs/design/README.md` bans a
                      unicode symbol standing in for an icon. Mark only, no
                      accessible name, because the tab's text already names the
                      file and the banner below states what is wrong with it. */}
                  {editing && (
                    <StatusMark
                      name="circle-dashed"
                      label={t("plainFile.unsaved")}
                      title={t("plainFile.unsaved")}
                      testId="plain-file.tab-dirty"
                    />
                  )}
                  {saving && (
                    <StatusMark
                      name="loader-circle"
                      label={t("plainFile.unsaved")}
                      title={t("plainFile.unsaved")}
                      tone="accent"
                      spinning
                      testId="plain-file.tab-saving"
                    />
                  )}
                  {failed && (
                    <StatusMark
                      name="circle-x"
                      label={t("plainFile.saveError")}
                      title={t("plainFile.saveError")}
                      testId="plain-file.tab-failed"
                    />
                  )}
                </Button>
                <IconButton
                  icon="x"
                  iconSize={14}
                  label={t("plainFile.closeTab", { name: file.name })}
                  testId="plain-file.close"
                  onClick={() => {
                    // A failed tab refuses to close (`store.ts::close` keeps it
                    // because its text exists only in RAM). Selecting it makes
                    // the banner that owns the resolution visible instead of
                    // the click doing nothing.
                    if (failed) {
                      setActive(file.handle);
                      return;
                    }
                    void close(file.handle);
                  }}
                />
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
          <Button
            variant="secondary"
            data-testid="plain-file.save-error.retry"
            onClick={() => void save(active.handle)}
          >
            {t("plainFile.retry")}
          </Button>
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
          {/* Reload needs the disk snapshot the banner read. A conflict whose
              re-read also failed (the file was deleted or moved) has none, so
              the arm is absent rather than a button that cannot act; the copy
              and overwrite arms below need no source read and stay. */}
          {active.diskContent !== undefined && (
            <Button
              variant="secondary"
              data-testid="plain-file.conflict.reload"
              onClick={() => resolveReload(active.handle)}
            >
              {t("plainFile.conflict.reload")}
            </Button>
          )}
          <Button
            variant="secondary"
            data-testid="plain-file.conflict.overwrite"
            onClick={() => resolveOverwrite(active.handle)}
          >
            {t("plainFile.conflict.overwrite")}
          </Button>
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
