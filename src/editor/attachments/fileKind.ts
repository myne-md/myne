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

/** Per-extension human type label. Keys are lowercase, no leading dot. */
const EXTENSION_LABELS: Readonly<Record<string, string>> = {
  // Documents
  doc: "Word document",
  docx: "Word document",
  odt: "Document",
  pages: "Pages document",
  rtf: "Rich text document",
  // Spreadsheets
  xls: "Spreadsheet",
  xlsx: "Spreadsheet",
  ods: "Spreadsheet",
  numbers: "Numbers spreadsheet",
  csv: "CSV",
  tsv: "TSV",
  // Presentations
  ppt: "Presentation",
  pptx: "Presentation",
  odp: "Presentation",
  key: "Keynote",
  // PDF (normally renders inline; here for completeness / fallback)
  pdf: "PDF",
  // Archives
  zip: "Archive",
  rar: "Archive",
  "7z": "Archive",
  tar: "Archive",
  gz: "Archive",
  tgz: "Archive",
  bz2: "Archive",
  // Plain text
  txt: "Text document",
  md: "Markdown",
  markdown: "Markdown",
  log: "Log file",
  epub: "Ebook",
  // Code / structured text
  json: "JSON",
  xml: "XML",
  yml: "YAML",
  yaml: "YAML",
  toml: "TOML",
  html: "HTML",
  css: "CSS",
  js: "JavaScript",
  ts: "TypeScript",
  tsx: "TypeScript",
  jsx: "JavaScript",
  py: "Python",
  rs: "Rust",
  go: "Go",
  java: "Java",
  c: "C source",
  cpp: "C++ source",
  h: "C header",
  sh: "Shell script",
  // Audio
  mp3: "Audio",
  wav: "Audio",
  flac: "Audio",
  ogg: "Audio",
  m4a: "Audio",
  // Video
  mp4: "Video",
  mov: "Video",
  avi: "Video",
  mkv: "Video",
  webm: "Video",
  // Images (normally render inline; here for completeness / fallback)
  png: "Image",
  jpg: "Image",
  jpeg: "Image",
  gif: "Image",
  webp: "Image",
  svg: "SVG image",
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
 */
export function fileTypeLabel(filename: string): string {
  const ext = extensionOf(filename);
  if (ext === null) {
    return "File";
  }
  return EXTENSION_LABELS[ext] ?? `${ext.toUpperCase()} file`;
}
