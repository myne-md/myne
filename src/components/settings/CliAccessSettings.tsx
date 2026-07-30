// Settings → Privacy → Terminal access (cli-thin-client task 12, MYND-490).
//
// The user-facing surface of the CLI door: the default-off toggle, the folder
// exclusion list, the rate-limit removal control, and a last-access line.
//
// # Privacy is its home, and that was the open question
//
// The task called the panel placement open and the PRD recommended Privacy.
// Privacy it is: this is an ACCESS GATE onto already-decrypted notes, which is
// the same shape as screen-capture protection and auto-lock sitting beside it.
// It is deliberately NOT Account, where "Connected extensions" lives — that
// block pairs a separately-distributed application across a trust boundary
// (TB10), whereas the `myne` sidecar ships inside this bundle, under this
// bundle's own signature, and is never paired with anything.
//
// # The copy is the load-bearing part
//
// Bounds come from `docs/threat-model.md` §7's entry for this door (written
// first, as task 1, precisely so the copy could not outrun it) and they are
// tight:
//
//   - Enabling MUST state the consequence plainly: while the door is open, any
//     program running as the same OS user can drive the CLI and read
//     everything in scope. There is no identity gatekeeper — no token, no
//     peer-PID check, no signature check — because each is defeated by
//     construction by a program already running as that user.
//   - The rate limit MUST NOT be called a protection, and removing it MUST NOT
//     be described as disabling one. The second claim is worse than the first:
//     it implies a protection was there. `cli_bridge/rate_limit.rs`'s own
//     opening paragraph is binding on every string here.
//   - Deletion over the socket is prohibited outright, so the copy says reads
//     and writes and does not imply otherwise.
//
// # i18n, not `load-bearing-copy.ts`
//
// Task 12's acceptance criteria require every string through the i18n catalog.
// That is the opposite discipline from `src/lib/load-bearing-copy.ts` (which is
// deliberately un-translated and E2E-pinned by literal equality), and the
// criterion wins: this copy has to be *correct in the user's language*, and a
// bound stated only in English is a bound most users never read. What keeps it
// honest across locales is the threat-model entry above plus review, the same
// as every other translated privacy string.

import { useEffect, useState, type CSSProperties } from "react";
import { useTranslation } from "react-i18next";
import { normalizeFolderPath } from "../../dialect/folderPath";
import {
  readCliAccessState,
  UNKNOWN_CLI_ACCESS_STATE,
  type CliAccessState,
} from "../../lib/cli-access";
import { Switch } from "../primitives/Switch";
import {
  BLOCK_STYLE,
  FOLDER_TEXTAREA_STYLE,
  HELPER_STYLE,
  LABEL_STYLE,
  TOGGLE_ROW_STYLE,
} from "./panel-styles";

// The one `export PATH=…` line the user adds themselves. Mono + selectable;
// the app does not edit shell profiles (`path_shim` rule 3), so this is the
// whole remedy and it has to be copyable.
const CODE_LINE_STYLE: CSSProperties = {
  display: "block",
  marginTop: "var(--space-1)",
  padding: "var(--space-2)",
  fontFamily: "var(--font-mono)",
  fontSize: 13,
  color: "var(--fg-2)",
  background: "var(--paper-2)",
  border: "1px solid var(--line-1)",
  borderRadius: "var(--radius-1)",
  overflowX: "auto",
  userSelect: "text",
};

const MINUTE = 60;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/**
 * How long ago the door was last used, as one sentence.
 *
 * Coarse on purpose — minutes, hours, days, never a timestamp. The Rust side
 * hands over an age rather than a clock reading (see `cli_bridge::activity`),
 * and an age is the weaker fact: it cannot be correlated the way "the CLI ran
 * at 14:02:11" in a screenshot or a support log could.
 */
export function lastUsedLabel(
  secsAgo: number | null,
  t: (key: string, opts?: Record<string, unknown>) => string,
): string {
  if (secsAgo === null) return t("settings.cliAccess.lastUsedNever");
  if (secsAgo < MINUTE) return t("settings.cliAccess.lastUsedJustNow");
  if (secsAgo < HOUR)
    return t("settings.cliAccess.lastUsedMinutesAgo", {
      count: Math.floor(secsAgo / MINUTE),
    });
  if (secsAgo < DAY)
    return t("settings.cliAccess.lastUsedHoursAgo", {
      count: Math.floor(secsAgo / HOUR),
    });
  return t("settings.cliAccess.lastUsedDaysAgo", {
    count: Math.floor(secsAgo / DAY),
  });
}

/**
 * Split a textarea buffer into the canonical folder set the backend expects.
 *
 * The trailing slash is LOAD-BEARING, not cosmetic. `cli_excluded_folders`
 * entries are compared against a note's frontmatter `folder:` — always in
 * canonical trailing-slash form — by `folder_scope::folder_is_excluded`, and
 * that predicate deliberately refuses to treat a slash-less entry as a nesting
 * prefix (its `trailing_slash_on_the_excluded_entry_bounds_the_prefix_match`
 * test pins the refusal, so a stray entry can never become a wildcard over
 * every folder sharing its opening letters). So a raw `Private` typed here
 * matches NOTHING: the door stays wide open on the folder the user just tried
 * to close, silently and with the setting visibly saved. `normalizeFolderPath`
 * is the same canonicalizer the note writer itself uses
 * (`dialect/src/folderPath.ts`, mirrored Rust-side by
 * `cli_bridge::compose::normalize_folder_path`), so both ends of the comparison
 * are normalized by one rule rather than by two that can drift.
 *
 * Caught by the cli5 E2E scenario (`e2e/cli-thin-client.e2e.ts`), which types
 * the un-slashed form a user actually types.
 */
export function foldersFromDraft(draft: string): string[] {
  return draft
    .split("\n")
    .map((line) => normalizeFolderPath(line.trim()))
    .filter((folder): folder is string => folder !== null);
}

/**
 * How often the session state is re-read while the panel is open. Matches the
 * app's existing relative-time tick (`notes/components/relativeTime.ts`), so
 * the last-access line ages at the same cadence as every other "x ago" in the
 * UI. One argument-free atomic read per interval.
 */
const POLL_MS = 30_000;

interface CliAccessSettingsProps {
  /** `cli_enabled` — the door itself. Off by default. */
  enabled: boolean;
  /** `cli_excluded_folders` — folders the door never reaches. */
  excludedFolders: string[];
  /** `cli_rate_limit_disabled` — `null` means unset, i.e. the limit applies. */
  rateLimitDisabled: boolean | null;
  onSetEnabled: (next: boolean) => void;
  onSetExcludedFolders: (folders: string[]) => void;
  onSetRateLimitDisabled: (next: boolean) => void;
}

export function CliAccessSettings({
  enabled,
  excludedFolders,
  rateLimitDisabled,
  onSetEnabled,
  onSetExcludedFolders,
  onSetRateLimitDisabled,
}: CliAccessSettingsProps) {
  const { t } = useTranslation();
  // Local edit buffer for the folder textarea (one per line); the backend
  // NFC-sorts and dedups the set on encode, so raw lines are fine.
  const [excludedDraft, setExcludedDraft] = useState<string>(() =>
    excludedFolders.join("\n"),
  );
  const [state, setState] = useState<CliAccessState>(UNKNOWN_CLI_ACCESS_STATE);

  // Session state: read on mount, then on a slow tick so the age stays current
  // and a command that arrives while Settings is open shows up. A non-Tauri
  // context (dev, unit tests) rejects — degrade to "claims nothing", never
  // throw inside a Settings panel.
  useEffect(() => {
    let alive = true;
    const read = () => {
      readCliAccessState()
        .then((next) => {
          if (alive) setState(next);
        })
        .catch(() => {
          if (alive) setState(UNKNOWN_CLI_ACCESS_STATE);
        });
    };
    read();
    const handle = setInterval(read, POLL_MS);
    return () => {
      alive = false;
      clearInterval(handle);
    };
  }, []);

  const commitExcluded = () => onSetExcludedFolders(foldersFromDraft(excludedDraft));

  // The door is open but the shell cannot find the command — the ordinary
  // macOS case, where `~/.local/bin` is not on `$PATH` by default. Only shown
  // when there is a real directory to point at.
  const showPathHint = enabled && !state.commandOnPath && state.shimDir !== null;

  return (
    <>
      <div
        style={BLOCK_STYLE}
        data-setting-anchor="privacy.cli-access"
        data-testid="settings.cli-access"
        data-enabled={String(enabled)}
      >
        <div style={TOGGLE_ROW_STYLE}>
          <span style={LABEL_STYLE}>{t("settings.cliAccess.label")}</span>
          <Switch
            checked={enabled}
            onChange={onSetEnabled}
            ariaLabel={t("settings.cliAccess.label")}
            ariaDescribedBy="cli-access-helper"
            testId="settings.cli-access-toggle"
          />
        </div>
        <p id="cli-access-helper" style={HELPER_STYLE}>
          {enabled
            ? t("settings.cliAccess.helperOn")
            : t("settings.cliAccess.helperOff")}
        </p>
        {enabled && (
          <p style={HELPER_STYLE} data-testid="settings.cli-access-last-used">
            {lastUsedLabel(state.lastUsedSecsAgo, t)}
          </p>
        )}
        {showPathHint && (
          <div data-testid="settings.cli-access-path-hint">
            <p style={HELPER_STYLE}>{t("settings.cliAccess.notOnPathHint")}</p>
            <code style={CODE_LINE_STYLE}>
              {t("settings.cliAccess.pathLine", {
                dir: state.shimDir,
                // The value is a filesystem path rendered inside <code>; HTML
                // entity escaping would corrupt a directory containing an
                // ampersand or a quote into something that does not work when
                // pasted into a shell.
                interpolation: { escapeValue: false },
              })}
            </code>
          </div>
        )}
      </div>

      {/* Exclusions stay editable with the door shut, on purpose: configuring
          them first and opening the door second is the safer order, and
          greying them out would force the reverse — open wide, then narrow. */}
      <div
        style={BLOCK_STYLE}
        data-setting-anchor="privacy.cli-excluded-folders"
        data-testid="settings.cli-exclusions"
        // A COUNT, never the names: this attribute exists so an E2E scenario can
        // see that its typed exclusion registered, and a folder name in a
        // `data-*` would put vault content into every screenshot and CI failure
        // artefact (src/CLAUDE.md "Test observability"). Reflects the OPTIMISTIC
        // prop — `usePrefs` updates local state before the `vault.prefs` write
        // resolves — so it proves the edit was accepted, NOT that it is on disk.
        // The on-disk fact is observable only through the door itself.
        data-folder-count={String(excludedFolders.length)}
      >
        <label style={LABEL_STYLE} htmlFor="cli-excluded-folders">
          {t("settings.cliAccess.excludedLabel")}
        </label>
        <textarea
          id="cli-excluded-folders"
          data-testid="settings.cli-excluded-folders"
          value={excludedDraft}
          onChange={(e) => setExcludedDraft(e.target.value)}
          onBlur={commitExcluded}
          rows={3}
          spellCheck={false}
          placeholder={t("settings.cliAccess.excludedPlaceholder")}
          style={FOLDER_TEXTAREA_STYLE}
        />
        <p style={HELPER_STYLE}>{t("settings.cliAccess.excludedHelper")}</p>
      </div>

      <div
        style={BLOCK_STYLE}
        data-setting-anchor="privacy.cli-rate-limit"
        data-testid="settings.cli-rate-limit"
        // `null` (unset) and `false` both mean "the limit applies", which is why
        // this reflects the tri-state as the same boolean the Switch shows
        // rather than stringifying the raw prop.
        data-limit-removed={String(rateLimitDisabled === true)}
      >
        <div style={TOGGLE_ROW_STYLE}>
          <span style={LABEL_STYLE}>{t("settings.cliAccess.rateLimitLabel")}</span>
          <Switch
            checked={rateLimitDisabled === true}
            onChange={onSetRateLimitDisabled}
            ariaLabel={t("settings.cliAccess.rateLimitLabel")}
            ariaDescribedBy="cli-rate-limit-helper"
            testId="settings.cli-rate-limit-toggle"
          />
        </div>
        <p id="cli-rate-limit-helper" style={HELPER_STYLE}>
          {t("settings.cliAccess.rateLimitHelper")}
        </p>
      </div>
    </>
  );
}
