// AI slash commands (writing-assistant MYND-410 task 5): `/devam` (continue
// from the cursor) and `/başlık` (suggest a title). Both compose the tested
// orchestration cores in `lib/writing-assistant.ts` + the blocking
// `local-inference|infer` IPC and dispatch a normal CM6 transaction as **plain
// markdown** (`ai.insert` / `ai.title` userEvents → one `history()` undo step),
// no new format. Fire-and-forget after the slash trigger is removed, the
// `/record` pattern.
//
// `/yeniden-yaz` (rewrite the selection) is intentionally NOT a slash command:
// typing `/yeniden-yaz` at a cursor leaves no selection to rewrite — its core
// (`computeRewrite`) is trigger-agnostic and belongs on a palette action.
//
// The commands are returned by `aiSlashCommands()`; composing them into the
// menu **only when `ai_enabled`** is task 6 (mode gating). Stub engine echoes
// until Candle — the whole surface is behind the default-off AI pref.

import { Facet } from "@codemirror/state";
import type { EditorView } from "@codemirror/view";

import i18n from "@myne/editor/i18n";
import { patchTitleField } from "@myne/dialect/surgery";
import {
  computeContinuation,
  computeTitle,
  infer as defaultInfer,
} from "@myne/editor/host/lib/writing-assistant";
import { slashCommands, type SlashCommand } from "./commands";
import { showAttachmentToast } from "../attachments/toast";

type Infer = (prompt: string) => Promise<string>;

/**
 * `/devam` action: continue from the primary cursor. Inserts the model's
 * completion as plain markdown at the cursor (`ai.insert`). `infer` is injected
 * for tests; defaults to the real IPC. No-op on an empty completion.
 */
export async function aiSlashContinue(
  view: EditorView,
  infer: Infer = defaultInfer,
): Promise<void> {
  const stateAtStart = view.state;
  const completion = await computeContinuation({ state: stateAtStart, infer });
  if (completion.length === 0) return;
  // Staleness guard: the blocking infer took seconds — if the document changed
  // (the user typed, or switched notes) drop the completion rather than inserting
  // stale text at a since-moved cursor or into the wrong note.
  if (!view.state.doc.eq(stateAtStart.doc)) return;
  const at = stateAtStart.selection.main.head;
  view.dispatch({
    changes: { from: at, insert: completion },
    selection: { anchor: at + completion.length },
    userEvent: "ai.insert",
  });
}

/**
 * `/başlık` action: suggest a title and write it to frontmatter `title:` via
 * `patchTitleField` (byte-identical to a manual title edit — never a first-H1 or
 * filename). Replaces the whole doc with the patched bytes (`ai.title`). No-op
 * on an empty title.
 */
export async function aiSlashTitle(
  view: EditorView,
  infer: Infer = defaultInfer,
): Promise<void> {
  const stateAtStart = view.state;
  const docText = stateAtStart.doc.toString();
  const title = (await computeTitle({ docText, infer })).trim();
  if (title.length === 0) return;
  // Staleness guard: the whole-doc replace below would discard any keystrokes
  // typed during the blocking infer (or clobber a different note the user
  // switched to). Apply only if the document is unchanged since the title was
  // computed; otherwise drop it — the user can re-run on the current content.
  if (!view.state.doc.eq(stateAtStart.doc)) return;
  const patched = patchTitleField(new TextEncoder().encode(docText), title);
  const newDoc = new TextDecoder().decode(patched);
  if (newDoc === docText) return;
  view.dispatch({
    changes: { from: 0, to: view.state.doc.length, insert: newDoc },
    userEvent: "ai.title",
  });
}

/** Remove the `/…` slash trigger span, then fire an async AI action. */
/**
 * The `EngineError` variant tag of a raw IPC rejection, or `""`.
 *
 * **A deliberate second copy of `src/lib/engine-error.ts::engineErrorTag`, and
 * the duplication is the package boundary rather than an oversight.** This is
 * `@myne/editor`, consumed as source by desktop, web and mobile; importing from
 * the desktop tree would break that (and `check-platform-seam.mjs` guards the
 * direction). Four lines, pure, over a wire shape frozen by the Rust enum — the
 * cost of a copy is bounded, and the alternative is a shared package created for
 * one function.
 *
 * Content-free by construction: a fixed identifier, never the prompt or the note.
 */
function engineErrorTag(raw: unknown): string {
  if (typeof raw === "string") return raw;
  if (raw !== null && typeof raw === "object" && "kind" in raw) {
    return String((raw as { kind: unknown }).kind);
  }
  return "";
}

/** Causes that mean *nothing is set up to answer*, as distinct from *it tried
 *  and failed*. Both spellings: Tauri serializes a unit variant as its
 *  identifier, the `kind()` helper emits snake_case, and a map covering one of
 *  them silently reports the catch-all for the other. */
const NO_PROVIDER: ReadonlySet<string> = new Set([
  "NotReady",
  "not_ready",
  "NoModel",
  "no_model",
  "NoCredential",
  "no_credential",
]);

/** Exported for `tests/editor/aiSlash.test.ts`, which drives this wrapper with a
 *  rejecting action directly. Testing it through a command's `apply` would need
 *  an injected `EditorHost`, and mixing the package's two import specifiers in
 *  one test file resolves a second module graph — which made the first attempt
 *  pass the WRONG branch (a `getHost()` TypeError, caught by this very catch and
 *  reported as a generic failure). Exporting the unit under test removes the
 *  question entirely. */
export function removeTriggerThen(
  action: (v: EditorView) => Promise<void>,
): (v: EditorView, from: number, to: number) => void {
  return (v, from, to) => {
    v.dispatch({
      changes: { from, to, insert: "" },
      selection: { anchor: from },
      userEvent: "slash.apply",
    });
    // The `.catch` this used to lack, and its absence was worse than silence
    // (#191 task 7): the trigger span is deleted BEFORE the action runs, so on
    // a rejection the user's typed `/devam` vanished, nothing arrived to
    // replace it, and nothing explained it. On a stock install — no side-loaded
    // generation model — that was the outcome every single time, and it read as
    // the editor eating input.
    //
    // The trigger text is deliberately NOT re-inserted: the deletion is a
    // normal transaction with `userEvent: "slash.apply"`, so undo already
    // brings it back, and re-inserting would fight the undo stack.
    void action(v).catch((err: unknown) => {
      // Two direct `i18n.t("…")` call sites rather than one with a computed
      // key: `scripts/check-i18n.mjs` verifies STATIC call sites, and a key
      // assembled inside the call is a key no guard checks.
      showAttachmentToast(
        NO_PROVIDER.has(engineErrorTag(err))
          ? i18n.t("editor.slash.aiNoProvider")
          : i18n.t("editor.slash.aiFailed"),
        "error",
      );
    });
  };
}

/**
 * The AI slash commands. Composed into the menu only when `ai_enabled` (task 6);
 * carry `ai.*`-adjacent ids so the menu items are discoverable by the E2E pass.
 */
export function aiSlashCommands(): readonly SlashCommand[] {
  return [
    {
      id: "ai-continue",
      label: i18n.t("editor.slash.aiContinue"),
      icon: "✦",
      apply: removeTriggerThen((v) => aiSlashContinue(v)),
    },
    {
      id: "ai-title",
      label: i18n.t("editor.slash.aiTitle"),
      icon: "✦",
      apply: removeTriggerThen((v) => aiSlashTitle(v)),
    },
  ];
}

/**
 * The slash-menu command set for the current context (writing-assistant task 6,
 * the slash portion of mode-gating): the base commands, plus the AI commands
 * **only when `ai_enabled`**. Pure — the plugin threads `ai_enabled` (via a CM6
 * facet) into this at menu-build time. Reading-view inertness + the excluded-
 * folder suppression are enforced upstream (the whole editable surface is off in
 * Reading view), same as spell/slash today.
 */
export function slashCommandsForContext(opts: {
  aiEnabled: boolean;
}): readonly SlashCommand[] {
  return opts.aiEnabled
    ? [...slashCommands(), ...aiSlashCommands()]
    : slashCommands();
}

/**
 * CM6 facet carrying `ai_enabled` into the slash plugin (writing-assistant task
 * 6). **Defaults to `false`** — the base build shows no AI commands unless the
 * host explicitly provides `ai_enabled` from `vault.prefs`/MYP1, so default
 * behaviour is unchanged. Last-provided value wins.
 */
export const aiSlashEnabledFacet = Facet.define<boolean, boolean>({
  combine: (values) => (values.length > 0 ? values[values.length - 1] : false),
});
