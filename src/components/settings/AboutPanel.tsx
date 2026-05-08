// Settings → About panel: version (compile-time injected from
// `package.json::version` via Vite `define` — see vite-env.d.ts) +
// build channel (Development / Stable from `import.meta.env.MODE`) +
// threat-model link (opens `https://myne.md/threat-model` via
// `opener:default`'s `allow-open-url` for https) + license + disabled
// "View changelog…" (enables with MYND-119).
//
// Penpot canon: `🔴 screen------settings--about` (frame id
// `9fb59646-2811-8082-8007-fd4c5a602b46`).

import type { CSSProperties, ReactNode } from "react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { Button } from "../primitives/Button";
import {
  BLOCK_STYLE,
  HELPER_STYLE,
  LABEL_STYLE,
  PANEL_ROOT_STYLE,
} from "./panel-styles";

const THREAT_MODEL_URL = "https://myne.md/threat-model";

const VERSION_TITLE_STYLE: CSSProperties = {
  fontSize: "var(--text-lg)",
  fontWeight: "var(--weight-semibold)" as CSSProperties["fontWeight"],
  color: "var(--fg-1)",
  margin: 0,
  lineHeight: 1.2,
};

const VERSION_SUBTITLE_STYLE: CSSProperties = {
  fontSize: "var(--text-sm)",
  color: "var(--fg-3)",
  margin: 0,
};

const VALUE_STYLE: CSSProperties = {
  fontSize: "var(--text-sm)",
  color: "var(--fg-2)",
  margin: 0,
};

const LINK_STYLE: CSSProperties = {
  fontSize: "var(--text-sm)",
  color: "var(--accent)",
  textDecoration: "underline",
  background: "none",
  border: 0,
  padding: 0,
  cursor: "pointer",
  fontFamily: "inherit",
  display: "inline-flex",
  alignItems: "center",
  gap: 4,
  alignSelf: "flex-start",
};

const LICENSE_BODY_STYLE: CSSProperties = {
  fontSize: "var(--text-sm)",
  lineHeight: "var(--leading-normal)",
  color: "var(--fg-2)",
  margin: 0,
};

function Block({ children }: { children: ReactNode }) {
  return <div style={BLOCK_STYLE}>{children}</div>;
}

function handleThreatModelClick() {
  openUrl(THREAT_MODEL_URL).catch((err) => {
    if (import.meta.env.DEV) {
      console.warn("AboutPanel: openUrl(threat-model) rejected", err);
    }
  });
}

export function AboutPanel() {
  const buildChannelLabel =
    import.meta.env.MODE === "development" ? "Development build" : "Stable";

  return (
    <div style={PANEL_ROOT_STYLE}>
      <Block>
        <h3 style={VERSION_TITLE_STYLE}>Myne {__APP_VERSION__}</h3>
        <p style={VERSION_SUBTITLE_STYLE}>Pre-alpha · Phase 1 desktop client</p>
      </Block>

      <Block>
        <span style={LABEL_STYLE}>Build channel</span>
        <p style={VALUE_STYLE}>{buildChannelLabel}</p>
      </Block>

      <Block>
        <span style={LABEL_STYLE}>Threat model</span>
        <button
          type="button"
          onClick={handleThreatModelClick}
          style={LINK_STYLE}
        >
          myne.md/threat-model
          <span aria-hidden="true">↗</span>
        </button>
        <p style={HELPER_STYLE}>
          Open the public threat-model document in your browser.
        </p>
      </Block>

      <Block>
        <span style={LABEL_STYLE}>License</span>
        <p style={LICENSE_BODY_STYLE}>
          Pre-alpha · CC0 docs · AGPL-3.0 application code on Phase 1 release.
        </p>
      </Block>

      <Block>
        <span style={LABEL_STYLE}>Changelog</span>
        <div>
          <Button variant="secondary" disabled>
            View changelog…
          </Button>
        </div>
        <p style={HELPER_STYLE}>
          Per-version notes. Will appear when MYND-119 lands.
        </p>
      </Block>
    </div>
  );
}
