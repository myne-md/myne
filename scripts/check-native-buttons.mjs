#!/usr/bin/env node
// Guard: no `<button>` ships wearing the browser's own chrome.
//
// The failure this prevents: Myne styles inline (`src/AGENTS.md` — no Tailwind,
// no CSS Modules, no styled-components), and `src/styles/tokens.css` carries NO
// base `button {}` rule — its only global button rule is the `:focus-visible`
// ring. So a `<button>` written with neither `className` nor `style` is not
// "styled a bit less"; it is drawn entirely by the user agent. Measured on the
// live web client before this guard existed:
//
//     border: 2px outset rgba(118,118,118,.3)   borderRadius: 0px
//     font:   13.3333px Arial                   padding: 1px 6px
//
// …on a card whose every other element was `--radius-2`, Inter and `--bg-2`.
// That was `account-entry.submit` — the primary CTA on the FIRST screen a new
// web user sees — plus three more in the same first-run flow.
//
// Nothing else in the toolchain reports this class:
//   - `tsc` is happy: a `<button>` needs no props.
//   - `check-token-adoption.mjs` counts hardcoded LITERALS, so a button with no
//     style at all scores zero and reads as exemplary. All four offenders were
//     recorded at 0 while rendering as Arial.
//   - No stylesheet covers for it — the whole `src/` tree holds 12 `className=`
//     uses, two of them toast.
// It is visible to the eye and to nothing else, which is exactly the shape that
// survives review and ships.
//
// # The two violations
//
//   1. NO STYLING AT ALL — neither `className` nor `style` on the tag.
//   2. LAYOUT-ONLY STYLE — a `style` that resolves to spacing/positioning with
//      no paint property (`background`, `border*`, `color`, `font*`,
//      `appearance`, `textDecoration`, `boxShadow`). `style={{ marginTop: … }}`
//      moves a native button down the page; it is still a native button.
//
// `padding` is deliberately NOT a paint property here: padding alone leaves the
// outset border and the Arial, so counting it would let the exact defect through
// under a fig leaf.
//
// # Why the scanner is not a regex
//
// A naive `/<button[^>]*>/` reports 85 violations in this tree when there are 4.
// JSX attribute values contain `>` constantly — every `onClick={() => …}` closes
// the tag early, and everything after it (including the `style` prop, which
// Prettier puts on a later line) is invisible to the match. So the tag end is
// found by walking forward with brace/quote depth, and `<button` mentions inside
// comments are excluded: all four of THIS repo's spurious hits are docblocks
// explaining button behaviour (`primitives/Switch.tsx`, `primitives/Tooltip.tsx`,
// `notes/components/ContextMenu.tsx`, `notes/components/DeleteConfirmModal.tsx`).
//
// # Resolution, and what it trusts
//
// `style={BTN}` / `style={btn(disabled)}` / `style={cond ? A : B}` are the
// common shapes (~90 call sites). Same-file identifiers are resolved one level
// and their bodies are searched for paint. An identifier IMPORTED from another
// module is trusted without resolution — a shared style constant is a deliberate
// decision, and chasing it across files would make this guard a type-checker.
//
// # There is no allowlist, on purpose
//
// It lands at zero. A guard with an exceptions file starts as a ratchet and ends
// as a list nobody reads; a new bare button here costs one line of real styling
// instead of one line of exemption.
//
// Run by hand: node scripts/check-native-buttons.mjs
// Wired into: lefthook `pre-commit`, CI `pnpm-build`.

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const ROOT = new URL("..", import.meta.url).pathname;

// Deliberately NOT `scripts/lib/shared-roots.mjs`, which that module asks a
// narrower guard to say out loud. One root there does not belong to this rule:
//
//   - `copy/`, `ornaments/`, `preview/` render no buttons; listing them would
//     imply a scope that has never had anything to find.
//
// `mobile/src` used to be excluded too, for two reasons that both expired when
// the mobile client moved in-repo: it was a companion REPO absent from CI, so
// scanning it meant 220 extra buttons locally and none on the runner — a gate
// that means something different on two machines — and it had its own review, so
// this repo did not get to fail its commits. Same repo, same CI, same review now,
// and the tree passes clean (447 buttons total), so it is simply in scope.
//
// What remains is exactly the tree compiled into a client that renders buttons.
const SCANNED_TREES = ["src", "web/src", "editor/src", "dialect/src", "mobile/src"];

/** A property whose presence means the button paints itself rather than letting
 *  the user agent do it. Prefix match, so `borderRadius`, `backgroundColor` and
 *  `fontFamily` are covered by their stems. */
const PAINT = /\b(background|border|color|font|appearance|textDecoration|boxShadow)/;

function* walk(dir) {
  let entries;
  try {
    entries = readdirSync(dir);
  } catch {
    return;
  }
  for (const name of entries) {
    const full = join(dir, name);
    let st;
    try {
      st = statSync(full);
    } catch {
      continue;
    }
    if (st.isDirectory()) yield* walk(full);
    else if (name.endsWith(".tsx")) yield full;
  }
}

const lineOf = (src, index) => src.slice(0, index).split("\n").length;

/**
 * Byte ranges covered by `/* … *\/` block comments — which is also the JSX
 * comment form `{/* … *\/}`. Quote state is deliberately not tracked: a `/*`
 * inside a string literal is not a shape this codebase contains, and treating
 * one as a comment would only ever SUPPRESS a report, never invent one.
 */
function blockCommentRanges(src) {
  const ranges = [];
  let i = 0;
  while ((i = src.indexOf("/*", i)) !== -1) {
    const end = src.indexOf("*/", i + 2);
    if (end === -1) {
      ranges.push([i, src.length]);
      break;
    }
    ranges.push([i, end + 2]);
    i = end + 2;
  }
  return ranges;
}

/** True when `index` sits inside a comment — a `//` earlier on its own line, or
 *  any block-comment range. `://` (a URL) does not open a comment. */
function inComment(src, index, ranges) {
  for (const [a, b] of ranges) {
    if (index >= a && index < b) return true;
  }
  const lineStart = src.lastIndexOf("\n", index - 1) + 1;
  const before = src.slice(lineStart, index);
  const slashes = before.indexOf("//");
  return slashes !== -1 && before[slashes - 1] !== ":";
}

/**
 * Advance past whatever starts at `i` and must not be read as code: a comment or
 * a string/template literal. Returns the index just after it, or `i` unchanged.
 *
 * Comments are handled BEFORE quotes, and that order is the whole point. A
 * handler inside a tag routinely carries prose — `// the join modal's answer` —
 * and reading that apostrophe as a string start swallows everything up to the
 * next one. In `AccountBootstrap.tsx` it swallowed 239 lines and four buttons,
 * one of which was a live violation, while the guard reported success.
 */
function skipNonCode(src, i) {
  const c = src[i];
  if (c === "/" && src[i + 1] === "/") {
    const nl = src.indexOf("\n", i);
    return nl === -1 ? src.length : nl;
  }
  if (c === "/" && src[i + 1] === "*") {
    const close = src.indexOf("*/", i + 2);
    return close === -1 ? src.length : close + 2;
  }
  if (c === '"' || c === "'" || c === "`") {
    let j = i + 1;
    while (j < src.length && src[j] !== c) {
      if (src[j] === "\\") j++;
      j++;
    }
    return j + 1;
  }
  return i;
}

/**
 * Index of the `>` that closes an opening tag whose attributes start at `from`.
 * Walks brace depth (so `onClick={() => f()}` cannot close it) and skips
 * comments and literals (so `aria-label="a > b"` cannot either). Returns -1 when
 * the tag never closes, which is a parse the caller should skip rather than
 * guess at.
 */
function tagEnd(src, from) {
  let depth = 0;
  for (let i = from; i < src.length; i++) {
    const skipped = skipNonCode(src, i);
    if (skipped !== i) {
      i = skipped - 1;
      continue;
    }
    const c = src[i];
    if (c === "{") depth++;
    else if (c === "}") depth--;
    else if (c === ">" && depth === 0) return i;
  }
  return -1;
}

/** The text of a `style={…}` prop's expression, braces stripped, or null. */
function styleExpression(attrs) {
  const at = attrs.search(/\bstyle\s*=\s*\{/);
  if (at === -1) return null;
  const open = attrs.indexOf("{", at);
  let depth = 0;
  for (let i = open; i < attrs.length; i++) {
    const skipped = skipNonCode(attrs, i);
    if (skipped !== i) {
      i = skipped - 1;
      continue;
    }
    const c = attrs[i];
    if (c === "{") depth++;
    else if (c === "}") {
      depth--;
      if (depth === 0) return attrs.slice(open + 1, i);
    }
  }
  return attrs.slice(open + 1);
}

/**
 * Body text of a same-file `const NAME = …` or `function NAME(…)`, so a
 * `style={BTN}` / `style={btn(x)}` reference can be searched for paint.
 * Returns null when the name is not defined in this file — i.e. it is imported,
 * and therefore a shared style this guard trusts.
 */
function localDefinition(src, name) {
  const decl = new RegExp(
    `(?:const|let)\\s+${name}\\b[^=]*=|function\\s+${name}\\s*\\(`,
  );
  const m = decl.exec(src);
  if (m === null) return null;
  // Everything up to the next top-level declaration is close enough: the search
  // is for a property NAME, and over-reading can only make a violation look
  // painted, which the empty landing state would immediately expose.
  const from = m.index;
  const next = src.slice(from + m[0].length).search(/\n(?:const|let|function|export|\/\*\*)/);
  return next === -1 ? src.slice(from) : src.slice(from, from + m[0].length + next);
}

/** Quoted and templated content, blanked. Without this, the `--space-3` inside
 *  `"var(--space-3)"` reads as an identifier named `space`, which resolves to
 *  nothing, which the reference rule below would charitably call an import — and
 *  a layout-only style would pass on the strength of its own token name. */
const stripStrings = (text) => text.replace(/(["'`])(?:\\.|(?!\1)[\s\S])*?\1/g, '""');

/**
 * Identifiers in a style expression that REFER to something, as opposed to
 * naming a property. `{ marginTop: … }` is a key (preceded by `{` or `,`,
 * followed by `:`); `? A : B`, `...A` and `f(x)` are references. Getting this
 * wrong in the lenient direction is what would let the layout-only violation
 * through, since an unresolvable name is trusted as an import.
 */
function* references(text) {
  for (const m of text.matchAll(/[A-Za-z_$][\w$]*/g)) {
    const name = m[0];
    if (name === "var") continue;
    const before = text.slice(0, m.index).replace(/\s+$/, "");
    const after = text.slice(m.index + name.length).replace(/^\s+/, "");
    const prev = before[before.length - 1];
    if ((prev === "{" || prev === "," || prev === undefined) && after[0] === ":") continue;
    if (prev === "." && before[before.length - 2] !== ".") continue; // member access
    yield name;
  }
}

/** Does this style expression paint, following same-file references? */
function paints(src, expression, seen = new Set()) {
  const text = stripStrings(expression);
  if (PAINT.test(text)) return true;
  if (seen.size > 8) return true; // pathological chain: stop, do not accuse
  for (const name of references(text)) {
    if (seen.has(name)) continue;
    seen.add(name);
    const body = localDefinition(src, name);
    if (body === null) return true; // imported → a deliberate shared style
    if (paints(src, body, seen)) return true;
  }
  return false;
}

/** EXPORTED so a spec can assert on the finding list rather than restate the
 *  rule — the same reason `check-prefs-nonce.mjs` exports its `analyse`. */
export function analyse() {
  const violations = [];
  let scanned = 0;

  for (const tree of SCANNED_TREES) {
    for (const file of walk(join(ROOT, tree))) {
      const src = readFileSync(file, "utf8");
      if (!src.includes("<button")) continue;
      const rel = relative(ROOT, file);
      const ranges = blockCommentRanges(src);

      let i = 0;
      while ((i = src.indexOf("<button", i)) !== -1) {
        const after = i + "<button".length;
        // `<buttonish>` is a different element, not this one.
        if (/[\w$]/.test(src[after] ?? "")) {
          i = after;
          continue;
        }
        if (inComment(src, i, ranges)) {
          i = after;
          continue;
        }
        const end = tagEnd(src, after);
        if (end === -1) {
          i = after;
          continue;
        }
        const attrs = src.slice(after, end);
        scanned++;

        if (!/\bclassName\s*=/.test(attrs)) {
          const expression = styleExpression(attrs);
          if (expression === null) {
            violations.push({
              file: rel,
              line: lineOf(src, i),
              why: "has neither className nor style, so the user agent draws it — 2px outset border, Arial, square corners. There is no base `button {}` rule in tokens.css to fall back on. Give it the surface's own CTA style (`ctaStyle()` from components/primitives/CenteredCard) or the `<Button>` primitive.",
            });
          } else if (!paints(src, expression)) {
            violations.push({
              file: rel,
              line: lineOf(src, i),
              why: "carries a style with no paint property (background / border / color / font / appearance) — spacing alone moves a native button, it does not stop it being one. Spread the surface's CTA style in alongside the spacing.",
            });
          }
        }
        i = end;
      }
    }
  }

  return { violations, scanned };
}

// ── CLI ─────────────────────────────────────────────────────────────────────
if (import.meta.url === `file://${process.argv[1]}`) {
  const { violations, scanned } = analyse();

  if (violations.length > 0) {
    for (const v of violations) {
      console.error(`✗ native-button: ${v.file}:${v.line}\n  ${v.why}`);
    }
    console.error(
      `\n${violations.length} button(s) rendering browser chrome. See scripts/check-native-buttons.mjs for why this rule exists.`,
    );
    process.exit(1);
  }

  console.log(
    `native-buttons: ok (${scanned} <button> element(s) styled across ${SCANNED_TREES.join(", ")})`,
  );
}
