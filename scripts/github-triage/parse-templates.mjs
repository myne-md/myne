// parse-templates — shared, import-safe template extraction for the triage pipeline.
//
// GitHub's Contents API returns directory entries keyed by `name` (and `type`), not by
// `filename`. The old parser in build-packet.mjs read `p.filename`, which is always
// undefined on a real API response, so every template was silently dropped. This module
// is the single implementation used by both the production builder and replay/eval so
// the two cannot drift, and it is importable from unit tests without touching the
// network.

const UNQUOTE = (s) => String(s).trim().replace(/^["']|["']$/g, '');

export function isTemplateFile(entry) {
  if (!entry) return false;
  const name = entry.name || entry.filename;
  if (!name) return false;
  if (entry.type && entry.type !== 'file') return false;
  const lower = String(name).toLowerCase();
  if (lower === 'config.yml' || lower === 'config.yaml') return false;
  return /\.(md|ya?ml)$/i.test(name);
}

export function parseTemplateText(filename, text) {
  const fn = String(filename || '');
  let name = fn;
  let about = '';
  const required = [];
  const t = String(text || '');
  if (/\.ya?ml$/i.test(fn)) {
    const nm = t.match(/^name:\s*(.+)$/m);
    if (nm) name = UNQUOTE(nm[1]);
    const de = t.match(/^description:\s*(.+)$/m);
    if (de) about = UNQUOTE(de[1]);
    for (const blk of t.split(/\n\s*-\s+type:\s*/).slice(1)) {
      const kind = (blk.match(/^\s*([a-z]+)/) || [])[1] || '';
      if (kind === 'checkboxes' || kind === 'markdown') continue;
      if (!/required:\s*true/.test(blk)) continue;
      const lab = blk.match(/label:\s*(.+)/);
      if (lab) required.push(UNQUOTE(lab[1]));
    }
  } else {
    const fm = t.match(/^---\n([\s\S]*?)\n---/);
    if (fm) {
      const nm = fm[1].match(/^name:\s*(.+)$/m);
      if (nm) name = UNQUOTE(nm[1]);
      const ab = fm[1].match(/^about:\s*(.+)$/m);
      if (ab) about = UNQUOTE(ab[1]);
    }
    for (const h of (t.match(/^#{1,4}\s+(.+)$/gm) || [])) {
      required.push(UNQUOTE(h.replace(/^#+\s+/, '')));
    }
  }
  return { filename: fn, name, about, required_sections: required };
}

export function extractTemplates(entries, repo = '') {
  const out = [];
  for (const e of entries || []) {
    if (!isTemplateFile(e)) continue;
    const filename = e.name || e.filename;
    const body = e.body ?? e.text ?? e.content ?? '';
    if (!String(body).trim()) continue;
    const parsed = parseTemplateText(filename, body);
    out.push({
      repo: repo || e.repo || '',
      filename: parsed.filename,
      name: parsed.name,
      about: parsed.about,
      required_sections: parsed.required_sections,
    });
  }
  return out;
}
