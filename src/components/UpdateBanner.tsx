// Desktop update banner (self-update). A single host placed once in the editor
// chrome, beside `SyncBanners`. Calm and non-blocking (PRODUCT.md tone): a new
// version is a routine event, not an alarm.
//
// Renders nothing on a client without the `selfUpdate` capability (web), and
// nothing while no update is offered. A failed install shows a calm retry line
// rather than disappearing or an error dialog. "Later" dismisses for the
// session; the automatic check re-offers on the next launch.

import { useState, type CSSProperties } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "./primitives/Button";
import { useUpdateAvailable } from "../hooks/useUpdateAvailable";

const STYLE: CSSProperties = {
  display: "flex",
  flexDirection: "row",
  alignItems: "center",
  gap: "var(--space-3)",
  background: "var(--paper-2)",
  border: "1px solid var(--line-2)",
  borderRadius: "var(--radius-2)",
  padding: "var(--space-2) var(--space-4)",
  fontSize: "var(--text-sm)",
  color: "var(--fg-2)",
};

const ACTIONS_STYLE: CSSProperties = {
  marginInlineStart: "auto",
  display: "flex",
  alignItems: "center",
  gap: "var(--space-2)",
};

export function UpdateBanner() {
  const { t } = useTranslation();
  const { state, install } = useUpdateAvailable();
  const [dismissed, setDismissed] = useState(false);

  if (dismissed || state.state === "idle") {
    return null;
  }

  const installing = state.state === "installing";
  const message = installing
    ? t("update.banner.installing")
    : state.state === "failed"
      ? t("update.banner.failed")
      : state.state === "available"
        ? t("update.banner.available", { version: state.version })
        : "";

  return (
    <div data-testid="update.banner" style={STYLE}>
      <span role="status">{message}</span>
      <div style={ACTIONS_STYLE}>
        <Button
          variant="primary"
          onClick={install}
          disabled={installing}
          data-testid="update.banner-restart"
        >
          {t("update.banner.restart")}
        </Button>
        <Button
          variant="ghost"
          onClick={() => {
            setDismissed(true);
          }}
          data-testid="update.banner-later"
        >
          {t("update.banner.later")}
        </Button>
      </div>
    </div>
  );
}
