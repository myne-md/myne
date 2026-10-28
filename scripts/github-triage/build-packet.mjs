#!/usr/bin/env node
// build-packet — deterministic port of the n8n "Build packet" node in WF3.
//
// Reads the GitHub `issues: opened` event from GITHUB_EVENT_PATH, then assembles
// the context packet the issue-triage skill reasons over: labels, milestones,
// the dedup corpus (relevance search + open issues), and the issue templates.
// Everything here is a GitHub REST call and pure string shaping — no LLM. The
// classifier (classify-jev.mjs) consumes the packet; the side effects (apply-verdict.mjs)
// consume the verdict. This split is what keeps the skill a pure function.
//
// Why this is not n8n any more: the triage workflow moved from n8n on the VPS to a
// GitHub Action (myne-md/myne). The logic below is copied from WF3's `Build packet`
// node and the `Build relevance query` node, so behaviour stays byte-compatible
// with the n8n run while the trigger and the classifier CLI changed underneath.
//
// Env:
//   GITHUB_EVENT_PATH   set by GitHub Actions; the issues event JSON
//   GH_TOKEN / MYNE_BOT_PAT  the token used for every REST call (myne-bot, org-wide)

import { readFileSync } from 'node:fs';
import { extractTemplates } from './parse-templates.mjs';

const event = JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH || '/dev/stdin', 'utf8'));
const token = process.env.MYNE_BOT_PAT || process.env.GH_TOKEN || process.env.GITHUB_TOKEN || '';

const t = {
  owner: event.repository?.owner?.login || 'myne-md',
  repo: event.repository?.name,
  issueNumber: event.issue?.number,
  issueId: event.issue?.id,
  title: event.issue?.title || '',
  body: event.issue?.body || '',
  author: event.issue?.user?.login || '',
  authorAssociation: event.issue?.author_association || 'NONE',
  createdAt: event.issue?.created_at || '',
  issueNodeId: event.issue?.node_id || '',
  existingLabels: (event.issue?.labels || []).map((l) => (l && (l.name || l))).filter(Boolean),
};

const HEADERS = {
  Accept: 'application/vnd.github+json',
  'User-Agent': 'myne-bot',
  'X-GitHub-Api-Version': '2022-11-28',
  ...(token ? { Authorization: `Bearer ${token}` } : {}),
};

async function gh(path) {
  const url = path.startsWith('http') ? path : `https://api.github.com${path}`;
  const res = await fetch(url, { headers: HEADERS });
  if (!res.ok) {
    // Reads the body once, so the caller sees the reason; most callers treat a
    // failed fetch as "empty" and keep going, matching the n8n nodes' behaviour.
    const text = await res.text().catch(() => '');
    throw new Error(`GitHub ${res.status} for ${url}: ${text.slice(0, 300)}`);
  }
  return res.json();
}

async function ghText(path) {
  const url = path.startsWith('http') ? path : `https://api.github.com${path}`;
  const res = await fetch(url, { headers: { ...HEADERS, Accept: 'application/vnd.github.raw' } });
  if (!res.ok) throw new Error(`GitHub ${res.status} for ${url}`);
  return res.text();
}

// --- siblings (transfer targets) -----------------------------------------
// `myne-status` was deleted 2026-08-14, so it is not offered as a target. The
// classifier can only name a repo this list offers, and apply-verdict only moves
// when the target was offered, so an archive/deletion here cannot strand an issue.
const SIBLINGS = [
  { name: 'myne', about: 'core desktop app, specs, web client, AND the iOS + Android mobile client (in-repo at mobile/ since 2026-08-13; the myne-mobile repo is archived)' },
  { name: 'myne-server', about: 'Go sync server, self-hostable' },
  { name: 'myne-website', about: 'marketing site myne.md' },
  { name: 'myne-clipper', about: 'browser web-clipper extension' },
  { name: 'myne-themes', about: 'custom-theme marketplace' },
  { name: 'myne-test-vectors', about: 'protocol test vectors' },
  { name: 'myne-branding', about: 'brand assets' },
  { name: 'myne-agents', about: 'internal agents/skills (private)', private: true },
  { name: 'myne-ops', about: 'internal ops/infra (private)', private: true },
];
const CORPUS_REPOS = new Set(SIBLINGS.filter((s) => !s.private).map((s) => s.name));

// --- relevance query (Build relevance query node) -------------------------
const STOP = new Set(['the','and','for','with','that','this','from','into','when','then','while','are','was','were','been','being','its','not','can','could','should','would','will','you','your','our','their','they','has','have','had','but','all','any','some','more','most','other','new','use','used','using','get','gets','make','makes','does','did','doesnt','dont','cant','wont','only','also','there','here','what','which','who','how','why','after','before','over','under','than','too','very','just','still','again','about']);
function relevanceQuery(title) {
  const raw = String(title || '');
  const terms = raw
    .replace(/[`"'[\](){}<>:;,.!?@#$%^&*+=|\\/~]/g, ' ')
    .split(/\s+/)
    .map((w) => w.trim().toLowerCase())
    .filter((w) => w.length > 2 && !STOP.has(w) && !/^\d+$/.test(w));
  const uniq = [...new Set(terms)].sort((a, b) => b.length - a.length).slice(0, 5);
  const head = 'org:' + t.owner + ' is:issue';
  const kept = [];
  let q = head;
  for (const w of uniq) {
    const next = head + ' ' + [...kept, w].join(' OR ');
    if (next.length > 240) break;
    kept.push(w);
    q = next;
  }
  if (!kept.length) q = head + ' in:title __myne_no_terms__';
  return q;
}

// --- fetch helpers --------------------------------------------------------
async function getLabels() {
  try {
    const items = await gh(`/repos/${t.owner}/${t.repo}/labels?per_page=100`);
    return (items || [])
      .filter((i) => i && i.name)
      .map((i) => ({ name: i.name, description: i.description || '' }));
  } catch { return []; }
}

async function getMilestones() {
  try {
    const items = await gh(`/repos/${t.owner}/${t.repo}/milestones?state=open&per_page=100`);
    return (items || []).filter((m) => m && m.title).map((m) => ({
      title: m.title, number: m.number, state: m.state,
      due_on: m.due_on || null, open_issues: m.open_issues || 0, closed_issues: m.closed_issues || 0,
    }));
  } catch { return []; }
}

async function getOpenIssues() {
  try {
    const raw = await gh(`/search/issues?q=org:${t.owner}+is:issue+is:open&per_page=100&sort=updated&order=desc`);
    return (raw && Array.isArray(raw.items)) ? raw.items : [];
  } catch { return []; }
}

async function searchRelated() {
  try {
    const raw = await gh(`/search/issues?q=${encodeURIComponent(relevanceQuery(t.title))}&per_page=100`);
    return (raw && Array.isArray(raw.items)) ? raw.items : [];
  } catch { return []; }
}

async function getTemplates() {
  try {
    const items = await gh(`/repos/${t.owner}/${t.repo}/contents/.github/ISSUE_TEMPLATE`);
    if (!Array.isArray(items)) return [];
    const files = items.filter((x) => x && x.name && x.type !== 'dir' && /\.(md|ya?ml)$/i.test(x.name) && String(x.name).toLowerCase() !== 'config.yml');
    return files;
  } catch { return []; }
}

// --- template parsing (Pick template files + Fetch template body) ---------
async function parseTemplates() {
  const picks = await getTemplates();
  if (!picks.length) return [];
  const entries = [];
  for (const p of picks) {
    let body = '';
    try { body = await ghText(p.url); } catch { body = ''; }
    entries.push({ name: p.name, type: p.type || 'file', body });
  }
  return extractTemplates(entries, t.repo);
}

// --- main -----------------------------------------------------------------
const [labels, milestones, openIssues, related, templates] = await Promise.all([
  getLabels(), getMilestones(), getOpenIssues(), searchRelated(), parseTemplates(),
]);

const labelEntries = labels;
const labelNames = labelEntries.map((l) => l.name);
const group = (p) => labelNames.filter((n) => n.startsWith(p));
// The descriptions go into the packet as their own map rather than replacing the name arrays,
// because two consumers read this packet: the classifier builds Jev `criteria` out of
// name -> description (a bare label name tells the model nothing it does not already infer from
// the name), while apply-verdict needs the plain name lists to validate against. Keeping the
// arrays as arrays means the second consumer does not have to know about the first.
const labelDescriptions = Object.fromEntries(
  labelEntries.filter((l) => l.description).map((l) => [l.name, l.description]),
);

let corpus = [];
try {
  const repoOf = (u) => { const p = String(u || '').split('/'); return p.length ? p[p.length - 1] : ''; };
  // Relevance first: those entries are the only ones that can name an old closed
  // duplicate, so the cap must not be spent on the recency window before they are in.
  const sources = [...related, ...openIssues];
  const seen = new Set();
  for (const it of sources) {
    if (!it || !it.number || it.pull_request) continue;
    const repo = repoOf(it.repository_url) || t.repo;
    if (!CORPUS_REPOS.has(repo)) continue;
    if (repo === t.repo && it.number === t.issueNumber) continue;
    const key = repo + '#' + it.number;
    if (seen.has(key)) continue;
    seen.add(key);
    corpus.push({
      repo, number: it.number, title: it.title,
      state: it.state === 'closed' ? 'closed' : 'open',
      closed_at: it.closed_at || null,
      milestone: (it.milestone && it.milestone.title) || null,
      body_snippet: String(it.body || '').slice(0, 500),
      labels: (it.labels || []).map((l) => (l && l.name) || l),
    });
    if (corpus.length >= 140) break;
  }
} catch { /* corpus stays as-is */ }

const openMs = milestones.filter((m) => m.state === 'open').slice().sort((a, b) => {
  const da = a.due_on ? Date.parse(a.due_on) : Infinity;
  const db = b.due_on ? Date.parse(b.due_on) : Infinity;
  if (da !== db) return da - db;
  return String(a.title).localeCompare(String(b.title));
});
const nextMilestone = openMs.length ? openMs[0].title : null;

const packet = {
  config: { duplicate_autoclose_threshold: 0.85 },
  issue: {
    repo: t.repo, number: t.issueNumber, title: t.title, body: t.body || '',
    author: t.author, author_association: t.authorAssociation, created_at: t.createdAt,
  },
  repo_context: {
    repo: t.repo,
    issue_types_enabled: ['Task', 'Bug', 'Feature'],
    labels: { type: group('type:'), area: group('area:'), status: group('status:'), meta: group('meta:'), roadmap: group('roadmap:') },
    label_descriptions: labelDescriptions,
    milestones, next_milestone: nextMilestone,
  },
  dedup_corpus: corpus,
  sibling_repos: SIBLINGS,
  templates,
};

// The router's per-issue metadata is carried out of band so apply-verdict can
// reach it without re-deriving it from the event. It is not part of the packet
// the classifier sees (the classifier has no use for node ids).
const meta = {
  owner: t.owner, repo: t.repo, issueNumber: t.issueNumber,
  issueId: t.issueId, issueNodeId: t.issueNodeId, existingLabels: t.existingLabels,
};

process.stdout.write(JSON.stringify({ packet, meta }));
