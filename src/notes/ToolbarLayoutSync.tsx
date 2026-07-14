// MYND-336: feed the resolved floating-toolbar layout from vault.prefs into the
// editor's toolbar plugin (`setToolbarLayout`) whenever the customization prefs
// change. A no-render side-effect bridge — mounted once in the editor screen —
// crossing the src → @myne/editor seam the same way `editor-host.ts` does. The
// toolbar re-reads the module store on its next render (transient toolbar).

import { useEffect } from "react";
import { setToolbarLayout, setSelectionExportHandler } from "@myne/editor";
import { usePrefs } from "../hooks/usePrefs";
import { exportSelectionImageWithToast } from "../commands/actions";
import {
  EDITOR_TOOLBAR_DEFAULT_ORDER,
  resolveToolbarHidden,
  resolveToolbarOrder,
} from "./toolbarItems";

export function ToolbarLayoutSync(): null {
  const { prefs } = usePrefs();
  // Wire the floating toolbar's export-selection button to the desktop export
  // (MYND-361) once — crosses the editor→app seam like setToolbarLayout.
  useEffect(() => {
    setSelectionExportHandler(exportSelectionImageWithToast);
    return () => setSelectionExportHandler(null);
  }, []);
  useEffect(() => {
    // An un-customized vault (empty prefs) falls back to the canonical defaults,
    // matching the Settings list — so the fed layout equals today's toolbar. The
    // hidden set goes through `resolveToolbarHidden`, which owns the same
    // empty-means-unset fallback AND pins the not-yet-renderable ids.
    const order =
      prefs.editor_toolbar_order.length > 0
        ? prefs.editor_toolbar_order
        : EDITOR_TOOLBAR_DEFAULT_ORDER;
    setToolbarLayout(
      resolveToolbarOrder(order, resolveToolbarHidden(prefs.editor_toolbar_hidden)),
    );
  }, [prefs.editor_toolbar_order, prefs.editor_toolbar_hidden]);
  return null;
}
