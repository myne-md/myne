#!/usr/bin/env node
// apply-verdict — deterministic port of WF5: renders the verdict into one PR
// comment, posts it, deletes the bot's previous review comment, anchors Critical
// findings as inline review comments, and deletes the previous inline comments.
//
// The LLM never sees this code and never touches GitHub — this script owns every
// write, exactly as WF5 did. The verdict is model output, so every field is
// rendered defensively (String(), null-safe) and inline comments are only posted
// on lines that are actually part of the diff (GitHub 422s anything else).
//
// Env:
//   REVIEW_PACKET    the packet+meta JSON written by build-context.mjs
//   REVIEW_VERDICT   the verdict JSON written by classify.mjs
//   MYNE_BOT_PAT     token for every GitHub write

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

const __dirname = dirname(new URL(import.meta.url).pathname);
const PACKET = process.env.REVIEW_PACKET || join(__dirname, '..', '.review', 'packet.json');
const VERDICT = process.env.REVIEW_VERDICT || join(__dirname, '..', '.review', 'verdict.json');
const DRY_RUN = process.env.REVIEW_DRY_RUN === '1' || process.env.REVIEW_DRY_RUN === 'true';

const token = process.env.MYNE_BOT_PAT || '';
if (!token && !DRY_RUN) {
  console.error('FATAL: set MYNE_BOT_PAT');
  process.exit(1);
}

const { packet, meta } = JSON.parse(readFileSync(PACKET, 'utf8'));
const v = JSON.parse(readFileSync(VERDICT, 'utf8'));

const HEADERS = {
  Accept: 'application/vnd.github+json',
  'User-Agent': 'myne-bot',
  'X-GitHub-Api-Version': '2022-11-28',
  Authorization: `Bearer ${token}`,
};

async function gh(path, opts = {}) {
  if (DRY_RUN) {
    console.log(`DRY_RUN ${opts.method || 'GET'} ${path} ${opts.body ? JSON.stringify(opts.body).slice(0, 200) : ''}`);
    return [];
  }
  const url = path.startsWith('http') ? path : `https://api.github.com${path}`;
  const res = await fetch(url, { method: opts.method || 'GET', headers: HEADERS, body: opts.body ? JSON.stringify(opts.body) : undefined });
  const text = await res.text().catch(() => '');
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { json = null; }
  if (!res.ok) throw new Error(`GitHub ${res.status} ${opts.method || 'GET'} ${url}: ${text.slice(0, 300)}`);
  return json;
}

// --- render comment (WF5 "Render comment") ----------------------------------
const DIM = { 1: 'Project rules', 2: 'Ethics and anti-features', 3: 'Threat model and trust boundaries', 4: 'Cryptographic discipline', 5: 'Spec, glossary and decisions hygiene', 6: 'Design and consistency', 7: 'General code quality', 8: 'Data loss, migration and availability', 9: 'Wiring and test integrity', 10: 'Legal, privacy and compliance', 11: 'Spec conformance' };
const ORDER = { Critical: 0, Important: 1, Minor: 2 };
const esc = (s) => String(s == null ? '' : s);
const sig = esc(v.blocking_signature || 'none');
const L = [];
L.push('<!-- myne-review -->');
L.push('**Verdict: ' + esc(v.verdict || 'UNKNOWN') + '**');
L.push('');
L.push('Blocking-signature: `' + sig + '`');
if (v.summary) { L.push(''); L.push(esc(v.summary)); }
if (v.re_review) { L.push(''); L.push('**Re-review:** ' + esc(v.re_review)); }
if (v.fix_first) { L.push(''); L.push('**Fix first:** ' + esc(v.fix_first)); }
const findings = Array.isArray(v.findings) ? v.findings.slice() : [];
if (findings.length) {
  findings.sort((a, b) => (ORDER[a.severity] ?? 3) - (ORDER[b.severity] ?? 3) || (a.dimension || 0) - (b.dimension || 0));
  L.push('');
  L.push('<details><summary><b>Findings by dimension (' + findings.length + ')</b></summary>');
  L.push('');
  let cur = null;
  for (const f of findings) {
    const d = f.dimension || 0;
    if (d !== cur) { cur = d; L.push(''); L.push('#### D' + d + ': ' + (DIM[d] || 'Other')); }
    const where = f.file ? '`' + esc(f.file) + (f.line ? ':' + f.line : '') + '`' : '';
    const spec = f.confidence === 'speculative' ? ' _(speculative)_' : '';
    L.push('');
    L.push('- **' + esc(f.severity || 'Minor') + '** ' + where + spec);
    if (f.what) L.push('  ' + esc(f.what));
    if (f.why) L.push('  Why: ' + esc(f.why));
    if (f.fix) L.push('  Fix: ' + esc(f.fix));
  }
  L.push('');
  L.push('</details>');
}
const blk = (title, arr) => {
  if (!Array.isArray(arr) || !arr.length) return;
  L.push('');
  L.push('<details><summary><b>' + title + '</b></summary>');
  L.push('');
  for (const x of arr) L.push('- ' + esc(x));
  L.push('');
  L.push('</details>');
};
blk('Patterns observed', v.patterns);
blk("What's good", v.whats_good);
const hist = Array.isArray(packet.prior?.signature_history) ? packet.prior.signature_history.slice() : [];
const today = new Date().toISOString().slice(0, 10);
hist.push(today + ': `' + sig + '`');
const trimmed = hist.slice(-10);
if (trimmed.length) {
  L.push('');
  L.push('<details><summary><b>Signature history</b></summary>');
  L.push('');
  for (const h of trimmed) L.push('- ' + esc(h));
  L.push('');
  L.push('</details>');
}
const calib = [v.self_calibration, v.adversarial].filter(Boolean).join(' ');
L.push('');
L.push('<sub>Reviewed `' + esc(meta.headSha).slice(0, 7) + '` against `' + esc(meta.base) + '`. ' + (calib ? esc(calib) + ' ' : '') + 'No repository code was executed, so build and test status is left to CI.</sub>');
const commentBody = L.join('\n');

// --- post comment + delete old ----------------------------------------------
async function cleanupOldComment(newId) {
  const comments = await gh(`/repos/${meta.owner}/${meta.repo}/issues/${meta.prNumber}/comments?per_page=100`);
  for (const c of comments) {
    if (!c || !c.user) continue;
    const isBot = c.user.login === 'myne-bot';
    const hasMarker = typeof c.body === 'string' && c.body.indexOf('<!-- myne-review -->') !== -1;
    if (isBot && hasMarker && c.id !== newId) {
      await gh(`/repos/${meta.owner}/${meta.repo}/issues/comments/${c.id}`, { method: 'DELETE' });
      console.log(`cleanup: deleted old comment ${c.id}`);
    }
  }
}

// --- inline critical comments (WF5 "Plan inline comments") -------------------
async function planInlineComments() {
  const files = await gh(`/repos/${meta.owner}/${meta.repo}/pulls/${meta.prNumber}/files?per_page=100`);
  const valid = new Map();
  for (const f of files) {
    if (!f || !f.filename) continue;
    const set = new Set();
    const patch = typeof f.patch === 'string' ? f.patch : '';
    let line = 0;
    for (const raw of patch.split('\n')) {
      const h = raw.match(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
      if (h) { line = parseInt(h[1], 10); continue; }
      if (raw.startsWith('-') || raw.startsWith('\\')) continue;
      if (raw.startsWith('+') || raw.startsWith(' ')) { set.add(line); line++; }
    }
    valid.set(f.filename, set);
  }
  const comments = [];
  for (const f of (v.findings || [])) {
    if (f.severity !== 'Critical') continue;
    if (f.confidence === 'speculative') continue;
    if (!f.file || !f.line) continue;
    const set = valid.get(f.file);
    if (!set || !set.has(Number(f.line))) continue;
    const body = ['<!-- myne-review -->', '**Critical** ' + String(f.what || '').trim()];
    if (f.why) { body.push(''); body.push('Why: ' + f.why); }
    if (f.fix) { body.push(''); body.push('Fix: ' + f.fix); }
    comments.push({ path: f.file, line: Number(f.line), side: 'RIGHT', body: body.join('\n') });
  }
  return comments;
}

async function cleanupOldInline(newReviewId) {
  const comments = await gh(`/repos/${meta.owner}/${meta.repo}/pulls/${meta.prNumber}/comments?per_page=100`);
  for (const c of comments) {
    if (!c || !c.user || c.user.login !== 'myne-bot') continue;
    if (typeof c.body !== 'string' || c.body.indexOf('<!-- myne-review -->') === -1) continue;
    if (newReviewId && c.pull_request_review_id === newReviewId) continue;
    await gh(`/repos/${meta.owner}/${meta.repo}/pulls/comments/${c.id}`, { method: 'DELETE' });
    console.log(`cleanup: deleted old inline comment ${c.id}`);
  }
}

// --- apply ------------------------------------------------------------------
console.log(`apply-verdict: verdict=${v.verdict} signature=${sig} findings=${findings.length}`);

const newComment = await gh(`/repos/${meta.owner}/${meta.repo}/issues/${meta.prNumber}/comments`, { method: 'POST', body: { body: commentBody } });
const newId = DRY_RUN ? null : newComment.id;
await cleanupOldComment(newId);

const inline = await planInlineComments();
if (inline.length) {
  const review = await gh(`/repos/${meta.owner}/${meta.repo}/pulls/${meta.prNumber}/reviews`, {
    method: 'POST',
    body: {
      commit_id: meta.headSha,
      event: 'COMMENT',
      body: '<!-- myne-review -->\nCritical findings are anchored on the diff below. The full review is in the summary comment.',
      comments: inline,
    },
  });
  await cleanupOldInline(DRY_RUN ? null : review.id);
  console.log(`apply-verdict: posted ${inline.length} inline critical comment(s)`);
} else {
  await cleanupOldInline(null);
  console.log('apply-verdict: no inline comments to post');
}

console.log(`apply-verdict: done for ${meta.repo}#${meta.prNumber}`);
