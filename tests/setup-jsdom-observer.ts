// jsdom has no `ResizeObserver`, and the story catalogue mounts components that
// observe their own box: `VirtualList` sizes its render window from the
// viewport height, and a couple of the notes panels compose it. Without a stub
// they throw on mount, so those surfaces could not have a story at all.
//
// That gap is worth naming, because it was misread: the coverage roster recorded
// those surfaces as "structural, needs a workspace model", when the actual
// blocker was one missing browser global. A no-op observer is enough here
// because jsdom has no layout, so every box measures 0 and the callback has
// nothing to report either way. The real browser the catalogue serves in
// supplies the real one, which is why the story works there (myne-md/myne#845).

class ResizeObserverStub implements ResizeObserver {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}

if (globalThis.ResizeObserver === undefined) {
  globalThis.ResizeObserver = ResizeObserverStub;
}
