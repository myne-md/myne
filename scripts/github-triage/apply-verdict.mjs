#!/usr/bin/env node
// apply-verdict — deterministic port of the n8n "Parse verdict & route" node and
// every side-effect HTTP node it routes to (WF3).
//
// Reads the classifier's verdict and applies it to GitHub via the myne-bot token:
// label PATCH, comment, duplicate close, GraphQL transferIssue, sub-issue links.
// The model never sees this code and never touches GitHub — this script owns every
// write, exactly as n8n did. The verdict is model output (free text in several
// fields), so every value is validated against what the packet offered before it
// becomes an API call.
//
// Two rules here exist because of a measured incident, myne-md/myne#472, where the
// bot undid fields the creating skill had just set: a PATCH of `labels` REPLACES
// the whole set and a `milestone: null` CLEARS the milestone, so both the label
// list and the milestone field are unioned / omitted rather than replaced.
//
// Env:
//   TRIAGE_PACKET     the packet+meta JSON written by build-packet.mjs
//   TRIAGE_VERDICT    the verdict JSON written by classify-jev.mjs
//   MYNE_BOT_PAT      the token for every GitHub write (org-wide myne-bot)

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

const __dirname = dirname(new URL(import.meta.url).pathname);
const PACKET = process.env.TRIAGE_PACKET || join(__dirname, '..', '.triage', 'packet.json');
const VERDICT = process.env.TRIAGE_VERDICT || join(__dirname, '..', '.triage', 'verdict.json');

const DRY_RUN = process.env.TRIAGE_DRY_RUN === '1' || process.env.TRIAGE_DRY_RUN === 'true';

const token = process.env.MYNE_BOT_PAT || '';
if (!token && !DRY_RUN) {
  console.error('FATAL: set MYNE_BOT_PAT');
  process.exit(1);
}

const { packet, meta } = JSON.parse(readFileSync(PACKET, 'utf8'));
let verdict;
try {
  verdict = JSON.parse(readFileSync(VERDICT, 'utf8'));
} catch (e) {
  // The classifier failed to produce a readable verdict. Apply the same
  // DESTROY-NOTHING fallback the n8n node used: keep whatever the issue already
  // carries, add status: triage, and stay loud by exiting non-zero.
  console.error(`FATAL: no readable verdict at ${VERDICT}: ${e.message}`);
  const t = meta;
  const keep = Array.isArray(t.existingLabels) ? t.existingLabels : [];
  const fallbackLabels = keep.indexOf('status: triage') === -1 ? keep.concat(['status: triage']) : keep.slice();
  await patchIssue({ labels: fallbackLabels });
  console.error('applied status: triage fallback; failing loudly for a human to see');
  process.exit(1);
}

const HEADERS = {
  Accept: 'application/vnd.github+json',
  'User-Agent': 'myne-bot',
  'X-GitHub-Api-Version': '2022-11-28',
  Authorization: `Bearer ${token}`,
};

async function gh(path, opts = {}) {
  if (DRY_RUN) {
    console.log(`DRY_RUN ${opts.method || 'GET'} ${path} ${opts.body ? JSON.stringify(opts.body) : ''}`);
    return {};
  }
  const url = path.startsWith('http') ? path : `https://api.github.com${path}`;
  const res = await fetch(url, {
    method: opts.method || 'GET',
    headers: HEADERS,
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  const text = await res.text().catch(() => '');
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { json = null; }
  if (!res.ok) {
    throw new Error(`GitHub ${res.status} ${opts.method || 'GET'} ${url}: ${text.slice(0, 300)}`);
  }
  return json;
}

const patchIssue = (body) => gh(`/repos/${meta.owner}/${meta.repo}/issues/${meta.issueNumber}`, { method: 'PATCH', body });
const commentIssue = (body) => gh(`/repos/${meta.owner}/${meta.repo}/issues/${meta.issueNumber}/comments`, { method: 'POST', body: { body } });

// --- parse the verdict, replicating n8n's Parse verdict & route --------------
const v = verdict;
const cls = v.classification || {};
const dup = v.duplicate || {};
const cross = v.cross_repo || {};
const threshold = packet.config?.duplicate_autoclose_threshold ?? 0.85;

// A transfer may only target a repo the packet actually offered. The verdict is
// model output, so target_repo is free text and can name an archived/deleted repo.
const LIVE = (packet.sibling_repos || []).map((s) => s && s.name).filter(Boolean);
const targetOffered = !!v.target_repo && LIVE.indexOf(v.target_repo) !== -1;

let action;
if (cross.should_move && v.target_repo && v.target_repo !== meta.repo && targetOffered) action = 'transfer';
else if (dup.is_duplicate && (dup.confidence || 0) >= threshold && dup.of_issue) action = 'dup_close';
else if (dup.is_duplicate && (dup.confidence || 0) >= 0.5 && dup.of_issue) action = 'dup_flag';
else action = 'triage';

// --- milestone -------------------------------------------------------------
// "A milestone is never left empty" is the tracker's rule
// (myne-agents/reference/github-issues.md), so the milestone is DERIVED here
// rather than read off the verdict, and a repo with open milestones always
// gets one. Highest OPEN version wins by numeric compare, not string order:
// v0.10 is above v0.5, and a shipped release is routinely left open, so the
// LOWEST open milestone is not where work is landing.
function compareVersionKeys(a, b) {
  const n = Math.max(a.length, b.length);
  for (let i = 0; i < n; i++) {
    const x = a[i] ?? 0, y = b[i] ?? 0;
    if (x !== y) return x - y;
  }
  return 0;
}

function currentMilestone() {
  const open = (packet.repo_context?.milestones || []).filter((m) => m && m.state === 'open');
  let best = null;
  let bestKey = null;
  for (const m of open) {
    const hit = String(m.title).match(/(\d+(?:\.\d+)*)/);
    if (!hit) continue;
    const key = hit[1].split('.').map(Number);
    if (!bestKey || compareVersionKeys(key, bestKey) > 0) { best = m; bestKey = key; }
  }
  return best;
}

const milestoneNumber = currentMilestone() ? currentMilestone().number : null;

// OMITTED rather than sent as `milestone: null`. A null milestone CLEARS one the
// issue already carries, which is the same class of damage as the label strip
// below: the bot silently undoing a field the creating skill had set.
const msField = milestoneNumber ? { milestone: milestoneNumber } : {};

// Org issue types are opt-in per repo; sending `type` where none are enabled
// makes GitHub reject the PATCH and take the whole triage pass with it.
const typesEnabled = (packet.repo_context?.issue_types_enabled || []).length > 0;
const typeField = typesEnabled ? { type: cls.issue_type || null } : {};

// --- labels ----------------------------------------------------------------
// A UNION with what the issue already carries. A PATCH of `labels` replaces the
// WHOLE set, so building this from the verdict alone deleted the `area:` and
// `status:` labels `gh issue create` had just set. Measured on myne-md/myne#472:
// milestone and `area: desktop` set at 09:50, both removed by the bot at 09:51.
const existing = Array.isArray(meta.existingLabels) ? meta.existingLabels : [];
const statuses = (cls.status_labels && cls.status_labels.length) ? cls.status_labels : ['status: triage'];
const labels = [...new Set([
  ...existing,
  cls.type_label,
  ...(cls.area_labels || []),
  ...statuses,
  cls.roadmap_label,
].filter(Boolean))];
const dupLabels = ['meta: duplicate'];

const comment = v.comment_en || '';

async function addSubIssues() {
  const rels = (v.relationships || []).filter((r) => r && r.type === 'sub_issue_of' && r.issue && meta.issueId);
  for (const r of rels) {
    const repo = r.repo || meta.repo;
    try {
      await gh(`/repos/${meta.owner}/${repo}/issues/${r.issue}/sub_issues`, {
        method: 'POST', body: { sub_issue_id: meta.issueId },
      });
      console.log(`sub-issue: linked under ${repo}#${r.issue}`);
    } catch (e) {
      console.error(`sub-issue: failed for ${repo}#${r.issue}: ${e.message}`);
    }
  }
}

async function transferIssue(targetRepo) {
  // Pre-labels on the SOURCE issue before the transfer (GitHub transfer preserves
  // them, but only labels the target already has survive — so send the shared type
  // label and status: triage, nothing repo-specific). Union with what is already
  // there: this PATCH replaces the label set, so a bare list would strip the
  // `area:` labels the creating skill set here.
  const pre = { labels: [...new Set([...existing, cls.type_label, 'status: triage'].filter(Boolean))] };
  await patchIssue(pre);

  // The transfer itself is a GraphQL mutation, as in n8n's Move: transfer issue.
  const target = await gh(`/repos/${meta.owner}/${targetRepo}`);
  const query = `mutation { transferIssue(input:{issueId:"${meta.issueNodeId}", repositoryId:"${target.node_id}", createLabelsIfMissing:true}) { issue { number url } } }`;
  await gh('https://api.github.com/graphql', { method: 'POST', body: { query } });
  console.log(`transfer: ${meta.repo}#${meta.issueNumber} → ${targetRepo}`);
}

// --- apply ------------------------------------------------------------------
console.log(`apply-verdict: action=${action} target=${v.target_repo || meta.repo} dup=${dup.of_issue || '-'}`);

try {
  if (action === 'transfer') {
    if (comment) await commentIssue(comment);
    await transferIssue(v.target_repo);
  } else if (action === 'dup_close') {
    // No milestone key on this branch, and deliberately so: a closed duplicate is
    // not work any release is going to ship, so counting it against v0.x would
    // overstate the release. An EXISTING milestone is still left untouched,
    // because omitting the key is not the same as clearing it.
    await patchIssue({ labels: [...labels, ...dupLabels], state: 'closed', state_reason: 'not_planned' });
    if (comment) await commentIssue(comment);
  } else if (action === 'dup_flag') {
    // Kept open, so it stays real work: it carries a milestone like any other open
    // issue on a repo that has them.
    await patchIssue({ labels: [...labels, ...dupLabels], ...msField, ...typeField });
    if (comment) await commentIssue(comment);
  } else {
    await patchIssue({ labels, ...msField, ...typeField });
    if (comment) await commentIssue(comment);
  }

  await addSubIssues();
} catch (e) {
  console.error(`apply-verdict: ${e.message}`);
  process.exit(1);
}

// A triage that produced no comment is a failure worth surfacing, exactly as the
// n8n "Alert: no comment produced" node did.
if (!comment) {
  console.error(`apply-verdict: verdict produced no comment for ${meta.repo}#${meta.issueNumber}`);
  process.exit(1);
}

console.log(`apply-verdict: done for ${meta.repo}#${meta.issueNumber}`);
