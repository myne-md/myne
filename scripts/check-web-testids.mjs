#!/usr/bin/env node
// The web client's E2E observability contract (phase3-web-client task 100).
//
// # Why this needs a script when the desktop convention does not have one
//
// `src/CLAUDE.md` states the rule flatly — "a screen without testids is
// invisible to E2E" — and 489 `data-testid` attributes in `src/` are held to it
// by **review alone**. That works while every screen has an owner who reviews
// it. The web client's screens do not: tasks 61/59/74/105/106 CONSUME testids
// (`byTestId` is the only sanctioned selector in `e2e/CLAUDE.md`), while the
// tasks that BUILT these screens never mention `data-*` at all. An unowned
// convention is not a convention; it is a gap with a policy written next to it.
//
// # The three things it checks
//
// 1. **Every web-only rendering module carries at least one testid.** A screen
//    with none is unreachable from the suite that is supposed to prove it works.
// 2. **Every testid is `<screen>.<element>`.** The naming rule is what lets a
//    scenario guess a selector instead of grepping for it.
// 3. **No `data-*` attribute is fed a runtime expression** in the pre-unlock
//    web screens. This is the SYNC-7 leak budget, and its sharpest case is the
//    account number: it is pre-unlock INPUT, so `data-value={account}` is one
//    keystroke away and would put it in the DOM, in screenshots, and in every
//    failure artefact CI keeps.

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

/** Web-only rendering modules: everything under `web/src` that renders. */
const WEB_DIR = join("web", "src");

/**
 * Web-only screens that live in the SHARED tree because they are stages
 * (`src/lib/stage.ts` owns their names), reachable only on this client.
 */
const SHARED_WEB_ONLY = [
  join("src", "screens", "AccountNumberEntry.tsx"),
  join("src", "screens", "WebNoAccount.tsx"),
];

/**
 * Modules that legitimately render NOTHING, so "at least one testid" cannot
 * apply. Each is a substitution whose whole job is to be absent — and each is
 * already covered by an absence marker in `check-web-surfaces.mjs`, which is a
 * stronger check than a testid would be.
 */
const RENDERS_NOTHING = new Set([
  join("web", "src", "components", "PairingDialog.tsx"),
  join("web", "src", "components", "sync", "JoinDeviceModal.tsx"),
  join("web", "src", "components", "settings", "ConnectedExtensions.tsx"),
  join("web", "src", "components", "backup", "BackupExportModal.tsx"),
  join("web", "src", "screens", "EnrollPhraseCredential.tsx"),
  // The creation flow's local-disk affordances, substituted away on 2026-08-15:
  // a native save dialog and an OS file-manager reveal, neither of which this
  // client has. Renders `null`, so there is nothing for a testid to name.
  join("web", "src", "screens", "vault-creation", "ReadyLocalArtefacts.tsx"),
  join("web", "src", "main.tsx"), // the entry point; mounts, renders no markup of its own
]);

/** `<screen>.<element>`, lowercase, dot-separated, hyphens inside a segment. */
const NAME = /^[a-z][a-z0-9-]*(\.[a-z0-9-]+)+$/;

export function webModules(dir = WEB_DIR) {
  const out = [];
  const walk = (d) => {
    for (const name of readdirSync(d).sort()) {
      const full = join(d, name);
      if (statSync(full).isDirectory()) walk(full);
      else if (/\.tsx$/.test(name)) out.push(relative(".", full));
    }
  };
  walk(dir);
  return [...out, ...SHARED_WEB_ONLY];
}

/** Every `data-testid="…"` literal in `source`. */
export function testidsIn(source) {
  return [...source.matchAll(/data-testid="([^"]*)"/g)].map((m) => m[1]);
}

/** Source with JSX/line/block comments removed, so prose about a rule is not
 *  mistaken for a violation of it. (This guard flagged its own comment first.) */
export function stripComments(source) {
  return source
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, "")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");
}

/** `data-*` attributes fed an EXPRESSION rather than a string literal. */
export function dynamicDataAttrs(source) {
  return [...stripComments(source).matchAll(/(data-[a-z0-9-]+)=\{/g)].map((m) => m[1]);
}

/**
 * Dynamic `data-*` attributes a pre-unlock screen may carry.
 *
 * The rule is not "no runtime values" — a repeated row needs a discriminator,
 * and `src/CLAUDE.md` asks for exactly that shape. The rule is that each one is
 * a DECISION: the attribute is named here, its value is a closed set the code
 * controls, and adding a new one means reading this comment. What must never
 * appear is a value the USER typed, and on these screens the user types an
 * account number.
 */
const ALLOWED_DYNAMIC = new Map([
  ["data-wall", "WebNoAccount's `no-account` / `no-sync` variant — a closed union."],
]);

function main() {
  const files = webModules();
  const problems = [];

  for (const f of files) {
    const src = readFileSync(f, "utf8");
    const ids = testidsIn(src);

    if (ids.length === 0 && !RENDERS_NOTHING.has(f)) {
      problems.push(
        `${f}: renders with no data-testid — the web suite cannot reach it. ` +
          `If it renders nothing, add it to RENDERS_NOTHING with the reason.`,
      );
    }
    for (const id of ids) {
      if (!NAME.test(id)) {
        problems.push(`${f}: testid "${id}" is not <screen>.<element>`);
      }
    }
    // An INTERPOLATED testid is banned outright, everywhere — not only
    // pre-unlock. A selector assembled at runtime is one a scenario has to
    // reconstruct, and the reconstruction is what silently stops matching when
    // the variant set changes. The variant belongs in a `data-*`.
    if (/data-testid=\{/.test(stripComments(src))) {
      problems.push(
        `${f}: data-testid is interpolated. Use a stable name plus a discriminator ` +
          `attribute (src/CLAUDE.md, "Test observability").`,
      );
    }

    // The leak budget. Applied to the PRE-UNLOCK web screens, which is where the
    // account number is typed; a dynamic `data-*` elsewhere (a device row's id
    // hex, a note id) is the sanctioned discriminator pattern.
    if (f.startsWith(join("src", "screens")) || f.startsWith(join("web", "src", "screens"))) {
      const dynamic = dynamicDataAttrs(src).filter((a) => !ALLOWED_DYNAMIC.has(a));
      if (dynamic.length > 0) {
        problems.push(
          `${f}: ${[...new Set(dynamic)].join(", ")} takes a runtime value on a pre-unlock ` +
            `screen. The account number is pre-unlock INPUT — a data-* attribute puts it in ` +
            `the DOM, in screenshots, and in every CI failure artefact (SYNC-7 leak budget). ` +
            `If it is a closed-set discriminator, name it in ALLOWED_DYNAMIC with the reason.`,
        );
      }
    }
  }

  if (problems.length > 0) {
    console.error(`web testids: ${problems.length} problem(s):\n` + problems.map((p) => `    ${p}`).join("\n"));
    process.exit(1);
  }

  const total = files.reduce((n, f) => n + testidsIn(readFileSync(f, "utf8")).length, 0);
  console.log(
    `web testids: ok (${files.length} web-only module(s), ${total} testid(s), ` +
      `${RENDERS_NOTHING.size} render-nothing substitution(s))`,
  );
}

if (import.meta.url === `file://${process.argv[1]}`) main();
