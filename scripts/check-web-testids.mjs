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
import { dirname, join, relative } from "node:path";

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
  // The vault-import setup step (myne-md/myne#464). It renders nothing because
  // it THROWS: `vaultImport` is absent here, so `availableSourceOrder()` never
  // offers the card and the component is unreachable. A stub that returned
  // `null` instead would swallow a routing bug that made it reachable, which is
  // the one thing this substitution must not do, since the real module takes a
  // 24-word recovery phrase.
  join("web", "src", "notes", "import", "MyneVaultSetup.tsx"),
  join("web", "src", "main.tsx"), // the entry point; mounts, renders no markup of its own
]);

/** `<screen>.<element>`, lowercase, dot-separated, hyphens inside a segment. */
const NAME = /^[a-z][a-z0-9-]*(\.[a-z0-9-]+)+$/;

/**
 * Fewest files the pre-unlock walk may cover before the walk itself is suspect.
 *
 * Recorded from a real run (15 at the time of writing), not invented, and it may
 * rise as the tree grows.
 * Lowering it is the edit that is never routine: it means the account-number
 * screens compose less than they did, which is either a real simplification
 * worth saying out loud or a walk that has stopped finding things.
 */
const PRE_UNLOCK_FLOOR = 15;

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

/**
 * A backtick template is constant exactly when it interpolates nothing.
 *
 * This one sentence is the rule that drifted, and it is the reason the file has
 * three value scanners rather than one. Two of them read a value the regex
 * CAPTURED and one walks to the closing backtick by index, because a template
 * may contain the `,` and `}` that bound the captures; those three shapes are
 * genuinely different and are not worth collapsing. What must not differ is what
 * they conclude, and it did: the two `data-testid` scanners treated a leading
 * backtick as disqualifying outright, so `` `plain` `` was reported as a runtime
 * value while `dynamicDataAttrs` had already learned otherwise, and the fix that
 * taught it reached one copy of three.
 */
function templateInterpolates(body) {
  return body.includes("${");
}

/**
 * The value expression starting at `start`, which is NOT simply "up to the next
 * `,` or `}`".
 *
 * A backtick template may contain both, and truncating one produced the wrong
 * answer twice over. `` `row-${account}` `` was cut at the `}` that closes the
 * interpolation, so it never ended with a backtick and was reported by the
 * quote-shape test rather than by the rule that owns this: the RIGHT answer, for
 * the wrong reason, which meant `templateInterpolates` was unreachable here and
 * the predicate the docblock says decides it decided nothing. And a CONSTANT
 * template containing a comma, `` `a, b` ``, was cut the same way and reported
 * as a runtime value, which is a guard firing on a correct file.
 *
 * A backtick is therefore scanned to its close, which is what `dynamicDataAttrs`
 * has always done by index; every other shape still stops at the delimiter.
 */
function valueAfter(clean, start) {
  if (clean[start] !== "`") {
    const m = /^[^,}\n]*/.exec(clean.slice(start));
    return (m === null ? "" : m[0]).trim();
  }
  const close = clean.indexOf("`", start + 1);
  return close === -1 ? clean.slice(start).trim() : clean.slice(start, close + 1);
}

/**
 * Is this `data-testid` value a constant, rather than something computed at
 * runtime?
 *
 * One predicate for both `data-testid` scanners, over an expression the regex
 * captured whole.
 */
function isConstantTestIdExpr(expr) {
  if (/^(["'])[^"'`]*\1$/.test(expr)) return true;
  return expr.startsWith("`") && expr.endsWith("`") && !templateInterpolates(expr);
}

/**
 * Every `data-testid` given a runtime value through the props-object spelling.
 *
 * Separate from `dynamicDataAttrs`, which deliberately drops the name so the
 * curated-prop shape is not reported as a leak. Both callers below need the
 * object form as well as the JSX one, and this is the one place that knows it.
 * It returns the offending EXPRESSIONS rather than a boolean, because the
 * pre-unlock caller has to name them and applies one exemption of its own; the
 * ban-everywhere caller reads the length.
 */
export function interpolatedTestIdObjectForm(cleanSource) {
  return [...cleanSource.matchAll(/["']data-testid["']\s*:\s*/g)]
    .map((m) => valueAfter(cleanSource, m.index + m[0].length))
    .filter((expr) => !isConstantTestIdExpr(expr));
}

/**
 * `data-*` attributes fed an EXPRESSION rather than a string literal, in BOTH
 * forms a React tree can produce one.
 *
 * The JSX form (`data-x={expr}`) is the obvious one. The object form
 * (`"data-x": expr`, inside a props object a component later spreads) is the one
 * that shipped past this guard: `useScrollEdges` builds
 * `{ "data-fade-top": edges.top ? "true" : undefined }` and `CenteredCard`
 * spreads it onto the card every pre-unlock screen composes. Nothing in the
 * scanned files ever reads `data-x={`, so the attribute reached the DOM of the
 * screen where the account number is typed without this check seeing it.
 *
 * A string-literal value in either form is fine, which is what the negative
 * lookahead on the object form is for: `"data-mode": "compact"` is a constant.
 */
export function dynamicDataAttrs(source) {
  const clean = stripComments(source);
  const jsx = [...clean.matchAll(/(data-[a-z0-9-]+)=\{/g)].map((m) => m[1]);
  // The value's first non-space character is CAPTURED rather than excluded by a
  // lookahead. `\s*(?!["'`])` looks right and is not: `\s*` backtracks to zero
  // width, the lookahead then reads the space it gave up, the space is not a
  // quote, and every constant string matches. Capturing cannot backtrack past
  // itself.
  //
  // A BACKTICK is constant only when the template interpolates nothing, which is
  // `templateInterpolates` above and is deliberately NOT re-spelled here.
  // Excluding the backtick outright, which is what shipped, made
  // `` `${account}` `` read as a literal, and that is the one value shape most
  // likely to carry the account number into a props-object `data-*`: the whole
  // reason this arm exists. Scanning to the closing backtick can over-report if
  // a template contains an escaped one, and that direction is the safe one: a
  // false report costs an argument, a false silence costs the leak.
  const obj = [];
  for (const m of clean.matchAll(/["'](data-[a-z0-9-]+)["']\s*:\s*(\S)/g)) {
    const first = m[2];
    if (first === '"' || first === "'") continue;
    if (first === "`") {
      const start = m.index + m[0].length;
      const close = clean.indexOf("`", start);
      const body = close === -1 ? clean.slice(start) : clean.slice(start, close);
      if (!templateInterpolates(body)) continue;
    }
    obj.push(m[1]);
  }
  // `data-testid` has its own rule below, and a curated-prop component taking an
  // explicit `testId` (`src/CLAUDE.md`, "Test observability") is the sanctioned
  // shape rather than a leak. Reporting it here would say the wrong thing about
  // it, in a message about the account number.
  //
  // That exemption is only honest while the other rule actually covers the same
  // files. It did not: the interpolated-testid check ran over `webModules()` and
  // this budget now runs over the wider `preUnlockScope`, so an interpolated
  // `data-testid` in a shared primitive both pre-unlock screens render was
  // exempted here and unreached there. `main` now runs that check over the union.
  return [...jsx, ...obj].filter((a) => a !== "data-testid");
}

/**
 * The pre-unlock leak budget's real scope: the screens, plus every module in the
 * SHARED tree they compose, transitively.
 *
 * A screen is not the only file that renders it. `AccountNumberEntry` and
 * `WebNoAccount` both render `<CenteredCard>`, which is a shared primitive
 * outside `webModules()` entirely, so an attribute added there landed on both
 * screens with nothing checking it. Following the relative imports is what makes
 * the budget describe the DOM rather than a directory.
 *
 * Only relative specifiers are followed: a package import is not this tree's to
 * audit, and `@myne/*` packages render no `data-*` onto a pre-unlock screen
 * without going through one of these files first.
 */
export function preUnlockScope(roots) {
  const seen = new Set();
  const queue = [...roots];
  while (queue.length > 0) {
    const file = queue.pop();
    if (seen.has(file)) continue;
    let src;
    try {
      src = readFileSync(file, "utf8");
    } catch {
      continue; // a specifier that does not resolve to a file we scan
    }
    seen.add(file);
    for (const m of src.matchAll(/from\s+["'](\.[^"']+)["']/g)) {
      const base = join(dirname(file), m[1]);
      for (const cand of [`${base}.tsx`, `${base}.ts`, join(base, "index.tsx"), join(base, "index.ts")]) {
        try {
          if (statSync(cand).isFile()) {
            queue.push(relative(".", cand));
            break;
          }
        } catch {
          /* next candidate */
        }
      }
    }
  }
  return [...seen].sort();
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
  ["data-wall", "WebNoAccount's `no-account` / `no-sync` variant, a closed union."],
  [
    "data-fade-top",
    "Scroll geometry on `CenteredCard`: is there content above the viewport. " +
      "`\"true\" | undefined`, computed from `scrollTop` and never from anything " +
      "the user typed (`src/hooks/useScrollEdges.ts`).",
  ],
  [
    "data-fade-bottom",
    "The same, for content below. Both drive the `.myne-scroll-fade` mask in " +
      "`tokens.css` and carry no value the account-number field could reach.",
  ],
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
    // BOTH forms. `data-testid={expr}` in JSX, and `{ "data-testid": expr }` in
    // a props object, which nothing saw: `dynamicDataAttrs` filters the name out
    // on the stated grounds that "data-testid has its own rule below", and both
    // rules below matched only the JSX spelling. The props-object shape is
    // exactly what this feature was written for, since `useScrollEdges` returns
    // a `data-*` object that `CenteredCard` spreads onto every pre-unlock screen.
    const cleanSrc = stripComments(src);
    if (/data-testid=\{/.test(cleanSrc) || interpolatedTestIdObjectForm(cleanSrc).length > 0) {
      problems.push(
        `${f}: data-testid is interpolated. Use a stable name plus a discriminator ` +
          `attribute (src/CLAUDE.md, "Test observability").`,
      );
    }

  }

  // The leak budget, over the pre-unlock SCREENS plus everything in the shared
  // tree they compose. A dynamic `data-*` outside that set (a device row's id
  // hex, a note id) is the sanctioned discriminator pattern and is not checked.
  const roots = [
    ...SHARED_WEB_ONLY,
    ...files.filter((f) => f.startsWith(join("web", "src", "screens"))),
  ];
  const preUnlock = preUnlockScope(roots);
  // A COVERAGE CLAIM, not a walk that reports ok on whatever it happened to
  // find. `check-platform-seam.mjs` derives one for the same reason: a scope
  // that silently shrinks to nothing passes every check inside it. Two paths
  // reach that here without the floor, and both are one rename away: the
  // `web/src/screens` filter yielding `[]`, and a root that cannot be read.
  if (preUnlock.length < PRE_UNLOCK_FLOOR) {
    problems.push(
      `pre-unlock scope covers ${preUnlock.length} file(s), below the recorded ` +
        `floor of ${PRE_UNLOCK_FLOOR}. The leak budget checks what this walk ` +
        `finds, so a shrunken scope is a check that passed having scanned ` +
        `nothing. Raise the floor only when files genuinely left the tree.`,
    );
  }
  for (const f of preUnlock) {
    // The interpolated-testid rule, over the SAME set. Its exemption in
    // `dynamicDataAttrs` names this check as the backstop, so it has to reach
    // every file that exemption applies to.
    //
    // Narrowed to the CURATED-PROP shape rather than banned outright, because
    // `src/CLAUDE.md` ("Test observability") asks for exactly that shape:
    // `PasswordInput`, `DestructiveBanner` and `BlockingProgressStep` all take an
    // explicit `testId` / `testIdPrefix` so their caller names them, and all
    // three are composed by a pre-unlock screen. A value that comes from a prop
    // the caller chose is not a value the user typed; `data-testid={account}` is,
    // and that is what this catches.
    // Read once. `dynamicDataAttrs` below used to open the same file a second
    // time, in a second loop over a list this one already holds. It still does
    // its own strip, because it takes a source rather than a stripped one and
    // that is its contract with every other caller.
    const raw = readFileSync(f, "utf8");
    const preUnlockSrc = stripComments(raw);
    const interpolated = [
      // A constant string in either spelling is not a runtime value, and
      // `isConstantTestIdExpr` is the one place that decides which is which.
      ...[...preUnlockSrc.matchAll(/data-testid=\{\s*/g)]
        .map((m) => valueAfter(preUnlockSrc, m.index + m[0].length))
        .filter((expr) => !isConstantTestIdExpr(expr)),
      // The props-object spelling, which the JSX pattern above never matched.
      ...interpolatedTestIdObjectForm(preUnlockSrc),
    ];
    for (const expr of interpolated) {
      // BOTH alternatives anchored. `/testIdPrefix/` was a bare substring test,
      // so any expression merely CONTAINING the prop name was exempt, including
      // `` `${testIdPrefix}-${accountNumber}` ``. The exemption is for a value
      // the caller chose, which is the bare identifier and nothing else.
      if (/^testId$/.test(expr) || /^testIdPrefix$/.test(expr)) continue;
      problems.push(
        `${f}: data-testid={${expr}} takes a runtime value on (or under) a ` +
          `pre-unlock screen. Its value reaches the DOM like any other data-*, ` +
          `and the account number is typed on one of these screens (SYNC-7 leak ` +
          `budget). A caller-supplied \`testId\` prop is the sanctioned shape.`,
      );
    }

    // The leak budget itself, over the SAME file and the same strip. Two
    // consecutive loops over one list is two reads of every file for no reason;
    // the rules stay distinct because their messages and exemption sets are.
    const dynamic = dynamicDataAttrs(raw).filter((a) => !ALLOWED_DYNAMIC.has(a));
    if (dynamic.length > 0) {
      problems.push(
        `${f}: ${[...new Set(dynamic)].join(", ")} takes a runtime value on (or under) a ` +
          `pre-unlock screen. The account number is pre-unlock INPUT, and a data-* attribute ` +
          `puts it in the DOM, in screenshots, and in every CI failure artefact (SYNC-7 leak ` +
          `budget). If it is a closed-set discriminator, name it in ALLOWED_DYNAMIC with the ` +
          `reason.`,
      );
    }
  }

  if (problems.length > 0) {
    console.error(`web testids: ${problems.length} problem(s):\n` + problems.map((p) => `    ${p}`).join("\n"));
    process.exit(1);
  }

  const total = files.reduce((n, f) => n + testidsIn(readFileSync(f, "utf8")).length, 0);
  console.log(
    `web testids: ok (${files.length} web-only module(s), ${total} testid(s), ` +
      `${RENDERS_NOTHING.size} render-nothing substitution(s), ` +
      `${preUnlock.length} pre-unlock file(s) scanned for the leak budget)`,
  );
}

if (import.meta.url === `file://${process.argv[1]}`) main();
