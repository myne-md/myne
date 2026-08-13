import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { listen } from "@tauri-apps/api/event";
import { HAS_TAURI } from "../lib/app-window";
import { Toast } from "./feedback";

/** Global listener for the native screenshot-taken event (MYND-476). When
 *  screen-capture protection is engaged, iOS blacks out the captured image and
 *  no text can be drawn into that OS-owned frame — so the only honest remedy is
 *  an in-app banner explaining the blank result. The Rust observer
 *  (`screen_guard`) fires `screen-capture-blocked` ONLY while protection is on. */
export function ScreenshotNotice() {
  const { t } = useTranslation();
  const [shown, setShown] = useState(false);

  useEffect(() => {
    if (!HAS_TAURI) return;
    let hideTimer: number | null = null;
    let unlisten: (() => void) | null = null;
    let cancelled = false;
    void listen("screen-capture-blocked", () => {
      setShown(true);
      if (hideTimer != null) window.clearTimeout(hideTimer);
      hideTimer = window.setTimeout(() => setShown(false), 4200);
    }).then((u) => {
      if (cancelled) u();
      else unlisten = u;
    });
    return () => {
      cancelled = true;
      if (hideTimer != null) window.clearTimeout(hideTimer);
      unlisten?.();
    };
  }, []);

  if (!shown) return null;
  return (
    <div
      data-testid="screenshot-notice"
      style={{ position: "fixed", top: "calc(env(safe-area-inset-top, 0px) + 12px)", insetInlineStart: 0, insetInlineEnd: 0, display: "flex", justifyContent: "center", padding: "0 20px", zIndex: 2000, pointerEvents: "none" }}
    >
      <Toast icon="lock" style={{ maxWidth: 440, lineHeight: 1.4 }}>
        {t("settings.privacy.screenshotBlocked")}
      </Toast>
    </div>
  );
}
