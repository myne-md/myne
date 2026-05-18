// `<CMEditor>` — minimal React wrapper around CodeMirror 6's `EditorView`.
//
// Per `editor-mvp-baseline` PRD (myne-agents/features/editor-mvp-baseline/prd.md)
// + grill `myne-agents/sessions/grill/2026-05-16-mynd-36-editor-inner-scope.md`:
// custom ~30-LOC wrapper, NOT `@uiw/react-codemirror`. The trade is ~30 LOC
// of code-we-own against ~6 transitive packages and the wrong-palette
// `theme-one-dark` that doesn't fit Myne's design system.
//
// Contract: `value` / `onChange` / `onBlur` mirrors the `<textarea>` that
// this swap replaces (`src/screens/Editor.tsx` `<CenterPane>`), so the
// surrounding `useAutosave` + sidebar refresh + Tauri listeners survive
// the swap unchanged.

import { useEffect, useRef, type CSSProperties } from "react";
import { EditorState, type Extension } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { diffDoc } from "./doc-diff";
import { myneExtensions } from "./extensions";

export type CMEditorProps = {
  value: string;
  onChange: (next: string) => void;
  onBlur?: () => void;
  /** Composed alongside `myneExtensions`. v0 baseline does not use this. */
  extensions?: readonly Extension[];
  readOnly?: boolean;
  style?: CSSProperties;
};

export function CMEditor(props: CMEditorProps) {
  const { value, onChange, onBlur, extensions, readOnly = false, style } = props;
  const hostRef = useRef<HTMLDivElement | null>(null);
  const viewRef = useRef<EditorView | null>(null);
  const onChangeRef = useRef(onChange);
  const onBlurRef = useRef(onBlur);

  // Keep callback refs current so the EditorView's update listener closes
  // over the latest props without rebuilding the view.
  useEffect(() => {
    onChangeRef.current = onChange;
  }, [onChange]);
  useEffect(() => {
    onBlurRef.current = onBlur;
  }, [onBlur]);

  // Mount + destroy lifecycle. The view is built once; subsequent `value`
  // changes from outside are mirrored via `dispatch` in the effect below.
  useEffect(() => {
    const host = hostRef.current;
    if (host === null) return;

    const view = new EditorView({
      state: EditorState.create({
        doc: value,
        extensions: [
          ...myneExtensions(),
          ...(extensions ?? []),
          EditorView.editable.of(!readOnly),
          EditorView.updateListener.of((update) => {
            if (update.docChanged) {
              onChangeRef.current(update.state.doc.toString());
            }
          }),
          EditorView.domEventHandlers({
            blur: () => {
              onBlurRef.current?.();
            },
          }),
        ],
      }),
      parent: host,
    });
    viewRef.current = view;

    return () => {
      view.destroy();
      viewRef.current = null;
    };
    // Intentionally empty deps — the view is mounted once. Prop changes
    // flow through the controlled-component mirror effect below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Controlled-component mirror: if `value` changes from outside, dispatch
  // a MINIMAL change (longest-common-prefix + suffix diff) so the cursor
  // stays anchored in the body when the change is localized to the
  // frontmatter `updated:` timestamp (autosave-driven), or otherwise to
  // any region outside the user's current selection.
  //
  // A full doc replacement (`{from: 0, to: docLength, insert: value}`)
  // would land the cursor at position 0 after every autosave, since CM6
  // doesn't infer how to map cursor across an indiscriminate replace.
  useEffect(() => {
    const view = viewRef.current;
    if (view === null) return;
    const diff = diffDoc(view.state.doc.toString(), value);
    if (diff === null) return;
    view.dispatch({ changes: diff });
  }, [value]);

  return (
    <div
      ref={hostRef}
      style={style ?? { width: "100%", minHeight: 360 }}
    />
  );
}
