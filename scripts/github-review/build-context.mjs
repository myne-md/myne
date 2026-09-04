#!/usr/bin/env node
// build-context — deterministic port of WF4's "Normalize + gate" and "Extract
// prior signature" nodes, plus the checkout orchestration that used to live in
// review.sh.
//
// Reads the GitHub `pull_request` event, resolves the review paths (the checked
// out branch, the spec repo when the branch is a companion, the legal trees),
// and extracts the prior blocking signature + signature history from the bot's
// previous comment on this PR. It writes { packet, meta } for classify.mjs and
// apply-verdict.mjs. No LLM, no GitHub write.
//
// Env:
//   GITHUB_EVENT_PATH   the pull_request event JSON (set by GitHub Actions)
//   GITHUB_WORKSPACE    the checked-out PR branch (default cwd)
//   SPEC_REPO_DIR       set when the PR is NOT in myne; the spec checkout
//   LEGAL_REPO_DIR      set when the legal trees were cloned (website + ops)
//   MYNE_BOT_PAT        token for the read-only PR comments lookup

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';

const __dirname = dirname(new URL(import.meta.url).pathname);
const OUT = process.env.REVIEW_OUT_DIR ? join(process.env.REVIEW_OUT_DIR, 'packet.json') : join(__dirname, '..', '.review', 'packet.json');

const event = JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH || '/dev/stdin', 'utf8'));
const pr = event.pull_request || {};
const repo = event.repository || {};
const token = process.env.MYNE_BOT_PAT || '';

const owner = repo.owner?.login || 'myne-md';
const repoName = repo.name;
const prNumber = pr.number;
const base = pr.base?.ref;
const head = pr.head?.ref;
const headSha = pr.head?.sha;

if (!repoName || !prNumber || !base || !head || !headSha) {
  console.error('FATAL: event is missing repo/pr/base/head/head_sha');
  process.exit(1);
}

// --- prior signature + history (WF4 "Extract prior signature") --------------
const HEADERS = {
  Accept: 'application/vnd.github+json',
  'User-Agent': 'myne-bot',
  'X-GitHub-Api-Version': '2022-11-28',
  ...(token ? { Authorization: `Bearer ${token}` } : {}),
};

async function fetchComments() {
  const res = await fetch(`https://api.github.com/repos/${owner}/${repoName}/issues/${prNumber}/comments?per_page=100`, { headers: HEADERS });
  if (!res.ok) return [];
  return res.json();
}

let priorSignature = '';
let signatureHistory = [];
try {
  const comments = await fetchComments();
  // Comments come back oldest first, so the last match is the most recent review.
  for (const c of comments) {
    if (!c || !c.user || c.user.login !== 'myne-bot') continue;
    const b = typeof c.body === 'string' ? c.body : '';
    if (b.indexOf('<!-- myne-review -->') === -1) continue;
    const m = b.match(/Blocking-signature:\s*`([^`]*)`/);
    if (m) priorSignature = m[1];
    const hs = b.match(/<summary><b>Signature history<\/b><\/summary>([\s\S]*?)<\/details>/);
    if (hs) {
      const found = [];
      for (const line of hs[1].split('\n')) {
        const lm = line.match(/^-\s+(\d{4}-\d{2}-\d{2}:\s*`[^`]*`)\s*$/);
        if (lm) found.push(lm[1]);
      }
      if (found.length) signatureHistory = found;
    }
  }
} catch { /* prior stays empty — first review */ }

// --- paths -----------------------------------------------------------------
// The branch under review is the working directory. The spec repo is present only
// when the PR is NOT in myne, exactly as review.sh cloned it. The legal trees are
// optional in both cases.
const paths = { repo: process.env.GITHUB_WORKSPACE || process.cwd() };
if (process.env.SPEC_REPO_DIR) paths.spec_repo = process.env.SPEC_REPO_DIR;
if (process.env.LEGAL_REPO_DIR) paths.legal_repo = process.env.LEGAL_REPO_DIR;

const packet = {
  schema_version: 1,
  owner,
  repo: repoName,
  pr: {
    number: prNumber,
    title: pr.title || '',
    body: pr.body || '',
    author: pr.user?.login || '',
    base,
    head,
    head_sha: headSha,
    draft: !!pr.draft,
  },
  ...(priorSignature || signatureHistory.length
    ? { prior: { blocking_signature: priorSignature, signature_history: signatureHistory } }
    : {}),
  paths,
};

const meta = { owner, repo: repoName, prNumber, base, head, headSha };

mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(OUT, JSON.stringify({ packet, meta }));
console.log(`build-context: packet written to ${OUT} (repo=${repoName}#${prNumber}, prior=${priorSignature ? 'yes' : 'no'})`);
