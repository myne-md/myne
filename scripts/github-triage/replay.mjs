#!/usr/bin/env node
// replay — read-only accuracy check for the triage classifier.
//
// Answers one question the migration cannot answer by assertion: is the new classifier actually
// better than the old one, or just cheaper? "Cheaper and faster" is measurable in seconds and
// dollars. "More accurate" is not, unless there is a ground truth to compare against, so this
// builds one from what the tracker already recorded.
//
// The ground truth is not the bot's own past output, which would only measure agreement with the
// thing being replaced. It is what a HUMAN left on the issue: the `type:` label and the `status:`
// on issues that have since moved past triage. A human correcting a bot is the signal, and it is
// the only one available that is not circular.
//
// What this script does NOT do, deliberately:
//   - write to GitHub. Every call is a GET. There is no code path here that can mutate anything,
//     and TRIAGE_DRY_RUN is forced on for the apply step so a mistyped flag cannot make it write.
//   - call the old classifier for comparison unless asked. It shells out to `opencode run`, which
//     spends money and needs the provider key, so the Jev-only mode is the default.
//
// Usage:
//   node scripts/github-triage/replay.mjs --issue 222            # one issue, verbose
//   node scripts/github-triage/replay.mjs --sample 25            # N recent closed issues
//   node scripts/github-triage/replay.mjs --sample 25 --with-llm # also run the old path
//   node scripts/github-triage/replay.mjs --dry-run              # no Jev call, shape check only

import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';

import { buildRequest } from './jev-questions.mjs';
import { extractTemplates } from './parse-templates.mjs';
import { buildVerdict, askJev } from './classify-jev.mjs';

const __dirname = dirname(new URL(import.meta.url).pathname);
const OWNER = 'myne-md';
const REPO = process.env.TRIAGE_REPLAY_REPO || 'myne';

function arg(name, fallback = null) {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? fallback : (process.argv[i + 1] ?? true);
}

const KEY = process.env.OPENROUTER_API_KEY || '';
const DRY = process.argv.includes('--dry-run');
const WITH_LLM = process.argv.includes('--with-llm');
const TEMPLATES_SNAPSHOT = (function () {
  const i = process.argv.indexOf('--templates-snapshot');
  if (i !== -1) return process.argv[i + 1];
  return process.env.TRIAGE_TEMPLATES_SNAPSHOT || '';
})();

// Ground truth comes from the labels a human left. `status: triage` is EXCLUDED on purpose: the bot
// writes that one, so counting it as agreement would measure the bot against itself. What is left is
// the set only a human sets, which is where a wrong triage actually shows up.
const HUMAN_SET_LABELS = (labels) => labels
  .map((l) => (typeof l === 'string' ? l : l.name))
  .filter((n) => n && (n.startsWith('type:') || n.startsWith('area:') || n.startsWith('roadmap:')));

async function gh(path) {
  const res = await fetch(`https://api.github.com${path}`, {
    headers: {
      Accept: 'application/vnd.github+json',
      'User-Agent': 'myne-bot-replay',
      'X-GitHub-Api-Version': '2022-11-28',
      ...(process.env.MYNE_BOT_PAT || process.env.GH_TOKEN
        ? { Authorization: `Bearer ${process.env.MYNE_BOT_PAT || process.env.GH_TOKEN}` }
        : {}),
    },
  });
  if (!res.ok) throw new Error(`GitHub ${res.status} ${path}`);
  return res.json();
}

// A packet shaped exactly like build-packet's, assembled from a single issue rather than from a
// webhook event. The fields that build-packet derives from the EVENT (node ids, existing labels)
// are carried in `meta`, which the classifier never reads, so they are stubbed here.

async function ghText(path) {
  const res = await fetch(`https://api.github.com${path}`, {
    headers: {
      Accept: 'application/vnd.github.raw',
      'User-Agent': 'myne-bot-replay',
      'X-GitHub-Api-Version': '2022-11-28',
      ...(process.env.MYNE_BOT_PAT || process.env.GH_TOKEN
        ? { Authorization: `Bearer ${process.env.MYNE_BOT_PAT || process.env.GH_TOKEN}` }
        : {}),
    },
  });
  if (!res.ok) throw new Error(`GitHub ${res.status} ${path}`);
  return res.text();
}

async function packetFor(number) {
  const issue = await gh(`/repos/${OWNER}/${REPO}/issues/${number}`);
  if (issue.pull_request) throw new Error(`#${number} is a PR`);

  const [labels, milestones, templateEntries, corpus] = await Promise.all([
    gh(`/repos/${OWNER}/${REPO}/labels?per_page=100`).catch(() => []),
    gh(`/repos/${OWNER}/${REPO}/milestones?state=open&per_page=100`).catch(() => []),
    TEMPLATES_SNAPSHOT ? Promise.resolve([]) : gh(`/repos/${OWNER}/${REPO}/contents/.github/ISSUE_TEMPLATE`).catch(() => []),
    gh(`/search/issues?q=${encodeURIComponent(`org:${OWNER} is:issue`)}&per_page=60&sort=updated&order=desc`)
      .then((r) => (r && r.items) || []).catch(() => []),
  ]);

  const labelEntries = (labels || []).filter((l) => l && l.name).map((l) => ({ name: l.name, description: l.description || '' }));
  const labelNames = labelEntries.map((l) => l.name);
  const group = (p) => labelNames.filter((n) => n.startsWith(p));
  const repoOf = (u) => String(u || '').split('/').pop() || REPO;

  const dedup = [];
  for (const it of corpus) {
    if (!it || !it.number || it.pull_request) continue;
    const r = repoOf(it.repository_url);
    if (r === REPO && it.number === number) continue;
    dedup.push({
      repo: r, number: it.number, title: it.title,
      state: it.state === 'closed' ? 'closed' : 'open',
      closed_at: it.closed_at || null,
      milestone: (it.milestone && it.milestone.title) || null,
      body_snippet: String(it.body || '').slice(0, 500),
      labels: (it.labels || []).map((l) => (l && l.name) || l),
    });
    if (dedup.length >= 140) break;
  }

  // Fetch template bodies and parse them with the shared extractor, so replay uses the same
  // real template names/descriptions/required fields as production.
  let tplParsed = [];
  if (Array.isArray(templateEntries)) {
    const entries = [];
    for (const te of templateEntries) {
      if (!te || !te.name || te.type === 'dir') continue;
      if (!/\.(md|ya?ml)$/i.test(te.name) || String(te.name).toLowerCase() === 'config.yml') continue;
      let body = '';
      try { body = await ghText(`/repos/${OWNER}/${REPO}/contents/${te.path}`); } catch { body = ''; }
      entries.push({ name: te.name, type: te.type || 'file', body });
    }
    tplParsed = extractTemplates(entries, REPO);
  }

  if (TEMPLATES_SNAPSHOT) {
    const raw = JSON.parse(readFileSync(TEMPLATES_SNAPSHOT, 'utf8'));
    const entries = raw.map((x) => ({ name: x.metadata ? x.metadata.name : x.name, type: x.metadata ? x.metadata.type : (x.type || 'file'), body: x.body ?? x.text ?? '' }));
    tplParsed = extractTemplates(entries, REPO);
  }

  return {
    packet: {
      config: { duplicate_autoclose_threshold: 0.85 },
      issue: {
        repo: REPO, number, title: issue.title || '', body: issue.body || '',
        author: (issue.user && issue.user.login) || '', author_association: issue.author_association || 'NONE',
        created_at: issue.created_at,
      },
      repo_context: {
        repo: REPO,
        issue_types_enabled: ['Task', 'Bug', 'Feature'],
        labels: {
          type: group('type:'), area: group('area:'), status: group('status:'),
          meta: group('meta:'), roadmap: group('roadmap:'),
        },
        label_descriptions: Object.fromEntries(labelEntries.filter((l) => l.description).map((l) => [l.name, l.description])),
        milestones: (milestones || []).map((m) => ({ title: m.title, number: m.number, state: m.state })),
        next_milestone: null,
      },
      dedup_corpus: dedup,
      sibling_repos: [
        { name: 'myne', about: 'core desktop app, specs, web client, AND the iOS + Android mobile client' },
        { name: 'myne-server', about: 'Go sync server, self-hostable' },
        { name: 'myne-website', about: 'marketing site myne.md' },
        { name: 'myne-clipper', about: 'browser web-clipper extension' },
        { name: 'myne-themes', about: 'custom-theme marketplace' },
        { name: 'myne-test-vectors', about: 'protocol test vectors' },
        { name: 'myne-branding', about: 'brand assets' },
        { name: 'agent-tooling', about: 'internal agents/skills (private)', private: true },
        { name: 'operations', about: 'internal ops/infra (private)', private: true },
      ],
      templates: tplParsed.length ? tplParsed : [],
    },
    meta: {
      owner: OWNER, repo: REPO, issueNumber: number,
      issueId: issue.id, issueNodeId: issue.node_id,
      existingLabels: (issue.labels || []).map((l) => l.name),
    },
  };
}

async function jevVerdict(packetFile) {
  const req = buildRequest(packetFile.packet, process.env.TRIAGE_JEV_MODEL || 'typesafe/jev-1.13');
  const body = { model: req.model, state: req.state, questions: req.questions };
  if (DRY) return { dry: true, questions: Object.keys(body.questions).length, shortlist: req._shortlist.length };
  const jev = await askJev(body);
  // The mapping is the shipped one, imported rather than reimplemented. A replay harness that
  // reimplemented the rules would measure the harness.
  const verdict = buildVerdict(packetFile.packet, req, jev);
  return { verdict, cost: jev.usage && jev.usage.cost, tokens: jev.usage && jev.usage.input_tokens };
}

function llmVerdict(packetFile) {
  // The old path, kept runnable so the comparison is a measurement rather than an assertion. It
  // needs the provider key and spends money, hence opt-in.
  const skillPath = process.env.TRIAGE_SKILL
    || join(__dirname, '..', '..', '..', 'agent-tooling', 'skills', 'issue-triage', 'SKILL.md');
  const skill = readFileSync(skillPath, 'utf8').replace(/^---[\s\S]*?---\s*/, '');
  const prompt = `${skill}\n\n# Context packet\n\n\`\`\`json\n${JSON.stringify(packetFile.packet)}\n\`\`\`\n\nNow output ONLY the verdict JSON object.`;
  const out = execFileSync('opencode', ['run', '--format', 'json', '--model', process.env.TRIAGE_MODEL || 'opencode-go/deepseek-v4-flash'], {
    input: prompt, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, timeout: 300000,
  });
  const parts = [];
  for (const line of out.split('\n')) {
    if (!line.trim()) continue;
    try { const ev = JSON.parse(line); if (ev.type === 'text' && ev.part) parts.push(ev.part.text); } catch { /* skip */ }
  }
  const text = parts.join('');
  const s = text.indexOf('{');
  const e = text.lastIndexOf('}');
  if (s === -1 || e === -1) throw new Error('no JSON in old-path output');
  return JSON.parse(text.slice(s, e + 1));
}

function scoreOne(verdict, truth) {
  const got = HUMAN_SET_LABELS(verdict.classification ? [
    verdict.classification.type_label,
    ...(verdict.classification.area_labels || []),
    verdict.classification.roadmap_label,
  ].filter(Boolean) : []);
  const want = HUMAN_SET_LABELS(truth);
  const gotSet = new Set(got);
  const wantSet = new Set(want);
  const hit = want.filter((l) => gotSet.has(l));
  const miss = want.filter((l) => !gotSet.has(l));
  const extra = got.filter((l) => !wantSet.has(l));
  return {
    hit, miss, extra,
    exact: miss.length === 0 && extra.length === 0,
    jaccard: wantSet.size === 0 ? null : hit.length / new Set([...wantSet, ...gotSet]).size,
  };
}

async function main() {
  if (!DRY && !KEY && !WITH_LLM) {
    console.error('FATAL: set OPENROUTER_API_KEY (or pass --dry-run to check shapes without a call)');
    process.exit(1);
  }

  const single = arg('issue');
  const sample = Number(arg('sample', 0));
  let numbers = [];
  if (single) numbers = [Number(single)];
  else if (sample) {
    const closed = await gh(`/repos/${OWNER}/${REPO}/issues?state=closed&per_page=${Math.min(sample * 2, 100)}&sort=updated&order=desc`);
    numbers = closed.filter((i) => !i.pull_request).slice(0, sample).map((i) => i.number);
  } else {
    console.error('pass --issue <n> or --sample <n>');
    process.exit(1);
  }

  const rows = [];
  for (const n of numbers) {
    let pf;
    try { pf = await packetFor(n); } catch (e) { console.error(`#${n}: packet failed: ${e.message}`); continue; }

    const out = await jevVerdict(pf);
    if (DRY) { console.log(`#${n}: shape ok, ${out.questions} questions, shortlist ${out.shortlist}`); continue; }

    const truth = await gh(`/repos/${OWNER}/${REPO}/issues/${n}`);
    const row = {
      number: n,
      title: pf.packet.issue.title,
      jev: scoreOne(out.verdict, truth.labels || []),
      jev_cost: out.cost,
      jev_tokens: out.tokens,
    };

    if (WITH_LLM) {
      try {
        row.llm = scoreOne(llmVerdict(pf), truth.labels || []);
      } catch (e) { row.llm = { error: e.message }; }
    }
    rows.push(row);

    const parts = [`#${n} jev exact=${row.jev.exact} hit=[${row.jev.hit}] miss=[${row.jev.miss}] extra=[${row.jev.extra}]`];
    if (row.llm && !row.llm.error) parts.push(`llm exact=${row.llm.exact} hit=[${row.llm.hit}] miss=[${row.llm.miss}] extra=[${row.llm.extra}]`);
    console.log(parts.join('  |  '));
  }

  if (rows.length && !DRY) {
    const exact = rows.filter((r) => r.jev.exact).length;
    const jac = rows.map((r) => r.jev.jaccard).filter((x) => x !== null);
    console.log(`\nJev: ${exact}/${rows.length} exact, mean jaccard ${(jac.reduce((a, b) => a + b, 0) / (jac.length || 1)).toFixed(3)}`);
    const llmRows = rows.filter((r) => r.llm && !r.llm.error);
    if (llmRows.length) {
      const lexact = llmRows.filter((r) => r.llm.exact).length;
      const ljac = llmRows.map((r) => r.llm.jaccard).filter((x) => x !== null);
      console.log(`LLM: ${lexact}/${llmRows.length} exact, mean jaccard ${(ljac.reduce((a, b) => a + b, 0) / (ljac.length || 1)).toFixed(3)}`);
    }
    const costs = rows.map((r) => r.jev_cost).filter((x) => x !== undefined);
    if (costs.length) console.log(`Jev mean cost $${(costs.reduce((a, b) => a + b, 0) / costs.length).toFixed(6)} per issue`);
  }
}

main().catch((e) => { console.error(`replay: ${e.message}`); process.exit(1); });
