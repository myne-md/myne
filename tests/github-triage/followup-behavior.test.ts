import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { buildRequest } from '../../scripts/github-triage/jev-questions.mjs';
import { buildVerdict } from '../../scripts/github-triage/classify-jev.mjs';
import { renderComment } from '../../scripts/github-triage/render-comment.mjs';
import { runOne, parseArgs } from '../../scripts/github-triage/eval.mjs';
import { writeFileSync, mkdirSync, rmSync, readFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

describe('followup: relatedness identity', () => {
  it('keeps a related candidate in another repo with the same number as a duplicate', () => {
    const packet: any = { repo_context: { labels: { area: [] }, milestones: [] }, issue: { repo: 'myne' }, config: {} };
    const request: any = {
      _shortlist: [
        { repo: 'myne', number: 5, state: 'open', milestone: null },
        { repo: 'other', number: 5, state: 'open', milestone: null },
      ],
      _areas: [],
      _templates: [],
      questions: {},
    };
    const answers = {
      dup_0: { type: 'noul', noul: 0.9 },
      rel_0: { type: 'noul', noul: 0.1 },
      dup_1: { type: 'noul', noul: 0.1 },
      rel_1: { type: 'noul', noul: 0.6 },
    };
    const v: any = buildVerdict(packet, request, { answers });
    expect(v.duplicate.of_repo).toBe('myne');
    expect(v.relationships.map((r: any) => `${r.repo}#${r.issue}`)).toContain('other#5');
  });
});

describe('followup: noul validation', () => {
  it('rejects bad noul values on dup and related fields', () => {
    const packet: any = { repo_context: { labels: { area: [] }, milestones: [] }, issue: { repo: 'myne' }, config: {} };
    const request: any = {
      _shortlist: [{ repo: 'myne', number: 5, state: 'open', milestone: null }],
      _areas: [],
      _templates: [],
      questions: {},
    };
    for (const bad of [2, NaN, Infinity, -0.1, '0.5', true, null, undefined, { noul: 0.5 }]) {
      const answers = { dup_0: { type: 'noul', noul: bad }, rel_0: { type: 'noul', noul: bad } };
      const v: any = buildVerdict(packet, request, { answers });
      expect(v.duplicate.is_duplicate).toBe(false);
      expect(v.relationships).toEqual([]);
    }
  });
});

describe('followup: template none', () => {
  it('does not aggregate missing fields when none selected even with 0.99 probs', () => {
    const p: any = {
      config: { duplicate_autoclose_threshold: 0.85 },
      issue: { repo: 'myne', number: 900, title: 'x', body: 'y', author: 'a' },
      repo_context: { repo: 'myne', issue_types_enabled: ['Task', 'Bug', 'Feature'], labels: { type: ['type: bug'], area: [], status: ['status: triage'], meta: [], roadmap: ['roadmap: icebox'] }, label_descriptions: {}, milestones: [{ title: 'v0.9', number: 2, state: 'open' }] },
      dedup_corpus: [],
      sibling_repos: [{ name: 'myne', about: 'core' }],
      templates: [
        { repo: 'myne', filename: 'bug_report.yml', name: 'Bug report', about: 'A defect report', required_sections: ['Version'] },
        { repo: 'myne', filename: 'feature.yml', name: 'Feature', about: 'A feature', required_sections: ['Motivation'] },
      ],
    };
    const req: any = buildRequest(p, 'm');
    const answers: any = {
      target_repo: { type: 'choice', choice: 'myne', confidence: 0.9, probabilities: { myne: 0.9 } },
      type_label: { type: 'choice', choice: 'type: bug', confidence: 0.9, probabilities: { 'type: bug': 0.9 } },
      severity: { type: 'score', score: 1, confidence: 0.9, probabilities: { '0': 0.1, '1': 0.8, '2': 0.1 } },
      template_used: { type: 'choice', choice: 'none', confidence: 0.8 },
      needs_more_info: { type: 'noul', noul: 0.1 },
    };
    for (const k of Object.keys(req.questions)) if (k.startsWith('tpl_')) answers[k] = { type: 'noul', noul: 0.99 };
    const vNone: any = buildVerdict(p, req, { answers });
    expect(vNone.template_conformance.missing_fields).toEqual([]);

    const answersSel = { ...answers, template_used: { type: 'choice', choice: 'Bug report', confidence: 0.8 } };
    const vSel: any = buildVerdict(p, req, { answers: answersSel });
    expect(vSel.template_conformance.missing_fields).toEqual(['Version']);

    const answersInv = { ...answers, template_used: { type: 'choice', choice: 'Security report', confidence: 0.8 } };
    const vInv: any = buildVerdict(p, req, { answers: answersInv });
    expect(vInv.template_conformance.missing_fields).toEqual([]);
  });
});

describe('followup: eval CLI', () => {
  let base = '';
  beforeEach(() => {
    base = mkdtempSync(join(tmpdir(), 'followup-eval-'));
    writeFileSync(join(base, 'packet-1.json'), JSON.stringify({ packet: { config: { duplicate_autoclose_threshold: 0.85 }, issue: { repo: 'myne', number: 1, title: 'x', body: 'y', author: 'a' }, repo_context: { repo: 'myne', issue_types_enabled: ['Task', 'Bug', 'Feature'], labels: { type: ['type: bug'], area: [], status: ['status: triage'], meta: [], roadmap: ['roadmap: icebox'] }, label_descriptions: {}, milestones: [{ title: 'v0.9', number: 2, state: 'open' }] }, dedup_corpus: [], sibling_repos: [{ name: 'myne', about: 'core' }], templates: [] } }));
  });
  afterEach(() => { rmSync(base, { recursive: true, force: true }); });

  it('defaults to no network and errors without --live/--offline', () => {
    expect(() => parseArgs(['node', 'eval.mjs', '--packet', join(base, 'packet-1.json'), '--out-dir', join(base, 'out')])).toThrow();
  });

  it('offline preserves usage from saved response', async () => {
    const out = join(base, 'out');
    const fakeResp = { model: 'm', answers: {}, usage: { cost: 0.00123, input_tokens: 42, total_tokens: 50 } };
    const savedPacket = { packet: JSON.parse(readFileSync(join(base, 'packet-1.json'), 'utf8')).packet };
    const savedReq = { model: 'm', state: {}, questions: {}, _shortlist: [], _areas: [], _templates: [] };
    mkdirSync(join(out, '1'), { recursive: true });
    writeFileSync(join(out, '1', 'packet.json'), JSON.stringify(savedPacket));
    writeFileSync(join(out, '1', 'request.json'), JSON.stringify(savedReq));
    writeFileSync(join(out, '1', 'response.json'), JSON.stringify(fakeResp));
    const r: any = await runOne(join(base, 'packet-1.json'), { offline: true, outDir: out, model: 'm' });
    expect(r.meta.cost_usd).toBe(0.00123);
    expect(r.meta.usage.input_tokens).toBe(42);
    expect(r.meta.live).toBe(false);
  });

  it('offline replay keeps packet/request unchanged and retains elapsed_ms', async () => {
    const out = join(base, 'out');
    const fakeResp = { model: 'm', answers: {}, usage: { cost: 0.00123, input_tokens: 42, total_tokens: 50 } };
    const savedPacket = { packet: JSON.parse(readFileSync(join(base, 'packet-1.json'), 'utf8')).packet };
    const savedReq = { model: 'm', state: {}, questions: {}, _shortlist: [], _areas: [], _templates: [] };
    mkdirSync(join(out, '1'), { recursive: true });
    writeFileSync(join(out, '1', 'packet.json'), JSON.stringify(savedPacket));
    writeFileSync(join(out, '1', 'request.json'), JSON.stringify(savedReq));
    writeFileSync(join(out, '1', 'response.json'), JSON.stringify(fakeResp));
    writeFileSync(join(out, '1', 'meta.json'), JSON.stringify({ elapsed_ms: 9876 }));
    const packetBefore = readFileSync(join(out, '1', 'packet.json'), 'utf8');
    const requestBefore = readFileSync(join(out, '1', 'request.json'), 'utf8');
    const r: any = await runOne(join(base, 'packet-1.json'), { offline: true, outDir: out, model: 'm' });
    const packetAfter = readFileSync(join(out, '1', 'packet.json'), 'utf8');
    const requestAfter = readFileSync(join(out, '1', 'request.json'), 'utf8');
    expect(packetAfter).toBe(packetBefore);
    expect(requestAfter).toBe(requestBefore);
    expect(r.meta.elapsed_ms).toBe(9876);
  });
});

describe('followup: eval CLI parseArgs', () => {
  let prevKey: string | undefined;
  beforeEach(() => { prevKey = process.env.OPENROUTER_API_KEY; delete process.env.OPENROUTER_API_KEY; });
  afterEach(() => {
    if (prevKey === undefined) delete process.env.OPENROUTER_API_KEY;
    else process.env.OPENROUTER_API_KEY = prevKey;
  });

  it('rejects unknown flag', () => {
    expect(() => parseArgs(['node', 'eval.mjs', '--nope'])).toThrow(/unknown flag/);
  });

  it('rejects repeated flag', () => {
    expect(() => parseArgs(['node', 'eval.mjs', '--live', '--live'])).toThrow(/repeated flag/);
  });

  it('rejects missing value for --packet', () => {
    expect(() => parseArgs(['node', 'eval.mjs', '--packet'])).toThrow(/requires a value/);
  });

  it('rejects missing value when next is a flag', () => {
    expect(() => parseArgs(['node', 'eval.mjs', '--packet', '--out-dir', '/tmp/x', '--offline'])).toThrow(/requires a value/);
  });

  it('rejects live without OPENROUTER_API_KEY', () => {
    expect(() => parseArgs(['node', 'eval.mjs', '--live', '--out-dir', '/tmp/x'])).toThrow(/OPENROUTER_API_KEY/);
  });
});


describe('followup: duplicate confidence boundary', () => {
  function verdictWithConfidence(c: number) {
    const packet: any = { repo_context: { labels: { area: [] }, milestones: [] }, issue: { repo: 'myne' }, config: { duplicate_autoclose_threshold: 0.85 } };
    const request: any = {
      _shortlist: [{ repo: 'myne', number: 5, state: 'open', milestone: null }],
      _areas: [], _templates: [], questions: {},
    };
    const answers = { dup_0: { type: 'noul', noul: c } };
    return buildVerdict(packet, request, { answers });
  }

  it('preserves raw confidence below the close threshold', () => {
    const v: any = verdictWithConfidence(0.849);
    expect(v.duplicate.confidence).toBe(0.849);
    expect(v.duplicate.is_duplicate).toBe(true);
    const r: any = renderComment(v, { sourceRepo: 'myne', duplicateThreshold: 0.85 });
    expect(r.branch).toBe('possibleDuplicate');
  });

  it('auto-closes at exactly 0.85', () => {
    const v: any = verdictWithConfidence(0.85);
    expect(v.duplicate.confidence).toBe(0.85);
    const r: any = renderComment(v, { sourceRepo: 'myne', duplicateThreshold: 0.85 });
    expect(r.branch).toBe('duplicateOpen');
  });

  it('auto-closes above 0.85', () => {
    const v: any = verdictWithConfidence(0.851);
    const r: any = renderComment(v, { sourceRepo: 'myne', duplicateThreshold: 0.85 });
    expect(r.branch).toBe('duplicateOpen');
  });

  it('does not mark duplicate below 0.5', () => {
    const v: any = verdictWithConfidence(0.4999);
    expect(v.duplicate.is_duplicate).toBe(false);
  });

  it('marks duplicate at 0.5 but does not auto-close', () => {
    const v: any = verdictWithConfidence(0.5);
    expect(v.duplicate.is_duplicate).toBe(true);
    const r: any = renderComment(v, { sourceRepo: 'myne', duplicateThreshold: 0.85 });
    expect(r.branch).toBe('possibleDuplicate');
  });
});
