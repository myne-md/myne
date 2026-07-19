// Layout stubs for the jsdom test env so CodeMirror 6's measure pass survives.
//
// jsdom implements no layout, so `Range.getClientRects` / `getBoundingClientRect`
// are absent. CM6's `EditorView.measure` calls `textRange(...).getClientRects()`
// during its rAF-scheduled measure; on jsdom that throws
// "getClientRects is not a function". Because measure runs inside a rAF macrotask
// (no surrounding catch), the throw surfaces as an UNHANDLED error, which Vitest
// attributes to whichever test FILE happened to be running when the stale timer
// fired — a cross-file, load-dependent flake (an editor test that mounted+tore
// down a view leaks a queued measure that blows up while an unrelated file runs;
// the pre-push stack was `EditorView.measure → runAnimationFrameCallbacks`).
//
// Stubbing both Range layout methods to inert empty rects lets measure complete
// silently (jsdom has no geometry to report anyway — editor unit tests never
// assert on real coordinates). Guarded on `Range` so node-env tests (no jsdom)
// are untouched. Only fills genuinely-missing methods, so a future jsdom that
// ships these keeps its own implementation.

if (typeof Range !== "undefined") {
  const proto = Range.prototype;

  if (typeof proto.getClientRects !== "function") {
    proto.getClientRects = function (): DOMRectList {
      const list = Object.assign([] as DOMRect[], {
        item: (_i: number): DOMRect | null => null,
      });
      return list as unknown as DOMRectList;
    };
  }

  if (typeof proto.getBoundingClientRect !== "function") {
    proto.getBoundingClientRect = function (): DOMRect {
      return {
        x: 0, y: 0, width: 0, height: 0,
        top: 0, right: 0, bottom: 0, left: 0,
        toJSON: () => ({}),
      } as DOMRect;
    };
  }
}
