#!/usr/bin/env node
// The web client's E2E observability contract (phase3-web-client task 100).
//
// # Why this needs a script when the desktop convention does not have one
//
// `src/AGENTS.md` states the rule flatly — "a screen without testids is
// invisible to E2E" — and every `data-testid` attribute in `src/` is held to it
// by **review alone**. That works while every screen has an owner who reviews
// it. The web client's screens do not: tasks 61/59/74/105/106 CONSUME testids
// (`byTestId` is the only sanctioned selector in `e2e/AGENTS.md`), while the
// tasks that BUILT these screens never mention `data-*` at all. An unowned
// convention is not a convention; it is a gap with a policy written next to it.
//
// # The three things it checks
//
// 1. **Every web-only rendering module carries at least one selector** — a
//    `data-testid` of its own, or a `testId` / `testIdPrefix` literal it hands
//    to a curated-prop child. A screen with neither is unreachable from the
//    suite that is supposed to prove it works. The SHARED web-only screens are
//    DERIVED from `check-web-screens.mjs`'s `web-only` verdicts rather than
//    listed here: the hand-kept pair this started as left three of five unscanned
//    while the header claimed "every" (audit 2026-10-18 R0.2).
// 2. **Every testid is `<screen>.<element>`.** The naming rule is what lets a
//    scenario guess a selector instead of grepping for it.
// 3. **No `data-*` attribute is fed a runtime expression** in the pre-unlock
//    web screens. This is the SYNC-7 leak budget, and its sharpest case is the
//    account number: it is pre-unlock INPUT, so `data-value={account}` is one
//    keystroke away and would put it in the DOM, in screenshots, and in every
//    failure artefact CI keeps.

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";

import { VERDICTS } from "./check-web-screens.mjs";

/** Web-only rendering modules: everything under `web/src` that renders. */
const WEB_DIR = join("web", "src");

/**
 * Web-only screens that live in the SHARED tree because they are stages
 * (`src/lib/stage.ts` owns their names), reachable only on this client.
 *
 * **DERIVED, not listed.** It used to be a hand-kept pair
 * (`AccountNumberEntry`, `WebNoAccount`) under a header claiming "every web-only
 * rendering module carries at least one testid" — so `AccountBootstrap` (which
 * is where the account number is actually TYPED), `DeviceRevoked` and
 * `ProvisioningStep` were outside the guard while it printed ok (audit 2026-10-18
 * R0.2). `check-web-screens.mjs` already owns the verdict for every file under
 * `src/screens/`, and `web-only` is exactly this set, so a sixth web-only screen
 * now enters this guard on the same commit that adds its verdict instead of
 * needing a second edit here that nobody would make.
 *
 * The import direction is one-way on purpose: `check-web-screens.mjs` reads a
 * directory and a roster of its own, and knows nothing about testids. A cycle
 * would be the alternative, and it is the reason the two rules stay in separate
 * files.
 */
export function sharedWebOnlyScreens(verdicts = VERDICTS) {
  return Object.entries(verdicts)
    .filter(([, v]) => v.verdict === "web-only")
    .map(([file]) => join("src", "screens", file))
    .sort();
}

export const SHARED_WEB_ONLY = sharedWebOnlyScreens();

/**
 * Fewest shared web-only screens the derivation may yield before it is suspect.
 *
 * Recorded from a real run (5 when the derivation landed), the same shape as
 * `PRE_UNLOCK_FLOOR` below and for the same reason: a derivation that yields
 * NOTHING passes every rule inside it. That is not hypothetical here — renaming
 * one `web-only` verdict to `adapted` in the neighbour's table would silently
 * drop that screen out of this guard, which is exactly the class R0.2 fixed.
 * It may rise with the tree; lowering it is the edit that is never routine.
 */
const SHARED_WEB_ONLY_FLOOR = 4;

/**
 * Modules that legitimately render NOTHING, so "at least one testid" cannot
 * apply. Each is a substitution whose whole job is to be absent — and each is
 * already covered by an absence marker in `check-web-surfaces.mjs`, which is a
 * stronger check than a testid would be.
 *
 * **Compared both ways, like every roster in this repository.** Five entries
 * were stale when R0.2 landed: the phrase-ban removal (2026-10-18, entry 0704)
 * deleted those `web/src` substitutes, so the list was describing files that no
 * longer existed and nothing failed. A stale exemption is worse than a missing
 * one — it reads as a decision that was made about a file that is gone.
 */
const RENDERS_NOTHING = new Set([
  join("web", "src", "components", "PairingDialog.tsx"),
  join("web", "src", "components", "settings", "ConnectedExtensions.tsx"),
  join("web", "src", "components", "backup", "BackupExportModal.tsx"),
  join("web", "src", "main.tsx"), // the entry point; mounts, renders no markup of its own
]);

/** `<screen>.<element>`, lowercase, dot-separated, hyphens inside a segment. */
const NAME = /^[a-z][a-z0-9-]*(\.[a-z0-9-]+)+$/;

/**
 * Shared screens that render BEFORE any vault is unlocked, and so are roots of
 * the leak budget in their own right.
 *
 * **Listed rather than derived, and checked both ways.** Whether a screen
 * mounts pre-unlock lives in `src/App.tsx`'s stage switch, which this script
 * cannot read; `check-web-screens.mjs`'s `ported` verdict says the screen SHIPS
 * on web and nothing about WHEN it mounts (`Editor.tsx` is `adapted` and is the
 * most post-unlock file in the tree). The note that licensed `PRE_UNLOCK_FLOOR`
 * 39 claimed the shared picker was already in the walk on the strength of that
 * verdict, and it was not: `webModules()` is `walk(web/src)` plus the
 * `web-only` verdicts, and `VaultPicker.tsx` / `IdentityHome.tsx` are both
 * `ported` (myne-md/myne#911 review).
 *
 * These are roots for the PER-FILE rules only: `preUnlockScope` deliberately
 * does NOT follow their imports. `VaultPicker` imports `lib/vault-unlock.ts`,
 * which is the door into the whole unlocked app (the editor, the note stores,
 * the dialect), so following it turns a 41-file pre-unlock budget into a
 * 162-file app-wide one whose messages then say "the account number is
 * pre-unlock INPUT" about post-unlock code. The primitive walk still starts
 * from the web-only roots, which is what it was built for.
 */
export const SHARED_PRE_UNLOCK_SCREENS = Object.freeze([
  join("src", "screens", "VaultPicker.tsx"),
  join("src", "screens", "IdentityHome.tsx"),
]);

/**
 * Fewest files the pre-unlock walk may cover before the walk itself is suspect.
 *
 * Recorded from a real run (41 when the shared pre-unlock screens joined the
 * walk, 40 when R0.2 widened the roots to every derived web-only screen, 15
 * before that), not invented, and it may rise as the tree grows.
 * Lowering it is the edit that is never routine: it means the account-number
 * screens compose less than they did, which is either a real simplification
 * worth saying out loud or a walk that has stopped finding things.
 *
 * **41 -> 24, `decisions/sync/0767`, and this is the largest drop this number
 * has taken.** The account-number join door was deleted, so `AccountBootstrap`
 * and `AccountNumberEntry` left the tree and with them the roots that pulled
 * `PasswordInput`, `Spinner`, `BetaTermsConsent`, `DestructiveBanner` and the
 * number field into the walk. What replaced them is `PendingApproval`, which
 * composes `CenteredCard`, `DestructiveBanner` and the shared compare hook.
 * Recorded as a real simplification rather than a walk that stopped finding
 * things: the screens that consumed those primitives are gone, and the primitive
 * walk still starts from every derived web-only root.
 *
 * **40 -> 39 -> 41, myne-md/myne#911, and 39 lasted one review.** The browser's
 * own `VaultPicker` substitute was deleted (one origin can hold several
 * containers now) and the note that licensed 39 said the shared
 * `src/screens/VaultPicker.tsx` had taken its place in the walk. It had not:
 * that file is verdicted `ported` and the walk was `web/src` plus the
 * `web-only` verdicts, so the number moved while the scope did not.
 * `SHARED_PRE_UNLOCK_SCREENS` above carries the picker and `IdentityHome` as
 * roots now, which is 39 + 2 = 41, and the picker's `picker.vault-row` testid
 * is asserted by `e2e-web/multi-vault.e2e.ts`.
 */
const PRE_UNLOCK_FLOOR = 24;

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

/**
 * Selectors a module hands to a CURATED-PROP child: `testId="…"` and
 * `testIdPrefix="…"` string literals.
 *
 * `src/AGENTS.md` ("Test observability") names this as the sanctioned shape for a
 * component whose caller chooses the name — `PasswordInput`, `DestructiveBanner`
 * and `BlockingProgressStep` all take one. A screen whose whole observability
 * contract is "it passes `create.provisioning` to the progress step" IS
 * observable, and scoring it as having no testid would be the guard asserting
 * something untrue about it. `ProvisioningStep.tsx` is that screen (audit R0.2):
 * before this, it was simply absent from the walked set, and adding it without
 * this would have produced a false finding.
 *
 * Only STRING LITERALS count. An interpolated `testId={…}` is not a stable
 * selector and is covered by the `data-testid` interpolation rule, which is
 * where the message about variant sets already lives.
 */
export function curatedTestIdProps(source) {
  return [...source.matchAll(/\btestId(?:Prefix)?="([^"]*)"/g)].map((m) => m[1]);
}

/** Exemption entries whose file is gone, so a `RENDERS_NOTHING` decision cannot
 *  outlive the substitution it was made about. */
export function staleRenderNothingEntries(set = RENDERS_NOTHING, exists = existsSync) {
  return [...set].filter((f) => !exists(f));
}

/** Every selector `source` offers: its own `data-testid`s and the curated props
 *  it passes down. */
export function selectorsIn(source) {
  return [...testidsIn(source), ...curatedTestIdProps(source)];
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
 * The value expression starting at `start` inside a JSX `data-*={…}`, balanced
 * over the closing brace.
 *
 * It used to stop at the first `,` or `}`, which cut a TEMPLATE at its own
 * interpolation and a TERNARY at the first `}`: `testId === undefined ?
 * "modal-close" : \`${testId}-close\`` was captured as a mangled prefix, so the
 * caller-supplied exemption below was asked about a string that was not the
 * expression. Balanced scanning is what makes the value under test the value in
 * the file. A quote or a template is skipped as a unit so a `}` inside a string
 * cannot close the expression early.
 */
function jsxExprAt(clean, start) {
  let i = start;
  for (; i < clean.length; i++) {
    const c = clean[i];
    if (c === "}" || c === "\n") break;
    if (c === '"' || c === "'") {
      i++;
      while (i < clean.length && clean[i] !== c) if (clean[i++] === "\\") i++;
    } else if (c === "`") {
      i++;
      while (i < clean.length && clean[i] !== "`") if (clean[i++] === "\\") i++;
    }
  }
  return clean.slice(start, i).trim();
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
 * This one stays for the PROPS-OBJECT form, where a comma really does end the
 * value and no closing brace belongs to the expression; the JSX form uses
 * `jsxExprAt`, which balances braces instead.
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
 * Identifiers an expression may name and still count as CALLER-SUPPLIED.
 *
 * `src/AGENTS.md` ("Test observability") sanctions a curated prop: the caller
 * names the selector via `testId` / `testIdPrefix`, so a value derived from one
 * is not a value the user typed. `props` rides along because the props-object
 * spelling (`data-testid={props.testId}`) is the same thing one layer down —
 * and it cannot smuggle anything in, because every OTHER identifier is rejected:
 * `props.accountNumber` fails on `accountNumber`, not on `props`.
 *
 * `undefined` / `true` / `false` / `null` are there for a fallback
 * (`testId === undefined ? "modal-close" : \`${testId}-close\``), which is the
 * shape `ModalShell` uses.
 */
const CALLER_TESTID_IDENTIFIERS = new Set([
  "testId",
  "testIdPrefix",
  "props",
  "undefined",
  "true",
  "false",
  "null",
]);

/**
 * Drop string literals and a template's literal TEXT, keeping its `${…}` bodies,
 * so the identifiers that remain are the ones the code actually names.
 *
 * Without this a literal like `"modal-close"` contributes `modal` and `close`,
 * which would reject a legitimate expression; with it, `` `${testId}-close` ``
 * contributes exactly `testId`.
 */
function codeOnly(expr) {
  return expr
    .replace(/`(?:\\.|[^`\\])*`/g, (tpl) =>
      [...tpl.matchAll(/\$\{([^}]*)\}/g)].map((m) => ` ${m[1]} `).join(" "),
    )
    .replace(/"(?:\\.|[^"\\])*"/g, " ")
    .replace(/'(?:\\.|[^'\\])*'/g, " ");
}

/**
 * Is this runtime `data-testid` expression built ONLY from caller-supplied
 * identifiers?
 *
 * This started as `/^testId$|^testIdPrefix$/`, a substring test, on the stated
 * grounds that "the exemption is for a value the caller chose, which is the bare
 * identifier and nothing else". Two real spellings of that value were therefore
 * reported as leaks when R0.2 widened the scanned set — a props object and a
 * caller value with a fallback — and both are exactly what the exemption is FOR.
 * So the test is structural now: every identifier names a sanctioned source, and
 * a leak shape still fails because its extra identifier is not on the list.
 */
export function isCallerSuppliedTestIdExpr(expr) {
  const identifiers = [...codeOnly(expr).matchAll(/[A-Za-z_$][\w$]*/g)].map((m) => m[0]);
  if (identifiers.length === 0) return false;
  return identifiers.every((id) => CALLER_TESTID_IDENTIFIERS.has(id));
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
  // explicit `testId` (`src/AGENTS.md`, "Test observability") is the sanctioned
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
 * A screen is not the only file that renders it. `PendingApproval` and
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
 * and `src/AGENTS.md` asks for exactly that shape. The rule is that each one is
 * a DECISION: the attribute is named here, its value is a closed set the code
 * controls, and adding a new one means reading this comment. What must never
 * appear is a value the USER typed, and on these screens the user types an
 * account number.
 */
const ALLOWED_DYNAMIC = new Map([
  ["data-wall", "WebNoAccount's `no-account` / `no-sync` variant, a closed union."],
  // The invitations row on the pre-unlock picker (`src/screens/VaultPicker.tsx`).
  // A closed union the CODE controls (`"count" | "not-enrolled" | "pending"`), and
  // each member says which of three FIXED sentences the row renders, so a test can
  // tell "2 invitations waiting" from "register this identity to see invitations"
  // without asserting copy. No user input reaches it and it carries no account
  // value; the row exists on this screen at all because an unregistered identity
  // cannot list invitations, and a count-only row would have rendered nothing
  // (`decisions/protocol/0732`, `decisions/ui/0725`).
  [
    "data-invites",
    "Which arm of the invitations row is up: `count` / `not-enrolled` / `pending`.",
  ],
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
  // The three below entered this budget when R0.2 derived the scanned set from
  // `check-web-screens.mjs`'s `web-only` verdicts: the two screens the roster had
  // named by hand did not compose `Button`, `Input` or `DeviceRevoked`, so their
  // `data-*` decisions had never been asked for. All three are closed sets the
  // CODE controls, which is the distinction this map records rather than a
  // general permission.
  [
    "data-variant",
    "`Button`'s own variant — the closed union `primary | secondary | ghost | " +
      "danger` it declares in `src/components/primitives/Button.tsx`. It says " +
      "which of the primitive's own skins is applied; no user input reaches it.",
  ],
  [
    "data-mono",
    "`Input`'s boolean prop, rendered as `\"true\" | undefined`. Set by the " +
      "caller at the call site (the account-number field is one of its mono " +
      "consumers) and never derived from what is typed into it.",
  ],
  [
    "data-invalid",
    "The same shape on the same primitive: `invalid === true ? \"true\" : " +
      "undefined`. It reports the primitive's own state, and the value reaches " +
      "the DOM as a two-valued string.",
  ],
  [
    "data-erased",
    "`DeviceRevoked`'s local `erased` boolean, rendered as `\"true\" | " +
      "\"false\"`. It records whether this browser's copy has been deleted — a " +
      "fact about this browser's own storage, which the screen states in full " +
      "text beside it. The account number is not on this screen and cannot reach " +
      "this attribute.",
  ],
  [
    "data-vault-id",
    "`VaultPicker`'s row discriminator: the vault's own opaque id, which the " +
      "scenario selects by (`e2e-web/multi-vault.e2e.ts`). It is a `VaultId`, " +
      "not anything the user typed, and the pre-unlock screen shows no account " +
      "number, the picker's only pre-unlock leak is vault count and last-unlock " +
      "times, both of which it renders as text by design (SYNC-7 / SYNC-3).",
  ],
]);

function main() {
  const files = webModules();
  const problems = [];

  // The derivation's own floor, checked BEFORE the walk it guards. See
  // `SHARED_WEB_ONLY_FLOOR`: a `web-only` verdict renamed to `adapted` in
  // `check-web-screens.mjs` would drop a screen out of this guard in silence.
  if (SHARED_WEB_ONLY.length < SHARED_WEB_ONLY_FLOOR) {
    problems.push(
      `the web-only roster derived from check-web-screens.mjs covers ` +
        `${SHARED_WEB_ONLY.length} screen(s), below the recorded floor of ` +
        `${SHARED_WEB_ONLY_FLOOR}. The rules below check what this list contains, ` +
        `so a shrunken derivation is a check that passed having looked at nothing. ` +
        `A verdict renamed to \`adapted\`/\`excluded\` is the usual cause.`,
    );
  }

  // The exemption list, compared BOTH ways. A `null`-returning substitution
  // that has been deleted leaves an entry behind, and an entry describing a file
  // that is gone reads as a decision somebody made — which is why the sibling
  // guards (`check-unwired.mjs`, `check-ipc-binding-callers.mjs`) fail on it too.
  for (const f of staleRenderNothingEntries()) {
    problems.push(
      `${f} is recorded in RENDERS_NOTHING but does not exist. A substitution ` +
        `that has been removed leaves the exemption describing a file nobody ` +
        `can open. Delete the entry with the file.`,
    );
  }

  // The shared pre-unlock roots, compared BOTH ways for the same reason the
  // exemption list is: an entry naming a deleted screen reads as a scope that
  // covers something, and the rules below would then check one file fewer while
  // the floor absorbed it.
  for (const f of SHARED_PRE_UNLOCK_SCREENS) {
    if (!existsSync(f)) {
      problems.push(
        `${f} is recorded in SHARED_PRE_UNLOCK_SCREENS but does not exist. The ` +
          `pre-unlock leak budget is only as wide as this list; delete the entry ` +
          `with the screen, and re-record PRE_UNLOCK_FLOOR.`,
      );
    }
  }

  for (const f of files) {
    const src = readFileSync(f, "utf8");
    const ids = selectorsIn(src);
    if (ids.length === 0 && !RENDERS_NOTHING.has(f)) {
      problems.push(
        `${f}: renders with no selector — the web suite cannot reach it. Either give ` +
          `it a \`data-testid\`, or pass a \`testId\`/\`testIdPrefix\` literal to a ` +
          `curated-prop child (src/AGENTS.md, "Test observability"), or add it to ` +
          `RENDERS_NOTHING with the reason if it renders nothing.`,
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
          `attribute (src/AGENTS.md, "Test observability").`,
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
  // The shared pre-unlock SCREENS are appended rather than walked, and the
  // difference is load-bearing: `preUnlockScope` follows relative imports, and
  // `VaultPicker` imports `lib/vault-unlock.ts`, the module that reaches the
  // entire unlocked app. Walking them would make the budget claim to be about
  // pre-unlock code while it scanned the editor and the note stores; see
  // `SHARED_PRE_UNLOCK_SCREENS`. A missing entry is reported by the stale check
  // above, so it is filtered here rather than left for `readFileSync` to throw
  // on before those problems are printed.
  const preUnlock = [
    ...new Set([
      ...preUnlockScope(roots),
      ...SHARED_PRE_UNLOCK_SCREENS.filter((f) => existsSync(f)),
    ]),
  ].sort();
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
    // `src/AGENTS.md` ("Test observability") asks for exactly that shape:
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
      // `jsxExprAt` balances the braces, so a ternary or a template is the
      // expression the file contains rather than a prefix of it.
      ...[...preUnlockSrc.matchAll(/data-testid=\{\s*/g)]
        .map((m) => jsxExprAt(preUnlockSrc, m.index + m[0].length))
        .filter((expr) => !isConstantTestIdExpr(expr)),
      // The props-object spelling, which the JSX pattern above never matched.
      ...interpolatedTestIdObjectForm(preUnlockSrc),
    ];
    for (const expr of interpolated) {
      // The curated-prop shape, structurally rather than by name-matching the
      // bare identifier: `props.testId` and a `testId`-derived fallback are the
      // same sanctioned thing, and `` `${testIdPrefix}-${accountNumber}` `` is
      // still reported because `accountNumber` is not on the list.
      if (isCallerSuppliedTestIdExpr(expr)) continue;
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

  const total = files.reduce((n, f) => n + selectorsIn(readFileSync(f, "utf8")).length, 0);
  console.log(
    `web testids: ok (${files.length} web-only module(s), ${total} selector(s), ` +
      `${RENDERS_NOTHING.size} render-nothing substitution(s), ` +
      `${preUnlock.length} pre-unlock file(s) scanned for the leak budget)`,
  );
}

if (import.meta.url === `file://${process.argv[1]}`) main();
