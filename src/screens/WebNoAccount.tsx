// The two walls a browser arrival can hit, explained (phase3-web-client task 40).
//
// # Why a screen and not an error
//
// Both states are **by design**, and a dead end without an explanation reads as
// a bug. A user with no account cannot create one here because account creation
// generates and displays the 24-word recovery phrase, and `decisions.md`
// 2026-07-26 forbids that from ever happening in served code — a phrase leaked
// once has no in-app remedy, since `protocol.md` §7 preserves it across every
// password change and there is no rotation command. A user with an account but
// no sync configured cannot proceed because the web client has no local vault to
// fall back on: sync is not an optional extra here, it is the storage.
//
// # The reason, not just the restriction
//
// Saying "not available in the browser" would be accurate and useless. Each
// state names *why* the browser is the wrong place for that particular step, and
// hands over to the client that can do it — which is the difference between a
// boundary and a failure.

import { type CSSProperties } from "react";
import { useTranslation } from "react-i18next";
import { CenteredCard } from "../components/primitives/CenteredCard";
import { openUrl } from "../platform/opener";

/** Where the native clients live. One constant, so the two states cannot drift. */
export const NATIVE_DOWNLOAD_URL = "https://myne.md/download";

const BODY: CSSProperties = {
  color: "var(--fg-2)",
  fontSize: "var(--text-base)",
  lineHeight: 1.55,
};

const REASON: CSSProperties = {
  color: "var(--fg-3)",
  fontSize: "var(--text-sm)",
  lineHeight: 1.5,
};

const LINK: CSSProperties = {
  color: "var(--fg-1)",
  textDecoration: "underline",
  cursor: "pointer",
  background: "none",
  border: "none",
  padding: 0,
  font: "inherit",
};

export type WebWall =
  /** Arrived with no account at all. */
  | "no-account"
  /** Has an account, but this browser has no sync endpoint configured. */
  | "no-sync";

export interface WebNoAccountProps {
  wall: WebWall;
}

export function WebNoAccount({ wall }: WebNoAccountProps) {
  const { t } = useTranslation();
  const key = wall === "no-account" ? "noAccount" : "noSync";

  return (
    <CenteredCard>
      <h1 style={{ fontFamily: "var(--font-sans)", fontSize: "var(--text-xl)" }}>
        {t(`web.wall.${key}.title`)}
      </h1>
      {/* Static testid + a discriminator attribute, not an interpolated name
          (phase3-web-client task 100). `src/AGENTS.md`'s observability contract
          asks for exactly this shape — one stable selector per element, the
          VARIANT in a `data-*` — and holding to it uniformly on the pre-unlock
          screens is what lets a guard reject an interpolated `data-*` outright.
          That rule is worth having absolutely rather than case-by-case: the
          account number is typed on the screen next door, and
          `data-value={account}` is one keystroke from here. */}
      <p style={BODY} data-testid="web.wall" data-wall={wall}>
        {t(`web.wall.${key}.body`)}
      </p>
      {/* The reason is a separate paragraph rather than a parenthetical: it is
          the part that turns a restriction into a boundary, and burying it in
          the same sentence is how it stops being read. */}
      <p style={REASON}>{t(`web.wall.${key}.reason`)}</p>
      <button
        type="button"
        style={LINK}
        data-testid="web.wall.native-link"
        onClick={() => {
          void openUrl(NATIVE_DOWNLOAD_URL);
        }}
      >
        {t("web.wall.getNative")}
      </button>
    </CenteredCard>
  );
}
