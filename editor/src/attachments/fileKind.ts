// Filename-extension → human type label for generic attachment file-cards
// (MYND-173).
//
// Why TS-side and extension-driven: a generic (non-image/PDF) attachment is
// stored with `content_type = "application/octet-stream"` (the Rust sniffer
// only recognizes the render allowlist; see
// `src-tauri/src/plugins/attachments/sniff.rs`). So the catalog carries no
// useful type for a generic file — the human-facing type label is derived here
// from the display filename's extension. The card filename itself is the
// catalog filename (the single source of truth; MYND-173).
//
// This module is PURE DATA + a pure function. The file-card icon is currently
// a single generic "file" glyph for every type; a per-type glyph (Word /
// spreadsheet / archive …) is a follow-up that rides the inline-preview work
// (MYND-268), at which point this map would grow a category column.
//
// i18n: the per-extension labels are i18n KEYS (resolved through the `common`
// catalog under `editor.attachment.fileKind.label.*`), not English literals.
// `fileTypeLabel` resolves them via `i18n.t` at CALL time, so the consumer
// must call it at render time (never freeze the result at module load) to stay
// reactive to a language switch.

import i18n from "@myne/editor/i18n";

/** Per-extension type-label i18n key. Keys are lowercase, no leading dot. */
const EXTENSION_LABEL_KEYS: Readonly<Record<string, string>> = {
  // Documents
  doc: "editor.attachment.fileKind.label.word",
  docx: "editor.attachment.fileKind.label.word",
  odt: "editor.attachment.fileKind.label.document",
  pages: "editor.attachment.fileKind.label.pages",
  rtf: "editor.attachment.fileKind.label.richText",
  // Spreadsheets
  xls: "editor.attachment.fileKind.label.spreadsheet",
  xlsx: "editor.attachment.fileKind.label.spreadsheet",
  ods: "editor.attachment.fileKind.label.spreadsheet",
  numbers: "editor.attachment.fileKind.label.numbers",
  csv: "editor.attachment.fileKind.label.csv",
  tsv: "editor.attachment.fileKind.label.tsv",
  // Presentations
  ppt: "editor.attachment.fileKind.label.presentation",
  pptx: "editor.attachment.fileKind.label.presentation",
  odp: "editor.attachment.fileKind.label.presentation",
  key: "editor.attachment.fileKind.label.keynote",
  // PDF (normally renders inline; here for completeness / fallback)
  pdf: "editor.attachment.fileKind.label.pdf",
  // Archives
  zip: "editor.attachment.fileKind.label.archive",
  rar: "editor.attachment.fileKind.label.archive",
  "7z": "editor.attachment.fileKind.label.archive",
  tar: "editor.attachment.fileKind.label.archive",
  gz: "editor.attachment.fileKind.label.archive",
  tgz: "editor.attachment.fileKind.label.archive",
  bz2: "editor.attachment.fileKind.label.archive",
  // Plain text
  txt: "editor.attachment.fileKind.label.text",
  md: "editor.attachment.fileKind.label.markdown",
  markdown: "editor.attachment.fileKind.label.markdown",
  log: "editor.attachment.fileKind.label.log",
  epub: "editor.attachment.fileKind.label.ebook",
  // Code / structured text
  json: "editor.attachment.fileKind.label.json",
  xml: "editor.attachment.fileKind.label.xml",
  yml: "editor.attachment.fileKind.label.yaml",
  yaml: "editor.attachment.fileKind.label.yaml",
  toml: "editor.attachment.fileKind.label.toml",
  html: "editor.attachment.fileKind.label.html",
  css: "editor.attachment.fileKind.label.css",
  js: "editor.attachment.fileKind.label.javascript",
  ts: "editor.attachment.fileKind.label.typescript",
  tsx: "editor.attachment.fileKind.label.typescript",
  jsx: "editor.attachment.fileKind.label.javascript",
  py: "editor.attachment.fileKind.label.python",
  rs: "editor.attachment.fileKind.label.rust",
  go: "editor.attachment.fileKind.label.go",
  java: "editor.attachment.fileKind.label.java",
  c: "editor.attachment.fileKind.label.cSource",
  cpp: "editor.attachment.fileKind.label.cppSource",
  h: "editor.attachment.fileKind.label.cHeader",
  sh: "editor.attachment.fileKind.label.shell",
  // Audio
  mp3: "editor.attachment.fileKind.label.audio",
  wav: "editor.attachment.fileKind.label.audio",
  flac: "editor.attachment.fileKind.label.audio",
  ogg: "editor.attachment.fileKind.label.audio",
  m4a: "editor.attachment.fileKind.label.audio",
  // Video
  mp4: "editor.attachment.fileKind.label.video",
  mov: "editor.attachment.fileKind.label.video",
  avi: "editor.attachment.fileKind.label.video",
  mkv: "editor.attachment.fileKind.label.video",
  webm: "editor.attachment.fileKind.label.video",
  // Images (normally render inline; here for completeness / fallback)
  png: "editor.attachment.fileKind.label.image",
  jpg: "editor.attachment.fileKind.label.image",
  jpeg: "editor.attachment.fileKind.label.image",
  gif: "editor.attachment.fileKind.label.image",
  webp: "editor.attachment.fileKind.label.image",
  svg: "editor.attachment.fileKind.label.svg",
};

/**
 * Extract the lowercase extension of a filename (the segment after the last
 * `.`), or `null` when there is no usable extension (no dot, a leading-dot
 * dotfile with no further dot, or a trailing dot).
 */
export function extensionOf(filename: string): string | null {
  // Use only the final path component so a folder name with a dot doesn't
  // get mistaken for an extension (defensive — catalog filenames are flat).
  const base = filename.split(/[\\/]/).pop() ?? filename;
  const dot = base.lastIndexOf(".");
  // No dot, or a leading-dot dotfile (".gitignore" → no extension), or a
  // trailing dot ("name." → empty).
  if (dot <= 0 || dot === base.length - 1) {
    return null;
  }
  return base.slice(dot + 1).toLowerCase();
}

/**
 * Resolve the human type label for a display filename. Known extensions map to
 * a friendly label; an unknown extension becomes `"<EXT> file"` (e.g. `"XYZ
 * file"`); a name with no extension is the generic `"File"`. Always total —
 * never throws.
 *
 * Resolved through i18n at CALL time — call this at render so it tracks a
 * language switch; do not cache the returned string at module load.
 */
export function fileTypeLabel(filename: string): string {
  const ext = extensionOf(filename);
  if (ext === null) {
    return i18n.t("editor.attachment.fileKind.generic");
  }
  const key = EXTENSION_LABEL_KEYS[ext];
  if (key !== undefined) {
    return i18n.t(key);
  }
  return i18n.t("editor.attachment.fileKind.unknown", {
    ext: ext.toUpperCase(),
  });
}
