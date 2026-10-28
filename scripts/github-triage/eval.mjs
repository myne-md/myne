#!/usr/bin/env node
// eval — read-only local evaluation runner for the triage classifier.
//
// Consumes frozen packet JSON files (the same shape build-packet.mjs emits), runs the
// shipped classifier mapping, and saves raw response, verdict, elapsed time and
// API-reported usage/cost. It never calls apply-verdict and never writes to GitHub.
//
// Network calls are opt-in: --live makes real HTTP calls (requires OPENROUTER_API_KEY);
// --offline reuses saved raw responses and performs no HTTP. With neither flag the runner
// refuses to run, so a default invocation can never bill the API.
//
// Usage:
//   node scripts/github-triage/eval.mjs --live --packet /path/to/evaluation/packet-938.json --out-dir /path/to/evaluation/out
//   node scripts/github-triage/eval.mjs --live --packets-dir /path/to/evaluation --out-dir /path/to/evaluation/out
//   node scripts/github-triage/eval.mjs --offline --packets-dir /path/to/evaluation --out-dir /path/to/evaluation/out
//   node scripts/github-triage/eval.mjs --live --packet p.json --templates-snapshot /path/to/evaluation/template-api-snapshot.json --out-dir /path/to/evaluation/out
//
// Frozen snapshot + costs: --offline replays saved response.json files and records replay
// timing separately; original API-reported usage/cost are preserved verbatim from the saved
// response. --live writes response.json, request.json and packet.json so replay mappings are
// reproducible.

import { readFileSync, writeFileSync, mkdirSync, readdirSync } from 'node:fs';
import { join, basename } from 'node:path';
import { pathToFileURL } from 'node:url';

import { buildRequest } from './jev-questions.mjs';
import { buildVerdict, askJev } from './classify-jev.mjs';
import { extractTemplates } from './parse-templates.mjs';

const VALUE_FLAGS = new Set(['out-dir', 'packet', 'packets-dir', 'templates-snapshot', 'model']);
const BOOL_FLAGS = new Set(['live', 'offline']);

function argError(msg) {
  throw new Error(`eval: ${msg}`);
}

function parseArgs(argv) {
  const args = argv.slice(2);
  const seen = new Set();
  const opts = {
    live: false,
    offline: false,
    outDir: null,
    snapshot: '',
    single: null,
    dir: null,
    model: process.env.TRIAGE_JEV_MODEL || 'typesafe/jev-1.13',
  };
  let i = 0;
  while (i < args.length) {
    const a = args[i];
    if (!a.startsWith('--')) {
      argError(`unexpected positional argument: ${a}`);
    }
    const name = a.slice(2);
    const all = new Set([...VALUE_FLAGS, ...BOOL_FLAGS]);
    if (!all.has(name)) {
      argError(`unknown flag: --${name}`);
    }
    if (seen.has(name)) {
      argError(`repeated flag: --${name}`);
    }
    seen.add(name);
    if (BOOL_FLAGS.has(name)) {
      opts[name === 'live' ? 'live' : 'offline'] = true;
      i += 1;
    } else {
      const next = args[i + 1];
      if (next === undefined || next.startsWith('--')) {
        argError(`--${name} requires a value`);
      }
      if (name === 'out-dir') opts.outDir = next;
      else if (name === 'packet') opts.single = next;
      else if (name === 'packets-dir') opts.dir = next;
      else if (name === 'templates-snapshot') opts.snapshot = next;
      else if (name === 'model') opts.model = next;
      i += 2;
    }
  }
  if (opts.outDir === null) opts.outDir = join(process.cwd(), 'triage-eval-out');
  if (opts.live && opts.offline) argError('--live and --offline are mutually exclusive');
  if (!opts.live && !opts.offline) argError('one of --live or --offline is required');
  if (opts.single && opts.dir) argError('--packet and --packets-dir are mutually exclusive');
  if (opts.live) {
    const key = (process.env.OPENROUTER_API_KEY || '').trim();
    if (!key) argError('--live requires nonempty OPENROUTER_API_KEY');
  }
  return opts;
}

function packetId(filePath) {
  const m = basename(filePath).match(/packet-(\d+)\.json/);
  return m ? m[1] : basename(filePath).replace(/\.json$/, '');
}

function loadPacket(filePath, snapshot) {
  const raw = JSON.parse(readFileSync(filePath, 'utf8'));
  const packet = raw.packet || raw;
  if (snapshot) {
    const snap = JSON.parse(readFileSync(snapshot, 'utf8'));
    const entries = snap.map((x) => ({
      name: x.metadata ? x.metadata.name : x.name,
      type: x.metadata ? x.metadata.type : (x.type || 'file'),
      body: x.body ?? x.text ?? '',
    }));
    packet.templates = extractTemplates(entries, packet.issue?.repo || '');
  }
  return packet;
}

function isCompatibleRequest(req) {
  if (!req || typeof req !== 'object') return false;
  if (!req.questions || typeof req.questions !== 'object') return false;
  if (!Array.isArray(req._shortlist)) return false;
  if (!Array.isArray(req._areas)) return false;
  if (!Array.isArray(req._templates)) return false;
  if (typeof req.model !== 'string') return false;
  if (!req.state || typeof req.state !== 'object') return false;
  return true;
}

async function runOne(filePath, opts = {}) {
  const live = !!opts.live;
  const offline = !!opts.offline;
  if (live && offline) throw new Error('eval: --live and --offline are mutually exclusive');
  if (!live && !offline) throw new Error('eval: one of --live or --offline is required');

  const key = (opts.apiKey && String(opts.apiKey).trim()) || (process.env.OPENROUTER_API_KEY || '').trim();
  if (live && !key) throw new Error('eval: --live requires nonempty OPENROUTER_API_KEY');

  const outDir = opts.outDir || join(process.cwd(), 'triage-eval-out');
  const snapshot = opts.snapshot || '';
  const model = opts.model || process.env.TRIAGE_JEV_MODEL || 'typesafe/jev-1.13';

  const id = packetId(filePath);
  const dir = join(outDir, id);

  let packet;
  let req;
  let raw;
  let elapsed = 0;
  let replayElapsed = 0;
  let cost = null;
  let tokens = null;
  let usage = null;
  const respPath = join(dir, 'response.json');

  if (offline) {
    // Consume saved evidence; never rebuild or overwrite it.
    let savedPacketRaw;
    let savedReq;
    let savedResp;
    try {
      savedPacketRaw = JSON.parse(readFileSync(join(dir, 'packet.json'), 'utf8'));
    } catch (e) {
      throw new Error(`eval: missing/incompatible evidence packet.json: ${e.message}`);
    }
    try {
      savedReq = JSON.parse(readFileSync(join(dir, 'request.json'), 'utf8'));
    } catch (e) {
      throw new Error(`eval: missing/incompatible evidence request.json: ${e.message}`);
    }
    if (!isCompatibleRequest(savedReq)) {
      throw new Error('eval: saved request.json is incompatible (missing bookkeeping)');
    }
    try {
      savedResp = JSON.parse(readFileSync(respPath, 'utf8'));
    } catch (e) {
      throw new Error(`eval: missing/incompatible evidence response.json: ${e.message}`);
    }
    packet = savedPacketRaw && (savedPacketRaw.packet || savedPacketRaw);
    req = savedReq;
    raw = savedResp;

    // Preserve original API elapsed_ms if present.
    let originalElapsed = null;
    try {
      const m = JSON.parse(readFileSync(join(dir, 'meta.json'), 'utf8'));
      if (m && typeof m.elapsed_ms === 'number') originalElapsed = m.elapsed_ms;
    } catch {}

    const t0 = Date.now();
    replayElapsed = Date.now() - t0;
    usage = raw.usage || null;
    cost = usage && usage.cost;
    tokens = usage && (usage.input_tokens || usage.total_tokens);

    elapsed = (originalElapsed !== null) ? originalElapsed : 0;
  } else {
    packet = loadPacket(filePath, snapshot);
    req = buildRequest(packet, model);
    const body = { model: req.model, state: req.state, questions: req.questions };

    mkdirSync(dir, { recursive: true });
    // Save full buildRequest (with bookkeeping) and packet for reproducible replay.
    writeFileSync(join(dir, 'packet.json'), JSON.stringify(packet, null, 2));
    writeFileSync(join(dir, 'request.json'), JSON.stringify(req, null, 2));

    const t0 = Date.now();
    raw = await askJev(body, key);
    elapsed = Date.now() - t0;
    usage = raw.usage || null;
    cost = usage && usage.cost;
    tokens = usage && (usage.input_tokens || usage.total_tokens);
    writeFileSync(respPath, JSON.stringify(raw, null, 2));
  }

  const verdict = buildVerdict(packet, req, raw);
  writeFileSync(join(dir, 'verdict.json'), JSON.stringify(verdict, null, 2));

  const meta = {
    id,
    elapsed_ms: elapsed,
    replay_elapsed_ms: replayElapsed,
    cost_usd: cost,
    tokens,
    usage,
    model: (raw && raw.model) || model,
    offline,
    live,
    replay_type: offline ? 'original' : 'live',
  };
  writeFileSync(join(dir, 'meta.json'), JSON.stringify(meta, null, 2));
  return { id, verdict, meta };
}

async function main() {
  let opts;
  try {
    opts = parseArgs(process.argv);
  } catch (e) {
    console.error(e.message);
    process.exit(2);
  }
  const files = [];
  if (opts.single) files.push(opts.single);
  if (opts.dir) {
    for (const f of readdirSync(opts.dir)) {
      if (/^packet-.*\.json$/.test(f)) files.push(join(opts.dir, f));
    }
  }
  if (opts.single && opts.dir) {
    console.error('eval: --packet and --packets-dir are mutually exclusive');
    process.exit(2);
  }
  const unique = [...new Set(files)];
  if (!unique.length) {
    console.error('eval: pass --packet <file> or --packets-dir <dir>');
    process.exit(2);
  }

  const runOpts = {
    live: opts.live,
    offline: opts.offline,
    outDir: opts.outDir,
    snapshot: opts.snapshot,
    model: opts.model,
  };
  for (const f of unique.sort()) {
    const r = await runOne(f, runOpts);
    console.log(`eval: ${r.id} done (${r.meta.elapsed_ms || r.meta.replay_elapsed_ms}ms) -> ${join(opts.outDir, r.id)}`);
  }
}

const isEntry = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isEntry) main().catch((e) => { console.error(`eval: ${e.message}`); process.exit(1); });

export { runOne, loadPacket, parseArgs };
