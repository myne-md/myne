// `<ViewsManager>` — the Views manager modal (view-manifests, myne-md/myne#922
// task 7).
//
// WHY A MODAL AND NOT A SETTINGS PANEL OR A STAGE VARIANT. A saved view is
// vault content, not a preference and not a screen: managing them belongs beside
// the thing they are, which is where the note-templates manager sits. The PRD
// pins this shape ("the surface is a modal, not a Settings panel and not a Stage
// variant"), and it is mounted by an Editor-local boolean and opened from a
// command-palette action, exactly like the other desktop modal carve-outs
// (`decisions.md` 2026-05-08).
//
// WHY IT LISTS A PENDING VIEW INSTEAD OF HIDING IT. Approval is per device and
// keyed by version: a definition that arrived by import or by sync is visible in
// the list and refuses to open until the person at this device approves it. A row
// the user cannot see is a decision they cannot make, so the row is present, its
// open action is refused with the reason, and the approval it needs is one
// button on the row. Opening one from anywhere else (the sidebar flyout, a
// restored tab) hits the same gate inside `useViewResult`, which refuses to run
// an unapproved definition; this surface is where the decision is offered, not
// where it is enforced.
//
// THE SIDEBAR IS UNTOUCHED, on purpose. Its Views entry stays behind the
// device-local toggle in `src/lib/viewsEnabled.ts`, whose default derives from
// whether the vault has any views at all. So the first view a reader receives
// makes the entry appear with no new code here, and turning the toggle off still
// leaves this modal reachable from the palette, which is the door the checkbox
// is about: hiding an entry point must not strand the data.
//
// Design canon: `ModalShell` chrome, `Button` / `Icon` primitives, sentence case,
// tokens only (no literals), one accent. No new primitive and no new token.

import { useCallback, useMemo, useState, type CSSProperties } from "react";
import { useTranslation } from "react-i18next";
import { ModalShell } from "./primitives/ModalShell";
import { Button } from "./primitives/Button";
import { Icon } from "./primitives/Icon";
import { EmptyState } from "./primitives/EmptyState";
import { usePrefs } from "../hooks/usePrefs";
import { useWorkspaceOptional } from "../notes/workspaceContext";
import { deleteSavedView } from "../lib/prefs";
import { isViewApproved } from "../notes/views/viewApproval";
import { orderSavedViews } from "../notes/views/orderSavedViews";
import type { SavedView, ViewType } from "../lib/prefs";

export interface ViewsManagerProps {
  open: boolean;
  onClose: () => void;
}

const ROOT_STYLE: CSSProperties = {
  flex: 1,
  minHeight: 0,
  display: "flex",
  flexDirection: "column",
};

const BODY_STYLE: CSSProperties = {
  flex: 1,
  minHeight: 0,
  overflowY: "auto",
  padding: "var(--space-3)",
  display: "flex",
  flexDirection: "column",
  gap: "var(--space-1)",
};

const ROW_STYLE: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: "var(--space-2)",
  padding: "0 var(--space-2)",
  borderBottom: "1px solid var(--line-1)",
};

const ROW_MAIN_STYLE: CSSProperties = {
  flex: 1,
  minWidth: 0,
  display: "flex",
  flexDirection: "column",
  gap: "var(--space-1)",
  padding: "var(--space-3) 0",
};

const ROW_OPEN_STYLE: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: "var(--space-2)",
  minWidth: 0,
  background: "transparent",
  border: 0,
  padding: 0,
  textAlign: "start",
  color: "var(--fg-1)",
  fontFamily: "var(--font-sans)",
  fontSize: "var(--text-base)",
  cursor: "pointer",
};

const ROW_NAME_STYLE: CSSProperties = {
  overflow: "hidden",
  textOverflow: "ellipsis",
  whiteSpace: "nowrap",
};

const ROW_META_STYLE: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: "var(--space-3)",
  flexWrap: "wrap",
  fontFamily: "var(--font-sans)",
  fontSize: "var(--text-sm)",
  color: "var(--fg-3)",
};

const STATE_APPROVED_STYLE: CSSProperties = {
  color: "var(--fg-3)",
};

const STATE_PENDING_STYLE: CSSProperties = {
  color: "var(--fg-2)",
};

/** One saved view's render type, in the words the view settings modal already
 *  uses. Reusing those keys rather than adding a second naming of the three
 *  types is what keeps "Table" meaning one thing in the app. */
function viewTypeKey(type: ViewType): string {
  switch (type) {
    case "cards":
      return "notes.viewSettings.viewTypeCards";
    case "table":
      return "notes.viewSettings.viewTypeTable";
    case "list":
      return "notes.viewSettings.viewTypeList";
  }
}

export function ViewsManager({ open, onClose }: ViewsManagerProps) {
  const { t } = useTranslation();
  // Optional: the modal always mounts inside `WorkspaceProvider` in the app, but
  // its own component test and story render it bare, so a missing provider must
  // degrade to "no tab to open" rather than throw (the `TemplatesManager`
  // precedent).
  const ws = useWorkspaceOptional();
  const { prefs, approveView } = usePrefs();
  // A failed delete is surfaced inline rather than swallowed: the row would
  // otherwise stay on screen with no explanation, which reads as a click that
  // did nothing.
  const [error, setError] = useState<string | null>(null);

  const views = useMemo(
    () => orderSavedViews(prefs.saved_views, prefs.view_order),
    [prefs.saved_views, prefs.view_order],
  );

  const label = useCallback(
    (view: SavedView): string =>
      view.name.trim() === "" ? t("notes.views.untitledView") : view.name,
    [t],
  );

  const handleApprove = useCallback(
    (view: SavedView) => {
      setError(null);
      // The approval names the version the reader was shown. A later version
      // arriving clears it by equality, with nothing to remember to clear.
      void approveView(view.id, view.version);
    },
    [approveView],
  );

  const handleDelete = useCallback((view: SavedView) => {
    setError(null);
    // The host prunes this view's approval entry in the same write, so deleting
    // and later re-importing the same id asks again rather than inheriting a
    // decision about a view that no longer exists.
    void deleteSavedView(view.id).catch(() => {
      setError(t("notes.views.manager.deleteFailed"));
    });
  }, [t]);

  return (
    <ModalShell
      open={open}
      title={t("notes.views.manager.title")}
      labelId="views-manager-title"
      onClose={onClose}
      width={520}
      closeLabel={t("notes.views.manager.close")}
      testId="views-manager.modal"
    >
      <div data-testid="views-manager.root" style={ROOT_STYLE}>
        {error !== null && (
          <p
            role="alert"
            data-testid="views-manager.error"
            style={{
              margin: 0,
              padding: "var(--space-2) var(--space-5)",
              color: "var(--danger)",
              fontSize: "var(--text-sm)",
            }}
          >
            {error}
          </p>
        )}
        {views.length === 0 ? (
          <EmptyState
            variant="firstRun"
            icon="layout-grid"
            title={t("notes.views.manager.emptyTitle")}
            body={t("notes.views.manager.emptyBody")}
            testId="views-manager.empty"
          />
        ) : (
          <div
            role="list"
            aria-label={t("notes.views.manager.listLabel")}
            style={BODY_STYLE}
            data-testid="views-manager.list"
          >
            {views.map((view) => {
              const name = label(view);
              const approved = isViewApproved(view, prefs.view_approvals);
              return (
                <div
                  key={view.id}
                  role="listitem"
                  style={ROW_STYLE}
                  data-testid="views-manager.row"
                  data-view-id={view.id}
                  data-approved={approved ? "true" : "false"}
                >
                  <div style={ROW_MAIN_STYLE}>
                    <Button
                      variant="ghost"
                      style={ROW_OPEN_STYLE}
                      // A pending view cannot be opened from here, and the
                      // refusal is stated on the row itself rather than only in
                      // a tooltip: a hidden reason is the same dead end as a
                      // hidden row.
                      disabled={!approved}
                      title={
                        approved
                          ? t("notes.views.manager.openLabel", { name })
                          : t("notes.views.manager.pendingTitle", { name })
                      }
                      aria-label={
                        approved
                          ? t("notes.views.manager.openLabel", { name })
                          : t("notes.views.manager.pendingTitle", { name })
                      }
                      data-testid="views-manager.row-open"
                      onClick={() => {
                        if (!approved) return;
                        ws?.openView(view.id);
                        onClose();
                      }}
                    >
                      <Icon
                        name="layout-grid"
                        size={14}
                        style={{ color: "var(--fg-3)" }}
                      />
                      <span style={ROW_NAME_STYLE}>{name}</span>
                    </Button>
                    <div style={ROW_META_STYLE}>
                      <span>{t(viewTypeKey(view.view_type))}</span>
                      <span
                        data-testid="views-manager.row-state"
                        style={
                          approved ? STATE_APPROVED_STYLE : STATE_PENDING_STYLE
                        }
                      >
                        {approved
                          ? t("notes.views.manager.approvedState")
                          : t("notes.views.manager.pendingState")}
                      </span>
                    </div>
                  </div>
                  {!approved && (
                    <Button
                      variant="primary"
                      data-testid="views-manager.row-approve"
                      onClick={() => handleApprove(view)}
                    >
                      {t("notes.views.manager.approve")}
                    </Button>
                  )}
                  <Button
                    variant="ghost"
                    style={{ color: "var(--danger)" }}
                    aria-label={t("notes.views.manager.deleteLabel", { name })}
                    data-testid="views-manager.row-delete"
                    onClick={() => handleDelete(view)}
                  >
                    <Icon name="trash-2" size={16} />
                  </Button>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </ModalShell>
  );
}
