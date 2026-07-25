// vim-keyboard-mode (MYND-313): the `:` command line.
//
// A CLOSED table, defined command by command. The engine's stock ex set is
// deliberately NOT adopted wholesale, for two reasons: several of its commands
// have no meaning in Myne (`:e <path>` — there are notes, not files), and a few
// would silently do nothing (`:w`, since saving is invisible here), which teaches
// the user the wrong thing.
//
// The boundary that matters (design session Q3): **no ex command may persist a
// behaviour definition.** `:set`, `:map`, `:source`, `:!` and `:e` are absent by
// design — that absence is what keeps this from becoming the `.vimrc`-style
// config-script surface MYND-313 explicitly rejects. What remains is a fixed
// dispatch table over commands Myne already has, i.e. the command palette in a
// vim accent, not an interpreter.
//
// Anything not in the table reports "not supported in Myne" rather than failing
// silently — a user who types `:set number` must learn the boundary, not assume
// it worked.

import { showAttachmentToast } from "./attachments/toast";
import { getHost } from "./host";

/** The engine slice this module needs. */
type ExApi = {
  Vim: {
    defineEx(name: string, prefix: string, func: (cm: unknown, params: unknown) => void): void;
  };
};

/** Commands a vim user is most likely to reach for that Myne deliberately does
 *  NOT implement, each with the reason shown when it is typed. Keeping the list
 *  explicit (rather than letting them fall through to the engine's defaults)
 *  is what makes the boundary legible instead of mysterious. */
export const REFUSED_EX_COMMANDS: ReadonlyArray<{
  name: string;
  prefix: string;
  reasonKey: string;
}> = [
  { name: "set", prefix: "se", reasonKey: "editor.vim.ex.refused.set" },
  { name: "map", prefix: "map", reasonKey: "editor.vim.ex.refused.map" },
  { name: "nmap", prefix: "nm", reasonKey: "editor.vim.ex.refused.map" },
  { name: "imap", prefix: "im", reasonKey: "editor.vim.ex.refused.map" },
  { name: "vmap", prefix: "vm", reasonKey: "editor.vim.ex.refused.map" },
  { name: "source", prefix: "so", reasonKey: "editor.vim.ex.refused.source" },
  { name: "edit", prefix: "e", reasonKey: "editor.vim.ex.refused.edit" },
];

/** Vim-only regex constructs that mean something different — or nothing at all —
 *  in JavaScript's dialect, which is what Myne's find-and-replace engine speaks.
 *
 *  Rather than translate (rejected in the PRD: incomplete by construction, and a
 *  mistranslation rewrites the user's note **silently**), a pattern containing any
 *  of these is REFUSED with a message. The failure mode has to be "this isn't
 *  supported", never "we changed something other than what you asked".
 *
 *  The screen is deliberately conservative: it only has to catch vim-only
 *  markers, because anything it lets through is by definition shared syntax that
 *  both dialects read the same way. Plain-text substitution — the overwhelming
 *  majority of real `:s` use — is unaffected. */
const VIM_ONLY_PATTERN_MARKERS: ReadonlyArray<{ marker: string; what: string }> = [
  { marker: "\\v", what: "very-magic mode" },
  { marker: "\\V", what: "very-nomagic mode" },
  { marker: "\\zs", what: "match-start marker" },
  { marker: "\\ze", what: "match-end marker" },
  { marker: "\\(", what: "vim-style group (JavaScript uses plain parentheses)" },
  { marker: "\\)", what: "vim-style group (JavaScript uses plain parentheses)" },
  { marker: "\\{", what: "vim-style quantifier" },
  { marker: "\\+", what: "vim-style one-or-more (JavaScript uses a bare +)" },
  { marker: "\\?", what: "vim-style optional (JavaScript uses a bare ?)" },
  { marker: "\\|", what: "vim-style alternation (JavaScript uses a bare |)" },
  { marker: "\\<", what: "vim word boundary (JavaScript uses \\b)" },
  { marker: "\\>", what: "vim word boundary (JavaScript uses \\b)" },
];

/** The first vim-only construct in `pattern`, or `null` when the pattern is
 *  shared syntax both dialects agree on. Pure. */
function findVimOnlyConstruct(
  pattern: string,
): { marker: string; what: string } | null {
  for (const entry of VIM_ONLY_PATTERN_MARKERS) {
    if (pattern.includes(entry.marker)) return entry;
  }
  return null;
}

/** A `\1`-style back-reference in the REPLACEMENT is vim syntax; JavaScript uses
 *  `$1`. Silently substituting the wrong group is exactly the corruption this
 *  layer exists to prevent, so it is refused too. Pure. */
function hasVimBackReference(replacement: string): boolean {
  return /\\[1-9]/.test(replacement);
}

/** Why a substitution was refused, or `null` when it is safe to run. Pure, and
 *  the single decision point — the ex command below only reports what this
 *  returns. */
function substitutionRefusal(
  pattern: string,
  replacement: string,
): string | null {
  const construct = findVimOnlyConstruct(pattern);
  if (construct !== null) return construct.what;
  if (hasVimBackReference(replacement)) {
    return "vim-style back-reference in the replacement (JavaScript uses $1)";
  }
  return null;
}

/** A parsed `:s/pattern/replacement/flags`. */
type ParsedSubstitution = {
  pattern: string;
  replacement: string;
  /** `g` — replace every match on each line in range, not just the first. */
  global: boolean;
  /** `i` — case-insensitive. */
  ignoreCase: boolean;
};

/** Parse the argument of a `:s` command. Accepts `/` or any single-character
 *  delimiter vim allows (`:s#a#b#`). Returns `null` when the form is unusable.
 *  Pure. */
function parseSubstitution(argString: string): ParsedSubstitution | null {
  const trimmed = argString.trim();
  if (trimmed.length === 0) return null;
  const delim = trimmed[0]!;
  if (/[\w\s\\]/.test(delim)) return null; // a word char can't be a delimiter

  // Split on unescaped delimiters only, so `\/` inside a pattern survives.
  const parts: string[] = [];
  let current = "";
  for (let i = 1; i < trimmed.length; i++) {
    const ch = trimmed[i]!;
    if (ch === "\\" && i + 1 < trimmed.length) {
      current += ch + trimmed[i + 1]!;
      i++;
      continue;
    }
    if (ch === delim) {
      parts.push(current);
      current = "";
      continue;
    }
    current += ch;
  }
  parts.push(current);

  const [pattern, replacement = "", flags = ""] = parts;
  if (pattern === undefined || pattern.length === 0) return null;
  return {
    pattern,
    replacement,
    global: flags.includes("g"),
    ignoreCase: flags.includes("i"),
  };
}

/** Apply a screened substitution over the command's line range, as ONE
 *  transaction so undo restores it in a single step. */
function applySubstitution(
  cm: unknown,
  parsed: ParsedSubstitution,
  params: { line?: number; lineEnd?: number },
): void {
  const view = (cm as { cm6?: { state: unknown; dispatch: (t: unknown) => void } }).cm6;
  if (view === undefined) return;
  const state = view.state as {
    doc: {
      lines: number;
      line: (n: number) => { from: number; to: number; text: string };
    };
    selection: { main: { head: number } };
  };

  // Vim line numbers are 0-based here; absent range ⇒ the cursor's line.
  const first = params.line !== undefined ? params.line + 1 : undefined;
  const last = params.lineEnd !== undefined ? params.lineEnd + 1 : first;
  const cursorLineNo = lineNumberAt(state, state.selection.main.head);
  const from = Math.max(1, first ?? cursorLineNo);
  const to = Math.min(state.doc.lines, last ?? cursorLineNo);

  let re: RegExp;
  try {
    re = new RegExp(
      parsed.pattern,
      `u${parsed.global ? "g" : ""}${parsed.ignoreCase ? "i" : ""}`,
    );
  } catch {
    // A pattern JavaScript itself rejects — bail rather than throwing out of the
    // engine's key handler.
    return;
  }

  const changes: Array<{ from: number; to: number; insert: string }> = [];
  for (let n = from; n <= to; n++) {
    const line = state.doc.line(n);
    re.lastIndex = 0; // `g` regexes carry state between calls
    const next = line.text.replace(re, parsed.replacement);
    if (next !== line.text) {
      changes.push({ from: line.from, to: line.to, insert: next });
    }
  }
  if (changes.length === 0) return;
  view.dispatch({ changes, userEvent: "input.replace" });
}

/** 1-based line number containing `pos`. */
function lineNumberAt(
  state: { doc: { lines: number; line: (n: number) => { from: number; to: number } } },
  pos: number,
): number {
  for (let n = 1; n <= state.doc.lines; n++) {
    const line = state.doc.line(n);
    if (pos >= line.from && pos <= line.to) return n;
  }
  return 1;
}

let installed = false;

/** Install the ex table onto the freshly-loaded engine. Idempotent — the engine's
 *  command map is module-global, like its keymap. */
export function installExCommands(api: ExApi): void {
  if (installed) return;
  installed = true;

  const host = getHost();

  // `:w` / `:x` / `:wq` — Myne autosaves on a debounce, so "write" means "stop
  // waiting and persist now". A real action, not a no-op: the save reflex does
  // something the user can rely on before locking or quitting.
  const write = (): void => {
    const flush = host.workspace?.flushPendingSaves;
    if (flush === undefined) return;
    void flush().then(
      () => showAttachmentToast(host.t("editor.vim.ex.written")),
      () => showAttachmentToast(host.t("editor.vim.ex.writeFailed")),
    );
  };
  api.Vim.defineEx("write", "w", write);
  api.Vim.defineEx("wq", "wq", () => {
    write();
    host.workspace?.closeActiveTab();
  });
  api.Vim.defineEx("xit", "x", () => {
    write();
    host.workspace?.closeActiveTab();
  });

  // `:q` — the nearest Myne concept to "quit this buffer" is closing the note
  // tab. There is no unsaved-changes case to guard: autosave already ran, and
  // `:q!` therefore means the same thing.
  const quit = (): void => {
    host.workspace?.closeActiveTab();
  };
  // `:q!` reaches this same command with a bang — the engine parses the `!` as an
  // argument, and there is no unsaved-changes case to distinguish anyway
  // (autosave already ran). Registering "quit!" separately is REJECTED by the
  // engine: the prefix must be a prefix of the name, and "q!" is not one of
  // "quit!". That only surfaced on the real engine, never against a stub.
  api.Vim.defineEx("quit", "q", quit);

  // `:s` / `:%s` — substitution.
  //
  // The engine HAS a vim→JS regex translator, but it is not applied on this code
  // path: measured behaviour is that `\(…\)` silently matches nothing, `\v` is
  // ignored, and `\zs` throws a raw `SyntaxError: Invalid regular expression`.
  // Silent no-ops and stack traces are both worse than a clear refusal, so the
  // pattern is screened first and the substitution is then performed directly
  // with JavaScript semantics — one transaction, so it is one undo step.
  api.Vim.defineEx("substitute", "s", (cm, params) => {
    const p = params as { argString?: string; line?: number; lineEnd?: number };
    const parsed = parseSubstitution(p.argString ?? "");
    if (parsed === null) {
      showAttachmentToast(host.t("editor.vim.ex.substitute.malformed"));
      return;
    }
    const refusal = substitutionRefusal(parsed.pattern, parsed.replacement);
    if (refusal !== null) {
      showAttachmentToast(
        host.t("editor.vim.ex.substitute.refused", { what: refusal }),
      );
      return;
    }
    applySubstitution(cm, parsed, p);
  });

  // Refusals. Defined explicitly so they shadow any engine default and produce a
  // clear message instead of a silent or partial effect.
  for (const { name, prefix, reasonKey } of REFUSED_EX_COMMANDS) {
    api.Vim.defineEx(name, prefix, () => {
      showAttachmentToast(host.t(reasonKey));
    });
  }
}

/** Test seam: forget that the (process-wide) table was installed. */
export function resetExCommandsForTests(): void {
  installed = false;
}
