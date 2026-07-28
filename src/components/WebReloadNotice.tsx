// "A reload means your password again" (phase3-web-client task 42).
//
// # Why this is a surface at all
//
// There is no quick-unlock on web in this release, so every reload costs a full
// password entry plus a ~0.5 s derivation. Discovering that by reloading makes
// it read as a fault; being told beforehand makes it read as what it is — the
// key is rebuilt from the password each time, which is the same property that
// keeps the vault unreadable while the page is closed.
//
// # Three constraints, and they pull against each other
//
// * **Before the first reload**, or it has already failed.
// * **No implication that a faster path exists.** No "for now", no "coming
//   soon": quick-unlock on web is MYND-578 and unscheduled, and a hint that it
//   is around the corner is a promise this release does not make.
// * **Not a nag.** Shown once per browser and never again — which is why the
//   dismissal is persisted in `localStorage` rather than in component state.
//
// `localStorage` deliberately, not the vault: the note is about the browser, it
// must survive a locked vault (it is most useful *before* one exists), and it
// carries nothing secret — a boolean saying "this browser has been told".

import { useState, type CSSProperties } from "react";
import { useTranslation } from "react-i18next";

/** The one key. Namespaced so it cannot collide with anything else on the origin. */
export const RELOAD_NOTICE_KEY = "myne.web.reload-notice-seen";

const ROOT: CSSProperties = {
  display: "flex",
  gap: "var(--space-3)",
  alignItems: "flex-start",
  background: "var(--bg-2)",
  border: "1px solid var(--line-1)",
  borderRadius: "var(--radius-2)",
  padding: "var(--space-3) var(--space-4)",
  marginBottom: "var(--space-3)",
};

const TITLE: CSSProperties = {
  fontFamily: "var(--font-sans)",
  fontSize: "var(--text-sm)",
  color: "var(--fg-1)",
  margin: 0,
};

const BODY: CSSProperties = {
  fontSize: "var(--text-sm)",
  color: "var(--fg-3)",
  lineHeight: 1.5,
  margin: "var(--space-1) 0 0 0",
};

const DISMISS: CSSProperties = {
  background: "none",
  border: "none",
  color: "var(--fg-3)",
  cursor: "pointer",
  font: "inherit",
  padding: 0,
};

/** Whether this browser has already been told. Storage failures read as "not
 *  seen": a private window with storage denied should get the note, and showing
 *  it twice is a far smaller cost than never showing it. */
function alreadySeen(): boolean {
  try {
    return window.localStorage.getItem(RELOAD_NOTICE_KEY) === "1";
  } catch {
    return false;
  }
}

export function WebReloadNotice() {
  const { t } = useTranslation();
  const [dismissed, setDismissed] = useState(alreadySeen);

  if (dismissed) return null;

  return (
    <div style={ROOT} data-testid="web.reload-notice">
      <div style={{ flex: 1 }}>
        <p style={TITLE}>{t("web.reload.title")}</p>
        <p style={BODY}>{t("web.reload.body")}</p>
      </div>
      <button
        type="button"
        style={DISMISS}
        data-testid="web.reload-notice.dismiss"
        aria-label={t("common.dismiss")}
        onClick={() => {
          try {
            window.localStorage.setItem(RELOAD_NOTICE_KEY, "1");
          } catch {
            // Storage denied: the note reappears next session. Annoying, and
            // still better than failing the dismissal.
          }
          setDismissed(true);
        }}
      >
        ✕
      </button>
    </div>
  );
}
