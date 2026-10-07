// Re-export shim. The parser moved to `@myne/dialect/miniMarkdown`
// (myne-md/myne#771) so the desktop AI chat can render a model's answer with the
// SAME implementation the phone's reading mode uses, rather than a second one.
//
// `dialect/` is where it belongs and always was: that package's whole job is the
// markdown the clients share, and this file living under `mobile/src/lib` meant
// a desktop surface that wanted it had the choice of reaching across a client
// boundary or writing its own — and a second markdown parser is a second set of
// answers to "is this bold".
//
// The shim keeps mobile's import path so nothing in that tree moved, which is
// the same pattern `src/editor` uses for `@myne/editor`.

export {
  parseInline,
  parseBlocks,
  type Inline,
  type Block,
} from "@myne/dialect/miniMarkdown";
