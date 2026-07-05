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
function removeTriggerThen(
  action: (v: EditorView) => void,
): (v: EditorView, from: number, to: number) => void {
  return (v, from, to) => {
    v.dispatch({
      changes: { from, to, insert: "" },
      selection: { anchor: from },
      userEvent: "slash.apply",
    });
    action(v);
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
      apply: removeTriggerThen((v) => void aiSlashContinue(v)),
    },
    {
      id: "ai-title",
      label: i18n.t("editor.slash.aiTitle"),
      icon: "✦",
      apply: removeTriggerThen((v) => void aiSlashTitle(v)),
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
