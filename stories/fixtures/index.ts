// Named, composable fixtures for the story catalogue (myne-md/myne#832).
//
// A fixture is the canned `invoke` data that makes a state reachable. Situations
// that recur (no vault, locked, unlocked, sync paused) live here once and are
// referenced by name from a story descriptor, so two stories in the same
// situation share one handler table rather than duplicating it.
//
// Everything here is SYNTHETIC. No fixture may carry a recovery phrase or a real
// account number; `tests/stories/fixtures.test.ts` rejects both, and
// `scripts/check-stories-bundle.mjs` re-checks the built bundle for the same pair
// (a hand-authored fixture is exactly how a secret would reach a served page).

import type { Fixture } from "../src/types";
import type { VaultSummary } from "@app/types/vault-summary";

/** A vault id that is obviously a fixture, never a real one. */
export const FIXTURE_VAULT_ID = "00000000-0000-7000-8000-000000000001";

function vault(overrides: Partial<VaultSummary> = {}): VaultSummary {
  return {
    id: FIXTURE_VAULT_ID,
    status: { kind: "Exists" },
    label: null,
    icon: null,
    last_unlock: null,
    // Local-only by default: a fixture vault has no sync server behind it unless
    // a story says otherwise, and `VaultSummary.published` is required (the
    // picker distinguishes a joined vault from one made on this device).
    published: false,
    ...overrides,
  };
}

/** Builds a fixture whose `vault_list` / `vault_slot_kind` answer with one vault. */
function withVault(slot: string, prefs: Record<string, unknown> = {}): Fixture {
  return {
    description: `one vault on disk, runtime slot "${slot}"`,
    handlers: {
      "plugin:vault-unlock|vault_list": () => [vault()],
      "plugin:vault-unlock|vault_slot_kind": () => slot,
      "plugin:prefs|prefs_read": () => prefs,
      // A vault-backed story may mount a settings surface, and `AboutPanel` reads
      // this as a boolean: unanswered, the benign `[]` default is not `null`, so
      // its toggle rendered `aria-checked=""` on a `role="switch"`
      // (myne-md/myne#845). The real command returns a bool.
      "plugin:update|update_get_auto_check": () => true,
    },
  };
}

/** No vault on disk at all: the first-run / welcome situation. */
export const NO_VAULT: Fixture = {
  description: "no vault on disk",
  handlers: {
    "plugin:vault-unlock|vault_list": () => [],
    "plugin:vault-unlock|vault_slot_kind": () => "Empty",
    "plugin:prefs|prefs_read": () => ({}),
  },
};

/** One vault on disk, locked: the unlock situation. */
export const LOCKED: Fixture = withVault("Empty");

/** One vault, unlocked, default prefs: the editor situation. */
export const UNLOCKED: Fixture = withVault("Unlocked");

/** One vault on disk whose `vault.meta` does not parse. */
export const CORRUPT_META: Fixture = {
  description: "one vault on disk whose vault.meta is unreadable",
  handlers: {
    "plugin:vault-unlock|vault_list": () => [vault({ status: { kind: "Corrupted" } })],
    "plugin:vault-unlock|vault_slot_kind": () => "Empty",
    "plugin:prefs|prefs_read": () => ({}),
  },
};

/** Every named fixture, keyed by the name a story references. */
export const FIXTURES: Record<string, Fixture> = {
  "no-vault": NO_VAULT,
  locked: LOCKED,
  unlocked: UNLOCKED,
  "corrupt-meta": CORRUPT_META,
};

/** Resolve a story's `fixture` field (a name or an inline fixture) to a fixture. */
export function resolveFixture(
  fixture: string | Fixture | undefined,
): Fixture | undefined {
  if (fixture === undefined) return undefined;
  if (typeof fixture === "string") {
    const named = FIXTURES[fixture];
    if (!named) {
      throw new Error(
        `Unknown fixture "${fixture}". Known fixtures: ${Object.keys(FIXTURES).join(", ")}.`,
      );
    }
    return named;
  }
  return fixture;
}

/**
 * The full default `vault.prefs` payload, mirroring `PrefsView::default()`.
 * A panel that reads a pref field needs the whole object: a fixture answering
 * `prefs_read` with `{}` leaves every field a panel reads `undefined`.
 */
export const DEFAULT_PREFS: Record<string, unknown> = {
  screen_capture_protection: true,
  show_note_timestamps: true,
  reminders_enabled: true,
  reminder_horizon_days: null,
  show_task_marker: true,
  transcription_enabled: true,
  deliberate_folders: [],
  ai_enabled: false,
  attachment_compression_enabled: true,
  attachment_ocr_enabled: true,
  ai_excluded_folders: [],
  developer_mode: false,
  chat_history_budget: null,
  archived_folders: [],
  auto_lock_seconds: null,
  auto_tag_enabled: false,
  ai_provider: null,
  ai_provider_consent: null,
  ai_provider_model: null,
  active_workspace: null,
  custom_theme: null,
  daily_date_format: null,
  daily_folder: null,
  daily_template: null,
  periodic_notes: {},
  favorites: [],
  item_order: {},
  editor_layout: null,
  date_format: null,
  time_format: null,
  timezone: null,
  editor_content_width: null,
  editor_default_view_mode: null,
  editor_focus_dim_inactive: null,
  editor_focus_typewriter: null,
  editor_font_family: null,
  editor_line_spacing: null,
  editor_text_size: null,
  editor_line_numbers: null,
  editor_vim_mode: null,
  archive_disabled: null,
  cli_enabled: false,
  cli_excluded_folders: [],
  cli_rate_limit_disabled: null,
  theme: null,
  folder_icons: {},
  folder_notes_enabled: false,
  device_names: {},
  hidden_bar_items: [],
  bar_items_order: [],
  color_groups: [],
  right_panel_active_tab: null,
  right_panel_hidden_tabs: [],
  right_panel_tab_order: [],
  editor_toolbar_order: [],
  editor_toolbar_hidden: [],
  editor_slash_order: [],
  editor_slash_hidden: [],
  item_colors: {},
  keymap: {},
  label: null,
  icon: null,
  last_backup_at: null,
  new_note_location: null,
  new_note_location_folder: null,
  startup_open: null,
  startup_open_note: null,
  spell_enabled: null,
  spell_languages: [],
  saved_views: [],
  view_order: [],
  ribbon_items: null,
  ribbon_visible: true,
  // The four fields this object was missing, found by the accessibility gate
  // rather than by reading it (myne-md/myne#845): a panel whose switch read one
  // of them received `undefined` and rendered a `role="switch"` with no
  // `aria-checked`, which is a required attribute. The claim above. That this
  // mirrors `PrefsView::default()`. Was false by these four, and the defaults
  // below are theirs, copied from `protocol/src/prefs.rs`.
  field_clocks: {},
  paired_extensions: [],
  ai_provider_key: null,
  meeting_ai_prompt: null,
};
;
