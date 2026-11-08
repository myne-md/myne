#!/usr/bin/env node
// The settings-parity projection and its guard (myne-md/myne#880).
//
// # The failure this prevents
//
// Desktop and mobile share one `vault.prefs` blob, so a phone that cannot author
// a value inherits whatever a computer last set. Measured on `develop` at
// `c2e2b8e1` (2026-10-15): of the 76 `#[tauri::command]`s in
// `core/src/plugins/prefs/commands.rs`, 43 were surfaced on both clients, 31 on
// desktop only, and 2 had no UI anywhere. Mobile wrapped 58 of the 76.
//
// NOTHING compared the two clients' settings surfaces, and the two guards that
// look like they might cannot:
//
//   * `scripts/check-twin-inventory.mjs` pairs same-relative-path twins, and the
//     desktop settings modules live under `src/components/settings/` while
//     mobile's live in `mobile/src/app/flows/SettingsSheet.tsx`, so it pairs
//     none of them.
//   * `scripts/check-ipc-binding-callers.mjs` answers "does this binding have a
//     caller, on this client". It can never answer "does desktop have a setting
//     mobile lacks", which is the question the 31 rows are.
//
// # What the projection is
//
// `docs/dev/settings-parity.md` is GENERATED (`--emit`) and holds one row per
// Rust command: the §10.2 merge class, what each client does with it, and, for
// every row that is not `both`, a written reason from `scripts/prefs-parity.json`.
//
// It closes with a second, smaller record: the desktop-only settings surfaces
// that have no mobile counterpart (`DESKTOP_ONLY_PANELS`). A surface is not a
// command, so the rows cannot carry that statement, and without it a later
// parity audit re-derives "does mobile need a Files panel" from scratch.
//
// **The denominator is the RUST command roster, never a client's wrapper list.**
// A denominator derived from a client is a denominator blind to that client: the
// 18 commands mobile never binds would simply not be rows. This is the whole
// reason the guard reads `commands.rs` rather than `prefs.ts`.
//
// # Three states per client, not a boolean
//
// `called` (wrapped, and a production UI call site reaches it), `bound-no-caller`
// (wrapped and unreachable, which is a live defect: the sheet can render a
// control whose write path nothing calls) and `never-bound` (never wrapped).
// The remedy differs per state, so collapsing them into "surfaced / not
// surfaced" would lose the distinction that matters.
//
// A fourth state is DECLARED rather than measured: `deliberately-absent`, for a
// control that exists on a client and is deliberately not usable there (the
// spell row on mobile, whose backend the client does not ship). The guard cannot
// read intent out of the tree, so `DELIBERATELY_ABSENT_ON` in this file carries
// it, beside `DESKTOP_ONLY_PANELS` and for the same reason: a decision the guard
// holds must survive a fresh `--record`, and a decision kept in the record is
// exactly what that re-baseline rewrites. It is checked both ways: a deliberate
// absence whose client has stopped reaching the command is stale, because the
// declaration then describes a control that is not there. That state is why the
// verdict is not a boolean: `bound-no-caller`, `never-bound` and
// `deliberately-absent` are three different remedies.
//
// # The recorded state, because the verdict collapses three remedies
//
// The verdict alone cannot tell a row that is one-sided for one reason from a
// row that is one-sided for another, and it does not move when a `called`
// binding decays to `bound-no-caller` while the other client was already not
// reaching the command. So the record carries each row's MEASURED `desktop` and
// `mobile` state as well, and `reasonsCheck` compares that state BOTH ways: a
// recorded state whose row has moved fails naming the drift, and a one-sided row
// with no recorded state fails as unrecorded. Without it, a desktop-only row
// whose binding dies becomes `no-ui`, its reason still applies, the ratchet is
// unmoved, and every other arm stays green over a live defect.
//
// The caller decision is IMPORTED from `check-ipc-binding-callers.mjs`, along
// with the tree read, rather than restated: a second copy of "what counts as a
// caller" is a second copy that can drift.
//
// # Both directions, because one-directional is the trap
//
//   * a one-sided row with no reason: a gap nobody has written down. Fails
//     naming the command.
//   * a reason whose command has CONVERGED (both clients now surface it) or left
//     the roster: a claim about a state that no longer exists. Fails naming it,
//     the arm `check-twin-inventory.mjs` has for its own roster.
//   * a reason that is empty, too short, or the `--record` placeholder.
//
// # The record is a ratchet, and its own writer is the half nobody tests
//
// `--record` writes the CURRENT one-sided set and REFUSES when that set has
// GROWN, so the command the failure message suggests cannot be used to make a
// regression go away. The seed path is the one exception, and it does not
// license anything either: a fresh `--record` fills every entry with
// `PLACEHOLDER`, which the reason check rejects BY NAME, so a baseline written
// blind fails the very next `--check` until a human replaces each one. Its
// one-sided set is taken with `DELIBERATELY_ABSENT_ON` applied, so a row whose
// one-sidedness is a decision rather than a measurement is seeded too instead of
// being silently dropped. That is the `check-ipc-binding-callers.mjs` lesson
// mechanised: a guard whose writer seeds a string its own reader accepts is
// green over a record that says nothing.
//
// # Why the projection lives under docs/dev/
//
// It is a `docs/**` file a docs-only commit can hand-edit, which is why its CI
// gate carries no `code-paths` filter, exactly as `twin-inventory` does. See
// `.woodpecker/main.yml`.
//
// Zero dependencies, hand-runnable:
//   node scripts/check-prefs-parity.mjs [--emit|--check|--record]

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { deadBindings, readTree } from "./check-ipc-binding-callers.mjs";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const COMMANDS_RS = "core/src/plugins/prefs/commands.rs";
const CLASSIFICATION_RS = "core/src/plugins/sync/prefs_classification.rs";
const DESKTOP_PREFS = "src/lib/prefs.ts";
const MOBILE_PREFS = "mobile/src/lib/prefs.ts";

/**
 * The generated projection's path, overridable for the same reason the record's
 * is (see below): the `--check` staleness arm can only be driven by a test if the
 * test can point it at a doctored copy. Restoring a doctored COMMITTED file after
 * the run is the alternative, and it leaves the file wrong when the run is
 * interrupted.
 */
const PROJECTION = process.env.MYNE_PREFS_PARITY_PROJECTION
  ? resolve(process.env.MYNE_PREFS_PARITY_PROJECTION)
  : resolve(REPO, "docs/dev/settings-parity.md");

/**
 * The projection's path RELATIVE to the repo, for the messages a failure prints
 * (a test points the override at a scratch file, and a scratch absolute path in
 * the message would be noise).
 */
const PROJECTION_LABEL = "docs/dev/settings-parity.md";

/**
 * The record's path, overridable so a test can drive the seed path and the
 * refusal without touching the committed file.
 *
 * `check-mobile-export-backup.mjs`'s `MYNE_CLIPPER_DIR` is the precedent: an
 * absent-input branch is not exercisable on a machine that has the input.
 */
const RECORD = process.env.MYNE_PREFS_PARITY_RECORD
  ? resolve(process.env.MYNE_PREFS_PARITY_RECORD)
  : resolve(REPO, "scripts/prefs-parity.json");

/**
 * The minimum number of Rust prefs commands this guard must EXAMINE.
 *
 * Kept here rather than in the JSON, deliberately, following
 * `check-twin-drift-ratchet.mjs`'s `EXAMINED_FLOOR`: the JSON records which
 * commands are one-sided, and this records what the gate may never stop
 * covering. Without it the recorded set is shrinkable for free by deleting
 * commands from the Rust roster, which would read as progress. 76 is the roster
 * as of myne-md/myne#880; lowering it is a claim that the prefs surface shrank,
 * which needs an argument in the commit rather than a number edit.
 */
export const COMMAND_FLOOR = 76;

/**
 * The desktop-only settings surfaces that have no mobile counterpart, each with
 * the reason it stays desktop-only (myne-md/myne#880 task 12).
 *
 * **A surface is not a command**, which is why these are not rows in the table
 * above: the commands those surfaces own are already rows, and what the rows
 * cannot carry is the surface-level statement. Without it a later parity audit
 * re-derives "does mobile need a Files panel" from scratch, and the answer is a
 * decision rather than a measurement. Five entries are rail panels and one
 * (`cli`) is a block inside a panel rather than a panel of its own.
 *
 * The six are the PRD's own list. `vault` is deliberately NOT here: desktop
 * keeps the vault-scoped controls inside Account's own topic, and mobile
 * promotes them to a root category of their own, so the group has a mobile
 * counterpart even though desktop has no rail panel named Vault.
 *
 * Each entry's `panel` is checked against desktop's `PANELS_BASE`
 * (`src/components/SettingsModal.tsx`), so a renamed panel fails by name rather
 * than leaving a reason describing something that moved. `cli` carries a `home`
 * instead, because on desktop it is a BLOCK inside Privacy rather than a rail
 * panel (the 0693 entry records the terminal joining Privacy's `Access`); its
 * home file must exist, which is the same anti-rot check one level down.
 */
export const DESKTOP_ONLY_PANELS = [
  {
    panel: "files",
    reason:
      "Note storage and startup behaviour: where the vault lives on disk, which note opens at launch, and the attachment OCR switch. Mobile has no on-disk vault folder to open (its container is the app's own storage), no cold-start note choice, and its OCR switch now lives in the Data panel, so the panel itself has no mobile counterpart.",
  },
  {
    panel: "hotkeys",
    reason:
      "Keyboard bindings. A phone has no hardware-keyboard surface in the app, and the keymap pref is already recorded desktop-only above, so there is nothing for this panel to configure on mobile.",
  },
  {
    panel: "storage",
    reason:
      "The vault's on-disk location, backup and restore, and the Obsidian import and PDF export flows. Mobile's whole-vault markdown export lives in the Data panel and its restore flow is an honest not-available-yet stub, so the panel has no mobile counterpart.",
  },
  {
    panel: "network",
    reason:
      "The device-local Tor-routing toggle. Mobile has no Tor routing yet (the Privacy residual sentence says so), so the switch would gate nothing on a phone.",
  },
  {
    panel: "cli",
    home: "src/components/settings/PrivacyPanel.tsx",
    reason:
      "Terminal access to the running desktop over its local command socket. On desktop it is a block inside Privacy rather than a panel of its own, and there is nothing on a phone for it to gate, so the block is desktop-only and the three cli prefs commands are recorded desktop-only above.",
  },
  {
    panel: "transcription",
    reason:
      "The on-device transcription switch, whose control already lives inside mobile's Privacy panel rather than a panel of its own, so the panel is desktop-only while the pref is surfaced on both clients.",
  },
];

/** The desktop rail's panel ids, read from `PANELS_BASE`. */
export function parseDesktopPanels(tsx) {
  const out = new Set();
  for (const m of tsx.matchAll(/\{\s*id:\s*"([a-z-]+)"/g)) out.add(m[1]);
  return out;
}

/**
 * The both-directions verdict on the panel record: a named panel that is not in
 * desktop's rail is stale, and so is an empty reason.
 */
export function panelProblems({ named, desktopPanels, exists = existsSync }) {
  const out = [];
  for (const entry of named) {
    if (entry.home) {
      // A block inside a panel rather than a rail panel of its own. The home
      // file must exist, which is the anti-rot check one level down.
      if (!exists(join(REPO, entry.home))) {
        out.push(
          `DESKTOP_ONLY_PANELS entry '${entry.panel}' names home '${entry.home}', ` +
            `which does not exist. The reason describes a surface that moved.`,
        );
      }
    } else if (!desktopPanels.has(entry.panel)) {
      out.push(
        `DESKTOP_ONLY_PANELS names '${entry.panel}', which is not a panel in ` +
          `src/components/SettingsModal.tsx. The reason describes a surface that ` +
          `moved or was renamed.`,
      );
    }
    if (typeof entry.reason !== "string" || entry.reason.trim().length < MIN_REASON) {
      out.push(`DESKTOP_ONLY_PANELS entry '${entry.panel}' carries no real reason.`);
    }
  }
  return out;
}

/** What `--record` writes into every fresh entry. A sentinel, not a reason. */
export const PLACEHOLDER = "REASON REQUIRED";

/** The shortest reason the guard accepts, so "TODO" and "n/a" are refused. */
export const MIN_REASON = 40;

/**
 * Commands that write no `vault.prefs` FIELD at all, so the §10.2
 * classification table has no row for them: the blob read and the two probes.
 */
export const NO_FIELD = new Set(["prefs_read", "ai_provider_has_key", "device_platform"]);

/**
 * Commands whose field name is not `set_<field>`.
 *
 * Eight of the 76, and each is a real naming difference rather than an
 * oversight: a plural map (`saved_views`, `device_names`), a nested map
 * (`periodic_notes`), a unit conversion (`auto_lock_timeout` writes
 * `auto_lock_seconds`), an action verb (`upsert_`/`delete_` on one field) and
 * the two `vault_set_*` label/icon writers. Kept as an explicit table rather
 * than a fuzzy matcher, and compared BOTH ways below, so a renamed command
 * fails by name instead of silently mapping to nothing.
 */
export const FIELD_OVERRIDES = {
  set_keymap_binding: "keymap",
  // external-mcp-connection (myne-md/myne#923): two verbs over one map, like
  // the saved-views pair above. The command names carry the verb because the
  // host stamps the approval time and normalizes the name, so neither is a
  // plain whole-value write.
  rewrite_mcp_folder_paths: "mcp_connections",
  set_mcp_connection_grant: "mcp_connections",
  revoke_mcp_connection: "mcp_connections",
  // task 13: the queued out-of-scope writes. Accept writes `mcp_connections`
  // (it widens one grant by one folder) AND `mcp_write_requests` (it drops the
  // row); the parity row names the grant, because that is the field whose value
  // the user is deciding about, and the row removal is the bookkeeping beside it.
  accept_mcp_write_request: "mcp_connections",
  dismiss_mcp_write_request: "mcp_write_requests",
  upsert_saved_view: "saved_views",
  delete_saved_view: "saved_views",
  // view-manifests: the command acts on ONE view's approval, while the field is
  // the map it writes. Named here rather than renaming either side, because
  // `set_view_approval` reads as the action and `view_approvals` as the map.
  set_view_approval: "view_approvals",
  set_periodic_note_setting: "periodic_notes",
  // myne-md/myne#1037: one command writes the whole map, one entry per call, so
  // the command name is singular while the field name is not (the
  // set_periodic_note_setting precedent above).
  set_calendar_setting: "calendar_settings",
  set_auto_lock_timeout: "auto_lock_seconds",
  set_device_name: "device_names",
  vault_set_label: "label",
  vault_set_icon: "icon",
};

/** The command names declared by `#[tauri::command]` in `commands.rs`. */
export function parseCommands(rust) {
  const out = [];
  for (const m of rust.matchAll(
    /#\[tauri::command\]\s*pub\s+(?:async\s+)?fn\s+([a-z0-9_]+)/g,
  )) {
    out.push(m[1]);
  }
  return out;
}

/** The §10.2 table as `field -> "shared" | "device-local" | "metadata"`. */
export function parseClassification(rust) {
  const noComments = rust
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");
  const out = new Map();
  for (const m of noComments.matchAll(
    /"([a-z0-9_]+)"\s*,\s*PrefClass::(Shared|DeviceLocal|MergeMetadata)/g,
  )) {
    const cls = m[2] === "Shared" ? "shared" : m[2] === "DeviceLocal" ? "device-local" : "metadata";
    out.set(m[1], cls);
  }
  return out;
}

/**
 * `command -> exported binding name` for one client's prefs module.
 *
 * The literal must sit in a CALL position, not merely appear: a doc comment
 * naming `plugin:prefs|x` is not a binding, and a text scan that accepted one
 * would invent rows. `writePref` in either its plain or its generic form, and a
 * direct `invoke`, are the two shapes that occur.
 */
export function bindingsByCommand(ts) {
  const out = new Map();
  const re = /^export\s+(?:async\s+)?function\s+([A-Za-z0-9_$]+)/gm;
  const marks = [...ts.matchAll(re)].map((m) => ({ name: m[1], at: m.index }));
  const lit =
    /(?:writePref\s*(?:<[^()]*>)?\s*\(|invoke\s*<?[^(]*\(\s*)["'`]plugin:prefs\|([a-z0-9_]+)["'`]/;
  for (let i = 0; i < marks.length; i += 1) {
    const start = marks[i].at;
    const end = i + 1 < marks.length ? marks[i + 1].at : ts.length;
    const m = lit.exec(ts.slice(start, end));
    if (m) out.set(m[1], marks[i].name);
  }
  return out;
}

/**
 * The `vault.prefs` field a command writes, or `null` for a command that writes
 * none. Validation of the result is the caller's (see `mappingProblems`).
 */
export function fieldForCommand(command) {
  if (NO_FIELD.has(command)) return null;
  if (command in FIELD_OVERRIDES) return FIELD_OVERRIDES[command];
  return command.startsWith("set_") ? command.slice(4) : null;
}

/**
 * Every way the command -> field mapping can be wrong, in both directions.
 *
 * This is the half that makes the mapping a check rather than a claim: a new
 * command in the Rust roster fails here until it maps, a stale override fails,
 * and a field the §10.2 table does not carry fails by name rather than printing
 * an empty class cell.
 */
export function mappingProblems({ commands, classification }) {
  const out = [];
  const known = new Set(commands);
  for (const command of commands) {
    const field = fieldForCommand(command);
    if (field === null) {
      if (!NO_FIELD.has(command)) {
        out.push(
          `${command} maps to no vault.prefs field and is not in NO_FIELD. A new ` +
            `command lands with its field mapping in the same change, or the ` +
            `classification column is silently empty for it.`,
        );
      }
      continue;
    }
    if (!classification.has(field)) {
      out.push(
        `${command} maps to field '${field}', which ${CLASSIFICATION_RS} does ` +
          `not classify. Either the mapping is wrong or the §10.2 row is missing.`,
      );
    }
  }
  for (const command of Object.keys(FIELD_OVERRIDES)) {
    if (!known.has(command)) {
      out.push(`FIELD_OVERRIDES names '${command}', which is not a command in ${COMMANDS_RS}.`);
    }
  }
  for (const command of NO_FIELD) {
    if (!known.has(command)) {
      out.push(`NO_FIELD names '${command}', which is not a command in ${COMMANDS_RS}.`);
    }
  }
  return out;
}

/** What one client does with one command, as MEASURED from the tree.
 *
 * `deliberately-absent` is not here: it is a decision rather than a
 * measurement, and `applyDeliberate` layers it on from `DELIBERATELY_ABSENT_ON`. */
export function clientState(bound, path, command, dead) {
  const name = bound.get(command);
  if (!name) return "never-bound";
  return dead.has(`${path}:${name}`) ? "bound-no-caller" : "called";
}

/** The row verdict, derived from the two client states. */
export function parityVerdict(desktop, mobile) {
  const dc = desktop === "called";
  const mc = mobile === "called";
  if (dc && mc) return "both";
  if (!dc && !mc) return "no-ui";
  return dc ? "desktop-only" : "mobile-only";
}

/** One row per Rust command. Pure over its arguments, so the test can drive a
 *  synthetic roster without mutating the real tree.
 *
 * The states here are the MEASURED ones; `applyDeliberate` is what turns a
 * recorded decision into the fourth state. */
export function classifyRows({ commands, classification, desktop, mobile, dead }) {
  return commands.map((command) => {
    const d = clientState(desktop.bound, desktop.path, command, dead);
    const m = clientState(mobile.bound, mobile.path, command, dead);
    const field = fieldForCommand(command);
    return {
      command,
      field,
      class: field === null ? "-" : classification.get(field) ?? "unknown",
      desktop: d,
      mobile: m,
      verdict: parityVerdict(d, m),
    };
  });
}

/** The clients this guard knows, and the row field each one owns. */
export const CLIENT_FIELDS = { desktop: "desktop", mobile: "mobile" };

/**
 * The deliberate absences this guard DECLARES, keyed by command.
 *
 * A deliberate absence is a decision rather than a measurement, so it cannot be
 * read out of the tree. It lives here rather than in the reason record for the
 * same reason `DESKTOP_ONLY_PANELS` does: the record is the one thing `--record`
 * rewrites, and a fresh baseline that dropped the declaration would turn the row
 * back into `both` while every other check stayed green. Keeping it in code
 * makes it survive a re-baseline by construction.
 *
 * `set_spell_enabled` is the one entry. The spell control exists on mobile and is
 * deliberately not usable there, because the client ships no spell backend at all
 * (the host's `spell` slot is omitted, so no squiggle can ever be drawn) and the
 * row is gated rather than live. Its measured state is `called` on both clients,
 * which is why no measurement can carry the absence.
 *
 * A declaration for a command the roster does not carry, or for a client the
 * command does not reach, fails in `reasonsCheck`, so the list is compared both
 * ways rather than trusted.
 */
export const DELIBERATELY_ABSENT_ON = {
  set_spell_enabled: ["mobile"],
};

/** A record entry's reason text, whichever shape it was written in. */
export function entryReason(entry) {
  if (typeof entry === "string") return entry;
  if (entry && typeof entry === "object") return entry.reason;
  return undefined;
}

/**
 * Layer the declared deliberate absences onto the measured rows.
 *
 * Applied only where the measured state is `called`, so a declaration can never
 * invent an absence for a command the client does not reach: that direction is
 * `reasonsCheck`' job to report, and silently ignoring it here would make the
 * declaration a place a stale entry could hide.
 */
export function applyDeliberate(rows, marks = {}) {
  return rows.map((row) => {
    const clients = marks[row.command] ?? [];
    if (clients.length === 0) return row;
    const out = { ...row };
    for (const client of clients) {
      const field = CLIENT_FIELDS[client];
      if (field && out[field] === "called") out[field] = "deliberately-absent";
    }
    out.verdict = parityVerdict(out.desktop, out.mobile);
    return out;
  });
}

/**
 * The both-directions verdict on the reason record and the recorded states.
 *
 * `missing` is a one-sided row nobody has written down; `stale` is a reason
 * whose command is no longer one-sided; `unreasoned` is an entry whose text is
 * empty, too short, or the `--record` placeholder. `redundantDeliberate` is a
 * declared deliberate absence on a client that no longer reaches the command,
 * which is the same staleness one level down. `stateChanged` is a row whose
 * RECORDED measured state no longer matches the tree while the verdict stayed
 * one-sided, and `stateUnrecorded` is a one-sided row with no recorded state:
 * those two are the arm that catches a live defect the verdict cannot express.
 * All of them fail.
 */
export function reasonsCheck({ rows, reasons, states = {}, marks = {} }) {
  // The verdicts are computed with the deliberate absences APPLIED, because the
  // declaration is what decides them: a command declared deliberately absent on
  // a client is one-sided BECAUSE of that declaration, and validating the record
  // against the raw measurement would call the row the declaration created stale.
  const applied = applyDeliberate(rows, marks);
  const oneSided = applied.filter((r) => r.verdict !== "both").map((r) => r.command);
  const known = new Set(applied.map((r) => r.command));
  const recorded = Object.keys(reasons);
  const byCommand = new Map(rows.map((r) => [r.command, r]));
  const redundantDeliberate = [];
  const unknownClient = [];
  for (const [command, clients] of Object.entries(marks)) {
    const row = byCommand.get(command);
    for (const client of clients) {
      if (!(client in CLIENT_FIELDS)) {
        unknownClient.push(`${command} (${client})`);
        continue;
      }
      // Only a client that MEASURABLY reaches the command can be deliberately
      // absent on it. Anywhere else the declaration describes nothing.
      if (!row || row[CLIENT_FIELDS[client]] !== "called") {
        redundantDeliberate.push(`${client}:${command}`);
      }
    }
  }
  // The recorded state, so a row whose verdict stayed one-sided but whose
  // measurement moved is not silently accepted. `states[command]` is the
  // signature the record carries; the signature now is read off the MEASURED row
  // rather than the applied one, because the declaration is not a measurement.
  const stateChanged = [];
  const stateUnrecorded = [];
  for (const command of oneSided) {
    const row = byCommand.get(command);
    const now = row ? `${row.desktop}|${row.mobile}` : "gone";
    const was = states[command];
    if (was === undefined) {
      stateUnrecorded.push(command);
      continue;
    }
    if (was !== now) stateChanged.push(`${command} (${was} -> ${now})`);
  }
  return {
    oneSided,
    missing: oneSided.filter((c) => !(c in reasons)),
    stale: recorded.filter((c) => !oneSided.includes(c)),
    // Split out because the remedies differ: a reason whose command left the
    // roster is a different edit from one whose command converged.
    staleUnknown: recorded.filter((c) => !known.has(c)),
    unreasoned: recorded.filter((c) => {
      const why = entryReason(reasons[c]);
      return (
        typeof why !== "string" || why.trim().length < MIN_REASON || why.trim() === PLACEHOLDER
      );
    }),
    redundantDeliberate,
    unknownClient,
    stateChanged,
    stateUnrecorded,
  };
}

/**
 * A reason that would break the generated table's own syntax.
 *
 * A newline is the only character that can: `renderProjection` escapes pipes
 * through `esc`, so a reason may legitimately contain one.
 */
export function badReasonText(reasons) {
  return Object.entries(reasons)
    .filter(([, entry]) => typeof entryReason(entry) === "string" && /\n/.test(entryReason(entry)))
    .map(([c]) => c);
}

/**
 * The ratchet's verdict over an injected committed set and the measured one.
 *
 * A SET rather than a count: the case that happens is one command converging
 * while another diverges, which leaves a count unmoved.
 */
export function recordDecision({ committed, now }) {
  const rec = new Set(committed);
  const cur = new Set(now);
  return {
    grew: now.filter((c) => !rec.has(c)),
    shrank: committed.filter((c) => !cur.has(c)),
  };
}

function esc(text) {
  return String(text).replace(/\|/g, "\\|");
}

/** The generated document. Deterministic over `rows` and `reasons`. */
export function renderProjection(rows, reasons) {
  const tally = { both: 0, "desktop-only": 0, "mobile-only": 0, "no-ui": 0 };
  for (const r of rows) tally[r.verdict] += 1;
  const lines = [
    "<!-- GENERATED by scripts/check-prefs-parity.mjs --emit. Do not edit by hand:",
    "     the reasons live in scripts/prefs-parity.json, the denominator in",
    "     core/src/plugins/prefs/commands.rs, and this file is the projection of",
    "     the two. -->",
    "",
    "# Settings parity: every `vault.prefs` command, and which client surfaces it",
    "",
    `One row per \`#[tauri::command]\` in \`core/src/plugins/prefs/commands.rs\``,
    `(${rows.length} today), resolved against each client's \`prefs.ts\` bindings and`,
    "their production UI call sites. `Class` is the `sync-protocol.md` §10.2 merge",
    "classification, read from `core/src/plugins/sync/prefs_classification.rs`.",
    "",
    `**Verdicts:** ${tally.both} \`both\`, ${tally["desktop-only"]} \`desktop-only\`,`,
    ` ${tally["mobile-only"]} \`mobile-only\`, ${tally["no-ui"]} \`no-ui\`.`,
    "",
    "`called` means the client wraps the command and a production UI call site",
    "reaches it; `bound-no-caller` means the binding exists and nothing calls it,",
    "which is a live defect rather than a gap; `never-bound` means the client does",
    "not wrap it at all; `deliberately-absent` means the control exists and is",
    "deliberately not usable on that client, which `DELIBERATELY_ABSENT_ON` in",
    "`scripts/check-prefs-parity.mjs` declares.",
    "",
    "Every row that is not `both` carries a written reason in",
    "`scripts/prefs-parity.json`, and the guard compares that record BOTH ways: a",
    "one-sided command with no reason fails, and so does a reason whose command has",
    "converged or left the roster. The record also carries each row's measured",
    "`desktop` and `mobile` state, so a binding that stops being called is caught",
    "even when the verdict does not move. `--record` may only shrink the recorded",
    "set; it refuses a grown one.",
    "",
    "| Command | Class | Desktop | Mobile | Verdict | Reason |",
    "|---|---|---|---|---|---|",
  ];
  for (const r of rows) {
    const reason =
      r.verdict === "both"
        ? "-"
        : entryReason(reasons[r.command]) ?? "**MISSING: the guard is red**";
    lines.push(
      `| \`${r.command}\` | ${r.class} | ${r.desktop} | ${r.mobile} | ${r.verdict} | ${esc(reason)} |`,
    );
  }
  const count = (n, singular) => `${n} ${singular}${n === 1 ? "" : "s"}`;
  const railPanels = DESKTOP_ONLY_PANELS.filter((p) => !p.home);
  const panelBlocks = DESKTOP_ONLY_PANELS.filter((p) => p.home);
  lines.push(
    "",
    "## Panels deliberately absent on mobile",
    "",
    `${count(DESKTOP_ONLY_PANELS.length, "desktop settings surface")} ` +
      `${DESKTOP_ONLY_PANELS.length === 1 ? "has" : "have"} no mobile counterpart: ` +
      `${count(railPanels.length, "rail panel")} and`,
    `${count(panelBlocks.length, "block")} inside a panel. Each is recorded here as`,
    "deliberately absent with the reason it stays. A later parity audit reads a",
    "decision rather than re-deriving one. A surface is not a command, which is why",
    "these are not rows above: the commands those surfaces own are already rows, and",
    "this is the surface-level statement the rows cannot carry. The record lives in",
    "`DESKTOP_ONLY_PANELS` in `scripts/check-prefs-parity.mjs`; each rail panel id is",
    "checked against desktop's `PANELS_BASE` and each block's `home` file must exist.",
    "",
    "| Panel | Reason |",
    "|---|---|",
  );
  for (const p of DESKTOP_ONLY_PANELS) {
    lines.push(`| \`${p.panel}\` | ${esc(p.reason)} |`);
  }
  lines.push("");
  return lines.join("\n");
}

function readRecord() {
  if (!existsSync(RECORD)) return null;
  const raw = JSON.parse(readFileSync(RECORD, "utf8"));
  return raw && typeof raw === "object" && raw.oneSided ? raw : null;
}

/**
 * The one writer, so the seed path and the update path cannot drift in what
 * they preserve. Existing reasons survive by construction rather than by both
 * branches remembering to carry them; a command with no reason yet gets the
 * placeholder, which the reader rejects. Each entry also carries the row's
 * measured `desktop|mobile` state, so the guard can see a binding die without
 * the verdict moving.
 */
function writeRecord(existing, oneSided, states) {
  const reasons = {};
  for (const command of [...oneSided].sort()) {
    const kept = existing?.oneSided?.[command];
    // The whole entry survives an update, not just its text: a record entry is
    // part of the record, and re-writing only the string would silently drop it.
    reasons[command] = kept ?? PLACEHOLDER;
  }
  const recordedStates = {};
  for (const command of Object.keys(reasons)) {
    if (states[command]) recordedStates[command] = states[command];
  }
  writeFileSync(
    RECORD,
    `${JSON.stringify({ $comment: SEED_COMMENT, states: recordedStates, oneSided: reasons }, null, 2)}\n`,
  );
}

const SEED_COMMENT = [
  "One reason per vault.prefs command that is NOT surfaced on both clients, i.e.",
  "every row of docs/dev/settings-parity.md whose verdict is not `both`. Each",
  "reason says whether the gap is deliberate or a defect, and which remedy it",
  "needs. A reason whose command has converged fails as stale, and so does a",
  "one-sided command with no entry here: the record is compared BOTH ways.",
  "",
  "Every entry also carries its row's MEASURED `desktop|mobile` state in `states`,",
  "and the guard compares that state BOTH ways: a row whose measured state moved",
  "while its verdict stayed one-sided (a `called` binding that became",
  "`bound-no-caller`, say) fails naming the drift, because the verdict alone",
  "cannot tell the three remedies apart and would stay green over a live defect.",
  "",
  "A RATCHET: the set may shrink, never grow. `--record` REFUSES to write a grown",
  "set, so the command the failure message suggests cannot be used to make a",
  "regression go away. Locking in a convergence is the only edit it will make.",
  "",
  "A fresh `--record` seeds every entry with the placeholder, and the reason check",
  "rejects that BY NAME: a baseline written blind fails the next --check until a",
  "human replaces each one. That is deliberate, and it is the",
  "check-ipc-binding-callers.mjs lesson mechanised.",
  "",
  "The denominator has its own floor, and it is NOT in this file: COMMAND_FLOOR in",
  "scripts/check-prefs-parity.mjs.",
];

/** The denominator-floor verdict: a message, or `null` when the roster is whole. */
export function floorProblem({ commands, floor }) {
  if (commands.length >= floor) return null;
  return (
    `only ${commands.length} prefs command(s) found, floor is ${floor}. The record ` +
    `is measured against this roster, so a smaller roster shrinks it for free and ` +
    `reads as progress. Either commands left ${COMMANDS_RS}, or the parser is ` +
    `broken. If the surface genuinely shrank, say so in the commit and lower ` +
    `COMMAND_FLOOR by hand.`
  );
}

function read(rel) {
  return readFileSync(join(REPO, rel), "utf8");
}

function measure() {
  const commands = parseCommands(read(COMMANDS_RS));
  const classification = parseClassification(read(CLASSIFICATION_RS));
  const tree = readTree();
  const { dead } = deadBindings(tree);
  const rows = classifyRows({
    commands,
    classification,
    desktop: { path: DESKTOP_PREFS, bound: bindingsByCommand(read(DESKTOP_PREFS)) },
    mobile: { path: MOBILE_PREFS, bound: bindingsByCommand(read(MOBILE_PREFS)) },
    dead: new Set(dead),
  });
  return { commands, classification, measured: rows };
}

/**
 * The measured `desktop|mobile` signature of each named command, for the record.
 *
 * Reads the MEASURED rows, not the applied ones, because the record's state is
 * the measurement: a `deliberately-absent` state is a declaration and is already
 * held in `DELIBERATELY_ABSENT_ON`.
 */
function measuredStates(measured, commands) {
  const byCommand = new Map(measured.map((r) => [r.command, r]));
  const out = {};
  for (const command of commands) {
    const row = byCommand.get(command);
    if (row) out[command] = `${row.desktop}|${row.mobile}`;
  }
  return out;
}

function main() {
  const wantsRecord = process.argv.includes("--record");
  const wantsEmit = process.argv.includes("--emit");

  const { commands, classification, measured } = measure();
  const record = readRecord();
  const reasons = record?.oneSided ?? {};
  const states = record?.states ?? {};
  const marks = DELIBERATELY_ABSENT_ON;
  // The measured states are what the record is CHECKED against; the rows with
  // the deliberate absences applied are what the document renders and what the
  // ratchet counts.
  const rows = applyDeliberate(measured, marks);

  if (wantsRecord) {
    const now = reasonsCheck({ rows: measured, reasons, marks }).oneSided;
    const nowStates = measuredStates(measured, now);
    if (record === null) {
      // The seed path. It writes the placeholder into every entry, so the very
      // next --check fails until a human replaces them: a baseline written
      // blind must not be a licence. Its one-sided set is taken with the
      // declarations applied, so a row whose one-sidedness is a decision rather
      // than a measurement is seeded rather than dropped.
      writeRecord(null, now, nowStates);
      console.log(
        `prefs-parity: baseline written, ${now.length} one-sided command(s) of ` +
          `${rows.length}. Every entry carries the placeholder, so --check FAILS ` +
          `until each one is replaced with what you found out.`,
      );
      return;
    }
    const { grew, shrank } = recordDecision({
      committed: Object.keys(reasons),
      now,
    });
    if (grew.length > 0) {
      console.error(`prefs-parity: --record refused, ${grew.length} command(s) became one-sided:\n`);
      for (const c of grew) console.error(`    ${c}`);
      console.error(
        "\n  Recording them would lock the regression in as the new normal, which is the\n" +
          "  one edit this record is here to prevent. Surface the command on the missing\n" +
          "  client, or argue for the gap in scripts/prefs-parity.json by hand.\n",
      );
      process.exit(1);
    }
    if (shrank.length === 0) {
      console.log("prefs-parity: nothing to lock in; the record already describes the tree.");
      return;
    }
    writeRecord(record, now, nowStates);
    console.log(
      `prefs-parity: locked in ${shrank.length} convergence(s); ${now.length} command(s) still one-sided.`,
    );
    return;
  }

  if (wantsEmit) {
    writeFileSync(PROJECTION, renderProjection(rows, reasons));
    console.log(`prefs-parity: ${PROJECTION_LABEL} regenerated (${rows.length} row(s))`);
    return;
  }

  let failed = false;

  if (commands.length < COMMAND_FLOOR) {
    failed = true;
    console.error(`prefs-parity: ${floorProblem({ commands, floor: COMMAND_FLOOR })}\n`);
  }

  const mapping = mappingProblems({ commands, classification });
  if (mapping.length > 0) {
    failed = true;
    console.error(`prefs-parity: ${mapping.length} command -> field mapping problem(s):\n`);
    for (const message of mapping) console.error(`  - ${message}`);
    console.error("");
  }

  const panels = panelProblems({
    named: DESKTOP_ONLY_PANELS,
    desktopPanels: parseDesktopPanels(read("src/components/SettingsModal.tsx")),
  });
  if (panels.length > 0) {
    failed = true;
    console.error(`prefs-parity: ${panels.length} desktop-only-panel record problem(s):\n`);
    for (const message of panels) console.error(`  - ${message}`);
    console.error("");
  }

  const verdicts = reasonsCheck({ rows: measured, reasons, states, marks });

  if (verdicts.missing.length > 0) {
    failed = true;
    console.error(
      `prefs-parity: ${verdicts.missing.length} one-sided command(s) carry no reason:\n`,
    );
    for (const c of verdicts.missing) console.error(`    ${c}`);
    console.error(
      "\n  A setting desktop surfaces and mobile does not is either a gap to close or\n" +
        "  a deliberate absence, and the two are indistinguishable without the reason.\n" +
        "  Record it in scripts/prefs-parity.json with what you found out.\n",
    );
  }

  if (verdicts.stale.length > 0) {
    failed = true;
    console.error(`prefs-parity: ${verdicts.stale.length} recorded reason(s) no longer apply:\n`);
    for (const c of verdicts.stale) {
      const why = verdicts.staleUnknown.includes(c)
        ? "names no command in the roster"
        : "is now surfaced on both clients";
      console.error(`    ${c} (${why})`);
    }
    console.error(
      "\n  A reason that has outlived its subject has stopped describing anything.\n" +
        "  Remove it with `node scripts/check-prefs-parity.mjs --record`.\n",
    );
  }

  if (verdicts.redundantDeliberate.length > 0) {
    failed = true;
    console.error(
      `prefs-parity: ${verdicts.redundantDeliberate.length} deliberate-absence mark(s) describe a\n` +
        "client that no longer reaches the command:\n",
    );
    for (const c of verdicts.redundantDeliberate) console.error(`    ${c}`);
    console.error(
      "\n  `DELIBERATELY_ABSENT_ON` says a control exists on a client and is deliberately\n" +
        "  not usable there. Where the client does not reach the command at all, the\n" +
        "  declaration describes nothing and its remedy is the state itself.\n",
    );
  }

  if (verdicts.unknownClient.length > 0) {
    failed = true;
    console.error(
      `prefs-parity: ${verdicts.unknownClient.length} deliberate-absence mark(s) name an unknown\n` +
        `client (known: ${Object.keys(CLIENT_FIELDS).join(", ")}):\n    ${verdicts.unknownClient.join("\n    ")}\n`,
    );
  }

  if (verdicts.stateUnrecorded.length > 0) {
    failed = true;
    console.error(
      `prefs-parity: ${verdicts.stateUnrecorded.length} one-sided command(s) carry no recorded state:\n`,
    );
    for (const c of verdicts.stateUnrecorded) console.error(`    ${c}`);
    console.error(
      "\n  The record carries each row's measured desktop|mobile state so a `called`\n" +
        "  binding that dies is caught even when the verdict does not move. Add it with\n" +
        "  `node scripts/check-prefs-parity.mjs --record`.\n",
    );
  }

  if (verdicts.stateChanged.length > 0) {
    failed = true;
    console.error(
      `prefs-parity: ${verdicts.stateChanged.length} recorded state(s) no longer match the tree:\n`,
    );
    for (const c of verdicts.stateChanged) console.error(`    ${c}`);
    console.error(
      "\n  The verdict stayed one-sided, so the reason still applies, but the row's\n" +
        "  measured state moved. A `called` binding that became `bound-no-caller` is a\n" +
        "  live defect the verdict alone cannot express.\n",
    );
  }

  if (verdicts.unreasoned.length > 0) {
    failed = true;
    console.error(`prefs-parity: ${verdicts.unreasoned.length} recorded reason(s) are not reasons:\n`);
    for (const c of verdicts.unreasoned) console.error(`    ${c}`);
    console.error(
      `\n  Each needs at least ${MIN_REASON} characters of prose saying what the gap is\n` +
        "  and which remedy it needs. The --record placeholder is rejected by name.\n",
    );
  }

  const badText = badReasonText(reasons);
  if (badText.length > 0) {
    failed = true;
    console.error(
      `prefs-parity: ${badText.length} reason(s) contain a newline, which breaks the\n` +
        `generated table:\n    ${badText.join("\n    ")}\n`,
    );
  }

  if (!failed) {
    if (!existsSync(PROJECTION)) {
      failed = true;
      console.error(
        `prefs-parity: ${PROJECTION_LABEL} does not exist. Run ` +
          "`node scripts/check-prefs-parity.mjs --emit` and commit it.\n",
      );
    } else {
      const committedDoc = readFileSync(PROJECTION, "utf8");
      if (committedDoc !== renderProjection(rows, reasons)) {
        failed = true;
        console.error(
          `prefs-parity: ${PROJECTION_LABEL} is stale (or hand-edited). Run ` +
            "`node scripts/check-prefs-parity.mjs --emit` and commit the result.\n",
        );
      }
    }
  }

  if (failed) process.exit(1);

  const tally = { both: 0, "desktop-only": 0, "mobile-only": 0, "no-ui": 0 };
  for (const r of rows) tally[r.verdict] += 1;
  console.log(
    `prefs-parity: ok (${rows.length} command(s): ${tally.both} both, ` +
      `${tally["desktop-only"]} desktop-only, ${tally["mobile-only"]} mobile-only, ` +
      `${tally["no-ui"]} no-ui; ${verdicts.oneSided.length} reasoned)`,
  );
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  main();
}
