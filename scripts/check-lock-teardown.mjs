#!/usr/bin/env node
// Lock-teardown hook guard (myne-md/myne#454).
//
// # The failure this exists to catch
//
// Every plaintext-derived RAM surface a client holds while a vault is unlocked
// must be torn down when the slot drops. The teardown itself is already shared:
// `myne-core` calls the `VaultLifecycleHooks` teardown hooks at every
// slot-drop site there is — `lock_from_host` (manual + auto lock), the
// vault-SWITCH branch of `unlock_from_host`, `vault_delete`, and the
// change-password force-relock. A client does not wire those calls. It only
// supplies the hook BODIES.
//
// So the whole contract reduces to one sentence: if a client holds the state,
// it must implement the hook. And the way that breaks is an EMPTY FUNCTION
// BODY, which is the worst possible shape:
//
//   fn zeroize_vault_indices(&self) {}
//
// `cargo build` is happy. `cargo clippy --workspace --all-targets -- -D
// warnings` is happy (an empty body satisfies the trait). Every other
// `scripts/check-*` guard is happy. `pre-commit`, `pre-push` and CI are all
// green. Nothing anywhere reports that a lock does not lock.
//
// That is not hypothetical. The mobile client shipped all three of
//
//   zeroize_search_index / zeroize_vault_indices / zeroize_attachment_refs
//
// as empty bodies while `lib.rs` managed all three states for the process
// lifetime, and it cost two separate things:
//
//   1. **Vault isolation.** `vault_indices_tasks` gates on "IS some vault
//      unlocked", never "WHICH one", and a `VaultTask` carries no vault id, so
//      nothing downstream can filter. Mobile's re-seed is additive
//      (`vault_indices_apply` per note, no whole-index replace), so vault B's
//      records landed ON TOP of vault A's and A's stayed forever. Tasks was
//      merely the visible surface: `all_headings`, `all_block_anchors`,
//      `orphans`, `all_edges`, `by_tag`, `tag_tree`, `property_values` and
//      `backlink_candidates` read the same state.
//   2. **RAM hygiene.** `VaultIndicesState::clear()` zeroizes in place. Never
//      calling it left a LOCKED vault's note titles, folder names, tags and
//      task text resident in process memory for the lifetime of the app, so
//      "lock" on mobile was weaker than the same word on desktop.
//
// Meanwhile the mobile tree's own comments asserted the teardown DID happen
// ("four-surface teardown … search index + VaultIndices + attachment-refs"),
// which is what a rule held by prose rather than by a machine decays into.
//
// # What it enforces
//
// For each (hook, holder) pair below, in each client crate: if the crate HOLDS
// the state for the process lifetime, the crate's `VaultLifecycleHooks` impl
// may not leave that hook's body empty. A body containing only comments counts
// as empty — that is the same no-op wearing an explanation.
//
// Holding is deliberately narrow, so a test-local `let s = XState::default()`
// never counts:
//
//   - `manage(<path::>XState::default())`  — the Tauri clients (desktop, mobile)
//   - `static NAME: OnceLock<XState>`      — the wasm client (web/wasm/session.rs)
//   - a registered/dispatched command      — for the staged workspace descriptor,
//     whose holder is a `myne-core` global rather than a per-client state type,
//     so the honest signal is whether the client exposes its only writer
//     (`workspace_stage`) at all.
//
// # What it deliberately does NOT claim
//
// **WHAT THIS GUARD DOES NOT CHECK, measured rather than assumed.** The roster
// below is keyed `<hook, holder>`, and the comment above the agent rows says one
// row would leave the other state's arrival silent, "which is the shape this
// guard exists to refuse". It does not refuse it. The only assertion on an
// implemented hook is that its body is NON-EMPTY, so on a hook with several
// holders, deleting one holder's clear leaves the body non-empty and this guard
// green. Measured on myne-md/myne#456: mobile's `agent_teardown_on_lock` cleared
// two of its three states, the third held `ai_provider_key` as plaintext, and
// this guard reported ok throughout.
//
// A per-holder check was written and reverted, because it was wrong at this
// altitude: these hooks are thin wrappers that delegate into their plugin, so
// requiring the hook body to NAME its holder type reported ten false findings on
// a correct tree, desktop's included. Following one level of delegation is a
// call-graph question rather than a text one, which is where this guard stops.
//
// So the roster row is a record rather than an enforcement, and the honest
// statement is that a MISSING holder is caught by review, while an EMPTY hook is
// caught here. Adding a row still matters: it is what makes the omission legible
// to the next reader, and it is what a future call-graph-aware check would read.
//
// This guard is keyed on NAMED state types. A client whose equivalent RAM
// lives under a different type is not covered by that row — web's attachment
// half is the live example: it holds no `AttachmentRefsState`, its equivalent
// is the object-URL cache, and `WebHooks::zeroize_attachment_refs` revokes
// those URLs because an unrevoked object URL is a GC root for its `Blob`. The
// guard cannot see that, and says so here rather than implying the row is
// covered. Adding a state type to the table is how such a surface gets covered.
//
// Nor does it check that the teardown is CORRECT — only that it is not absent.
// The call-vector test in `core/src/plugins/vault_unlock/commands.rs` pins
// which hooks `lock_from_host` fires and in what order; that test uses a
// recording test double, so it cannot see a client's empty body. The two halves
// are complementary and neither covers the other.
//
// # Verifying this guard
//
// Per AGENTS.md, running it proves nothing. Inject the defect: blank one
// required hook body in `mobile/src-tauri/src/hooks.rs`, confirm this names
// that exact client+hook pair, restore. Then confirm it stays SILENT for a
// legitimately-empty hook whose state the client does not hold (mobile's
// `zeroize_spell`) — a guard that fires there would be worse than no guard.

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { existsSync } from "node:fs";
import { RUST_CLIENT_TREES } from "./lib/shared-roots.mjs";

const ROOT = new URL("..", import.meta.url).pathname;

/**
 * The three clients that implement `VaultLifecycleHooks` for real.
 *
 * `cli/src` and `tor-sidecar/src` are Rust client trees and are deliberately
 * absent: neither opens a vault, so neither implements the seam. That is why
 * this is its own roster rather than `RUST_CLIENT_TREES` itself, and why the
 * claim checked below runs in ONE direction.
 */
const CLIENTS = [
  { name: "desktop", tree: "src-tauri/src", hooksFile: "src-tauri/src/hooks.rs" },
  { name: "mobile", tree: "mobile/src-tauri/src", hooksFile: "mobile/src-tauri/src/hooks.rs" },
  { name: "web", tree: "web/wasm/src", hooksFile: "web/wasm/src/hooks.rs" },
];

/**
 * The lock-teardown hook family, each with the evidence that the client holds
 * the RAM it tears down.
 *
 * `state` holders are matched by type name; `command` holders by the name of
 * the only writer the client would have to expose to hold anything.
 */
/**
 * What a teardown-shaped hook name looks like on the seam.
 *
 * Deliberately a shape rather than a list: the point of deriving from the trait
 * is that a hook added tomorrow is covered without anyone remembering this file.
 */
const TEARDOWN_SHAPE = /^(zeroize_|clear_|abort_)|_teardown_on_lock$/;

const PAIRS = [
  { hook: "zeroize_search_index", holder: { kind: "state", type: "SearchIndexState" } },
  { hook: "zeroize_spell", holder: { kind: "state", type: "SpellState" } },
  { hook: "zeroize_vault_indices", holder: { kind: "state", type: "VaultIndicesState" } },
  { hook: "zeroize_attachment_refs", holder: { kind: "state", type: "AttachmentRefsState" } },
  { hook: "abort_active_recording", holder: { kind: "state", type: "VoiceRecordState" } },
  { hook: "pdf_export_teardown_on_lock", holder: { kind: "state", type: "PdfExportState" } },
  // Two rows, one hook. The unit here is <hook, holder>, and the agent holds
  // TWO plaintext-derived tables that are cleared together: core's run table
  // (a note-id set derived from decrypted plaintext, plus the frozen scope) and
  // the host's session table (the transcript, which carries whole note bodies).
  // One row would leave the other state's arrival silent, which is the shape
  // this guard exists to refuse.
  { hook: "agent_teardown_on_lock", holder: { kind: "state", type: "AgentRunState" } },
  { hook: "agent_teardown_on_lock", holder: { kind: "state", type: "AgentSessionState" } },
  // A THIRD row on the same hook, added by myne-md/myne#456's review. The two
  // above are the tables that hold note bodies; this one is the cached
  // preferences snapshot, which holds `ai_provider_key` as a plaintext
  // `Zeroizing<String>`. Desktop has wiped it since myne-md/myne#437, whose call
  // site calls it "the one vault-derived secret that survived a teardown which
  // wipes root_key, the search index, the spell dictionary and the vectors".
  // Mobile shipped the same state and left it resident, and this guard was green
  // the whole time, because a roster keyed on named state types cannot see a type
  // nobody added. That is the guard's stated limit rather than a defect in it,
  // and adding the row is the documented way a surface gets covered.
  //
  // Read the header's "WHAT THIS GUARD DOES NOT CHECK" before trusting this row:
  // with three holders on one hook, this guard cannot tell that one of the three
  // clears went missing, because the body is still non-empty. The row records the
  // state; review is what enforces it.
  { hook: "agent_teardown_on_lock", holder: { kind: "state", type: "AgentInferenceState" } },
  // A detached (pop-out) note window is a second plaintext-bearing WebView, and
  // the desktop holds the label->note-id map that names the ones it must destroy
  // on lock (myne-md/myne#679, epic #173). An empty hook body would leave a
  // locked vault's note text on screen in the pop-out; only desktop opens OS
  // windows, so mobile and web hold no registry and owe nothing.
  { hook: "detached_windows_teardown_on_lock", holder: { kind: "state", type: "DetachedWindowRegistry" } },
  { hook: "clear_staged_descriptor", holder: { kind: "command", name: "workspace_stage" } },
];

/**
 * Reason-carrying exemptions, keyed `"<client>/<hook>"`.
 *
 * LANDED EMPTY, on purpose. An absent holder already produces no finding, so
 * every legitimate no-op today needs no entry — which means the first entry
 * ever added has to argue for itself in review rather than joining a list.
 * The only thing that belongs here is a client that genuinely HOLDS the state
 * and genuinely must not tear it down, and no such case exists today.
 */
const ALLOWLIST = new Map([
  // ["mobile/zeroize_spell", "reason the empty body is correct despite a holder"],
]);

const SKIP_DIRS = new Set(["target", "gen", "node_modules", ".git"]);

function walk(dir, out = []) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    if (SKIP_DIRS.has(entry.name)) continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (entry.name.endsWith(".rs")) out.push(full);
  }
  return out;
}

/**
 * Strip Rust comments so neither a `{` inside a comment breaks brace balancing
 * nor a commented-out call makes an empty body look implemented.
 */
function stripComments(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/\/\/[^\n]*/g, "");
}

/** The balanced-brace body starting at the first `{` at or after `from`. */
function bodyAt(src, from) {
  const open = src.indexOf("{", from);
  if (open === -1) return null;
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === "{") depth++;
    else if (src[i] === "}") {
      depth--;
      if (depth === 0) return src.slice(open + 1, i);
    }
  }
  return null;
}

/** The `impl … VaultLifecycleHooks for …` block, comments already stripped. */
function hooksImplBlock(stripped) {
  const m = /impl[\s\S]{0,120}?VaultLifecycleHooks\s+for\s/.exec(stripped);
  if (!m) return null;
  return bodyAt(stripped, m.index);
}

// A tree that does not exist scans zero files, finds zero empty bodies, and
// reports ok. That is the shape every roster in this repo has failed by, so the
// paths are checked against the one Rust-client roster and against the disk
// before anything else runs. One direction only: a client here must be a known
// Rust client tree, but not every Rust client tree implements the seam.
{
  const unknown = CLIENTS.filter((c) => !RUST_CLIENT_TREES.includes(c.tree));
  const absent = CLIENTS.filter((c) => !existsSync(join(ROOT, c.hooksFile)));
  for (const c of unknown) {
    console.error(
      `check-lock-teardown: ${c.name} names the tree ${c.tree}, which is not in ` +
        `RUST_CLIENT_TREES (scripts/lib/shared-roots.mjs). A tree nothing knows about ` +
        `is a tree this guard would scan and find nothing in.`,
    );
  }
  for (const c of absent) {
    console.error(
      `check-lock-teardown: ${c.name}'s hooks file ${c.hooksFile} is not on disk. ` +
        `Renamed or moved: the guard would report ok having read nothing.`,
    );
  }
  if (unknown.length || absent.length) process.exit(1);
}

// PAIRS is a hand-written roster and the success line counts it. Counted against
// itself that is a roster compared against a second copy of itself: a teardown
// hook added to `VaultLifecycleHooks` would be covered by nothing while the line
// still read "every held state is torn down". The trait is the source, and the
// two are compared in BOTH directions.
{
  const traitSrc = readFileSync(join(ROOT, "core/src/hooks.rs"), "utf8");
  const declared = new Set(
    [...traitSrc.matchAll(/^\s*fn\s+([a-z0-9_]+)\s*\(&self\)\s*;/gm)]
      .map((m) => m[1])
      .filter((n) => TEARDOWN_SHAPE.test(n)),
  );
  const covered = new Set(PAIRS.map((row) => row.hook));
  const uncovered = [...declared].filter((n) => !covered.has(n));
  const phantom = [...covered].filter((n) => !declared.has(n));
  for (const n of uncovered) {
    console.error(
      `check-lock-teardown: \`${n}\` is a teardown-shaped hook on VaultLifecycleHooks ` +
        `and has no PAIRS row, so no client is checked for it. Add a row naming the state ` +
        `it tears down, or rename it if it is not a teardown.`,
    );
  }
  for (const n of phantom) {
    console.error(
      `check-lock-teardown: PAIRS has a row for \`${n}\`, which VaultLifecycleHooks no longer ` +
        `declares. A row for a hook nobody implements passes forever.`,
    );
  }
  if (uncovered.length || phantom.length) process.exit(1);
}

const findings = [];
const notes = [];
/** ALLOWLIST keys that actually suppressed a finding this run. */
const exercised = new Set();

for (const client of CLIENTS) {
  const hooksPath = join(ROOT, client.hooksFile);
  let hooksSrc;
  try {
    hooksSrc = readFileSync(hooksPath, "utf8");
  } catch {
    findings.push({
      client: client.name,
      hook: "(impl)",
      detail: `${client.hooksFile} is unreadable. The client's VaultLifecycleHooks impl was expected here`,
    });
    continue;
  }

  const impl = hooksImplBlock(stripComments(hooksSrc));
  if (impl === null) {
    findings.push({
      client: client.name,
      hook: "(impl)",
      detail: `no \`impl … VaultLifecycleHooks for …\` found in ${client.hooksFile}`,
    });
    continue;
  }

  // One read of the client tree, reused by every holder probe below.
  const treeSources = walk(join(ROOT, client.tree)).map((f) => ({
    rel: relative(ROOT, f),
    text: readFileSync(f, "utf8"),
  }));

  for (const { hook, holder } of PAIRS) {
    let heldBy = null;
    if (holder.kind === "state") {
      // The TYPE anywhere inside a `manage(` argument, not one constructor
      // spelling. The narrow form matched `manage(X::default()` only, so the
      // ordinary refactor `let s = X::default(); app.manage(s);` disarmed the
      // row and the myne#454 defect passed green. Still anchored on `manage(`,
      // which is what keeps a test-local construction from counting as holding.
      const manage = new RegExp(`\\bmanage\\s*\\([^;]*\\b${holder.type}\\b`);
      // The let-binding form, where the type is on the binding and an ident is
      // what reaches `manage(`. Matched per FILE rather than per line, because
      // the two can be lines apart.
      const bound = new RegExp(
        `\\b(?:let|static|const)\\s+[A-Za-z0-9_]+\\s*(?::[^=;]*)?=\\s*[A-Za-z0-9_:]*\\b${holder.type}\\b[^;]*;`,
      );
      const once = new RegExp(`OnceLock\\s*<\\s*${holder.type}\\s*>`);
      for (const f of treeSources) {
        if (
          manage.test(f.text) ||
          once.test(f.text) ||
          (bound.test(f.text) && /\bmanage\s*\(/.test(f.text))
        ) {
          heldBy = f.rel;
          break;
        }
      }
    } else {
      const registered = new RegExp(`commands::${holder.name}\\b`);
      const dispatched = new RegExp(`"plugin:[a-z0-9-]+\\|${holder.name}"\\s*=>`);
      for (const f of treeSources) {
        if (registered.test(f.text) || dispatched.test(f.text)) {
          heldBy = f.rel;
          break;
        }
      }
    }

    if (!heldBy) continue; // No holder, no teardown owed.

    const fnAt = new RegExp(`\\bfn\\s+${hook}\\s*\\(`).exec(impl);
    if (!fnAt) {
      findings.push({
        client: client.name,
        hook,
        detail: `holds the state (${heldBy}) but the impl declares no \`${hook}\``,
      });
      continue;
    }

    const body = bodyAt(impl, fnAt.index);
    if (body === null) {
      findings.push({ client: client.name, hook, detail: `could not parse the body of \`${hook}\`` });
      continue;
    }

    if (body.trim() !== "") continue; // Implemented.

    const key = `${client.name}/${hook}`;
    if (ALLOWLIST.has(key)) {
      notes.push(`  allowed: ${key}: ${ALLOWLIST.get(key)}`);
      exercised.add(key);
      continue;
    }

    findings.push({
      client: client.name,
      hook,
      detail: `empty body, but the client holds the state it must tear down (${heldBy})`,
    });
  }
}

// A stale allowlist entry is a claim that stopped describing anything.
for (const key of ALLOWLIST.keys()) {
  const [client, hook] = key.split("/");
  const stillFailing = findings.some((f) => f.client === client && f.hook === hook);
  // The KEY, not a substring of the formatted note. Matching on the printed
  // string made the console wording load-bearing logic: rewording the note
  // silently turned the stale check off, and a key that is a prefix of another
  // matched the wrong one.
  const stillNoted = exercised.has(key);
  if (!stillFailing && !stillNoted) {
    findings.push({
      client,
      hook,
      detail: `stale ALLOWLIST entry: this pair no longer needs an exemption, remove it`,
    });
  }
}

if (findings.length > 0) {
  console.error("check-lock-teardown: a client leaves a lock-teardown hook empty while holding its state.\n");
  for (const f of findings) {
    console.error(`  ${f.client}: ${f.hook}: ${f.detail}`);
  }
  console.error(
    "\nA vault that stays in RAM after lock mixes into the next vault to unlock and keeps\n" +
      "the locked vault's plaintext-derived strings resident. Implement the hook against the\n" +
      "state the client manages (see the desktop twins in src-tauri/src/hooks.rs), or, if the\n" +
      "empty body is genuinely correct despite the holder, add a reason to ALLOWLIST in\n" +
      "scripts/check-lock-teardown.mjs.",
  );
  process.exit(1);
}

for (const n of notes) console.log(n);
console.log(
  `check-lock-teardown: OK: ${CLIENTS.length} clients, ${PAIRS.length} teardown hooks, every held state is torn down.`,
);
