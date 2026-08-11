import type { EditorState } from "@codemirror/state";
import { getHost } from "../../host";
export function infer(prompt: string, opts?: { maxNewTokens?: number }): Promise<string> {
  const ai = getHost().ai;
  return ai ? ai.infer(prompt, opts) : Promise.resolve("");
}
/** Ambient completions (SYNC-14). Deliberately does NOT fall back to `infer`:
 *  a host that cannot classify the request must show no ghost text rather than
 *  send an ambient request through the user-initiated door. */
export function inferAmbient(prompt: string, opts?: { maxNewTokens?: number }): Promise<string> {
  const ai = getHost().ai;
  return ai?.inferAmbient ? ai.inferAmbient(prompt, opts) : Promise.resolve("");
}
export function buildCompletionPrompt(precedingText: string, opts?: { brief?: boolean }): string {
  const ai = getHost().ai;
  return ai ? ai.buildCompletionPrompt(precedingText, opts) : precedingText;
}
export async function computeContinuation(args: { state: EditorState; infer: (p: string) => Promise<string> }): Promise<string> {
  const preceding = args.state.sliceDoc(0, args.state.selection.main.head);
  return args.infer(buildCompletionPrompt(preceding));
}
export async function computeTitle(args: { docText: string; infer: (p: string) => Promise<string> }): Promise<string> {
  const ai = getHost().ai;
  return args.infer(ai ? ai.buildTitlePrompt(args.docText) : args.docText);
}
