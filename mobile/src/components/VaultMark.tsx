// `<VaultMark>` — the square mark shown at the lead of every vault-identity
// surface (app header, sidebar header, switcher rows). Renders the vault's
// chosen icon glyph (vault-icons) when one is set — a curated
// `FOLDER_ICON_PATHS` name projected from `PrefsView.icon` or
// `VaultSummary.icon` — otherwise the neutral `MyneMark` wordmark.
//
// Two invariants worth keeping:
//
//   1. The unknown-name guard lives HERE, not in `FolderGlyph`. `FolderGlyph`
//      returns `null` for a name it does not know, so delegating the check to it
//      would draw an EMPTY ink square rather than falling back to the wordmark.
//      A name can be unknown legitimately: `icon` is `Shared(ScalarLww)`, so a
//      newer client's glyph reaches this build before this build knows it.
//   2. The wordmark branch draws `MyneMark` VERBATIM, so a vault with no icon
//      renders exactly what it rendered before vault-icons existed.
//
// `MyneMark` itself is deliberately left alone: it is the BRAND mark (welcome,
// unlock, onboarding, picker), not a per-vault avatar, and giving it an `icon`
// prop would pull the glyph table into a module every flow imports.

import { FolderGlyph } from "./FolderGlyph";
import { MyneMark } from "./Icon";
import { FOLDER_ICON_PATHS } from "@myne/decorations/folderIcons";

export function VaultMark({
  icon,
  size = 22,
  radius,
  testId,
}: {
  icon: string | null;
  size?: number;
  radius?: number;
  testId?: string;
}) {
  // Same radius default as `MyneMark` (Icon.tsx), so the two branches cannot
  // drift into different corner geometry.
  const r = radius ?? Math.round(size * 0.19);
  const hasGlyph = icon !== null && icon in FOLDER_ICON_PATHS;
  return (
    <span
      aria-hidden="true"
      data-testid={testId}
      // Test observability: the resolved glyph name, or "wordmark" for the
      // neutral fallback. Safe to expose where a `data-label` would not be — the
      // value is a curated closed-set name, never the user's own text.
      data-icon={hasGlyph ? icon : "wordmark"}
      style={
        hasGlyph
          ? {
              width: size,
              height: size,
              flexShrink: 0,
              borderRadius: r,
              background: "var(--ink-1)",
              color: "var(--paper)",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
            }
          : { display: "flex", flexShrink: 0 }
      }
    >
      {hasGlyph ? (
        <FolderGlyph name={icon} size={Math.round(size * 0.64)} />
      ) : (
        <MyneMark size={size} radius={r} />
      )}
    </span>
  );
}
