#!/usr/bin/env node
// classify — run the pr-review-bot skill headless via `opencode run`, read-only.
//
// This is the LLM step of the review pipeline. Unlike the triage classifier,
// the reviewer READS the tree: it runs `git diff`, opens spec/legal documents,
// and reasons over the checked-out branch. The permission config below is the
// opencode equivalent of review.sh's `--allowed-tools Read Grep Glob Agent Task
// "Bash(git diff:*)"...` — edit/write/webfetch/websearch are absent, and bash is
// limited to read-only git plumbing. The model cannot modify the tree or reach
// the network.
//
// Env:
//   REVIEW_PACKET    path to the packet JSON written by build-context.mjs
//   REVIEW_SKILL     path to pr-review-bot SKILL.md
//   REVIEW_MODEL     provider/model (default: opencode-go/deepseek-v4-flash)
//   REVIEW_OUT       where the verdict is written
//   REVIEW_DIR       working directory (the checked-out PR branch)
//   OPENCODE_API_KEY the opencode-go provider key

import { spawn } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';

const __dirname = dirname(new URL(import.meta.url).pathname);

const PACKET = process.env.REVIEW_PACKET || join(__dirname, '..', '.review', 'packet.json');
const SKILL = process.env.REVIEW_SKILL || join(__dirname, '..', '..', '..', 'agent-tooling', 'skills', 'pr-review-bot', 'SKILL.md');
const MODEL = process.env.REVIEW_MODEL || 'opencode-go/deepseek-v4-flash';
const OUT = process.env.REVIEW_OUT || join(dirname(PACKET), 'verdict.json');
const DIR = process.env.REVIEW_DIR || process.env.GITHUB_WORKSPACE || process.cwd();
const TIMEOUT_MS = Number(process.env.REVIEW_TIMEOUT_MS || 1800000);

// The reviewer may only read. `task` is the subagent tool (the skill's adversarial
// pass spawns one via `Agent`). bash is restricted to read-only git plumbing; a
// subagent inherits the parent's permission gates, so it can do no more than the
// parent. This is the direct port of review.sh's allowlist.
const PERMISSION = {
  '*': 'deny',
  read: 'allow',
  grep: 'allow',
  glob: 'allow',
  task: 'allow',
  bash: {
    'git diff *': 'allow',
    'git log *': 'allow',
    'git show *': 'allow',
    'git ls-files *': 'allow',
    'git status *': 'allow',
    'git rev-parse *': 'allow',
    '*': 'deny',
  },
};

const { packet } = JSON.parse(readFileSync(PACKET, 'utf8'));

let skillBody;
try {
  skillBody = readFileSync(SKILL, 'utf8');
} catch (e) {
  console.error(`FATAL: cannot read skill at ${SKILL}: ${e.message}`);
  process.exit(1);
}
skillBody = skillBody.replace(/^---[\s\S]*?---\s*/, '');

// The skill text names the subagent tool "Agent" (its Claude Code name). Under
// opencode the same capability is the `task` tool. This note translates the one
// name so the adversarial pass does not degrade the way it degraded for a week
// under Claude Code when the skill's own name was wrong: the reviewer must not
// conclude the harness forbids a subagent it never tried to launch.
const prompt =
  skillBody +
  '\n\n# Context packet — reason over this JSON\n\n```json\n' +
  JSON.stringify(packet) +
  '\n```\n\nTool-name note for THIS harness: the subagent tool is called `task` here, not `Agent`. Where the skill says to spawn with the `Agent` tool, use `task` (it is permitted and it works; do not infer a prohibition).\n\nThe branch is checked out at the working directory. Now output ONLY the verdict JSON object described above. No prose, no fences, nothing after the closing brace.';

function runOpencode() {
  return new Promise((resolve, reject) => {
    const child = spawn('opencode', ['run', '--print-logs', '--format', 'json', '--model', MODEL, '--dir', DIR, prompt], {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, OPENCODE_PERMISSION: JSON.stringify(PERMISSION) },
    });

    let stdout = '', stderr = '';
    const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error(`opencode timeout after ${TIMEOUT_MS} ms; stderr tail: ${stderr.slice(-1200)}`)); }, TIMEOUT_MS);

    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr += d));
    child.on('error', (e) => { clearTimeout(timer); reject(e); });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code !== 0) return reject(new Error(`opencode exit ${code}: ${stderr.slice(0, 500)}`));
      resolve(stdout);
    });
  });
}

function textOf(ndjson) {
  const parts = [];
  for (const line of ndjson.split('\n')) {
    if (!line.trim()) continue;
    let ev;
    try { ev = JSON.parse(line); } catch { continue; }
    if (ev.type === 'text' && ev.part && typeof ev.part.text === 'string') parts.push(ev.part.text);
  }
  return parts.join('');
}

function extractJson(text) {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start === -1 || end === -1 || end < start) throw new Error('no JSON object found in model output');
  const slice = text.slice(start, end + 1);
  try {
    return JSON.parse(slice);
  } catch (err) {
    const m = /position (\d+)/.exec(err.message);
    const at = m ? Number(m[1]) : -1;
    const ctx = at >= 0 ? slice.slice(Math.max(0, at - 90), at + 90) : slice.slice(0, 180);
    throw new Error(`the verdict is not valid JSON: ${err.message}\n  around offset ${at}: ...${ctx}...`);
  }
}

async function main() {
  console.log(`classify: model=${MODEL} dir=${DIR}`);
  const raw = await runOpencode();
  const text = textOf(raw);
  const verdict = extractJson(text);
  mkdirSync(dirname(OUT), { recursive: true });
  writeFileSync(OUT, JSON.stringify(verdict));
  console.log(`classify: verdict written to ${OUT}`);
}

main().catch((e) => {
  console.error(`classify: ${e.message}`);
  process.exit(1);
});
