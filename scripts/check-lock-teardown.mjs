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
// Per CLAUDE.md, running it proves nothing. Inject the defect: blank one
// required hook body in `mobile/src-tauri/src/hooks.rs`, confirm this names
// that exact client+hook pair, restore. Then confirm it stays SILENT for a
// legitimately-empty hook whose state the client does not hold (mobile's
// `zeroize_spell`) — a guard that fires there would be worse than no guard.

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const ROOT = new URL("..", import.meta.url).pathname;

/** The three clients that implement `VaultLifecycleHooks` for real. */
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
const PAIRS = [
  { hook: "zeroize_search_index", holder: { kind: "state", type: "SearchIndexState" } },
  { hook: "zeroize_spell", holder: { kind: "state", type: "SpellState" } },
  { hook: "zeroize_vault_indices", holder: { kind: "state", type: "VaultIndicesState" } },
  { hook: "zeroize_attachment_refs", holder: { kind: "state", type: "AttachmentRefsState" } },
  { hook: "abort_active_recording", holder: { kind: "state", type: "VoiceRecordState" } },
  { hook: "pdf_export_teardown_on_lock", holder: { kind: "state", type: "PdfExportState" } },
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

function walk(dir) {
  const out = [];
  let entries;
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  for (const name of entries) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) out.push(...walk(full));
    else if (full.endsWith(".rs")) out.push(full);
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

const findings = [];
const notes = [];

for (const client of CLIENTS) {
  const hooksPath = join(ROOT, client.hooksFile);
  let hooksSrc;
  try {
    hooksSrc = readFileSync(hooksPath, "utf8");
  } catch {
    findings.push({
      client: client.name,
      hook: "(impl)",
      detail: `${client.hooksFile} is unreadable — the client's VaultLifecycleHooks impl was expected here`,
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
      const manage = new RegExp(`\\bmanage\\s*\\(\\s*[A-Za-z0-9_:]*\\b${holder.type}::default\\s*\\(`);
      const once = new RegExp(`OnceLock\\s*<\\s*${holder.type}\\s*>`);
      for (const f of treeSources) {
        if (manage.test(f.text) || once.test(f.text)) {
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
      notes.push(`  allowed: ${key} — ${ALLOWLIST.get(key)}`);
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
  const stillNoted = notes.some((n) => n.includes(key));
  if (!stillFailing && !stillNoted) {
    findings.push({
      client,
      hook,
      detail: `stale ALLOWLIST entry — this pair no longer needs an exemption; remove it`,
    });
  }
}

if (findings.length > 0) {
  console.error("check-lock-teardown: a client leaves a lock-teardown hook empty while holding its state.\n");
  for (const f of findings) {
    console.error(`  ${f.client}: ${f.hook} — ${f.detail}`);
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
  `check-lock-teardown: OK — ${CLIENTS.length} clients, ${PAIRS.length} teardown hooks, every held state is torn down.`,
);
