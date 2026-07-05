import type { EditorState } from "@codemirror/state";
import { getHost } from "../../host";
export function infer(prompt: string): Promise<string> {
  const ai = getHost().ai;
  return ai ? ai.infer(prompt) : Promise.resolve("");
}
export function buildCompletionPrompt(precedingText: string): string {
  const ai = getHost().ai;
  return ai ? ai.buildCompletionPrompt(precedingText) : precedingText;
}
export async function computeContinuation(args: { state: EditorState; infer: (p: string) => Promise<string> }): Promise<string> {
  const preceding = args.state.sliceDoc(0, args.state.selection.main.head);
  return args.infer(buildCompletionPrompt(preceding));
}
export async function computeTitle(args: { docText: string; infer: (p: string) => Promise<string> }): Promise<string> {
  const ai = getHost().ai;
  return args.infer(ai ? ai.buildTitlePrompt(args.docText) : args.docText);
}
