import { describe, it, expect } from 'vitest';
import { buildQuestions, buildRequest, relatedQuestionId } from '../../scripts/github-triage/jev-questions.mjs';
import { buildVerdict } from '../../scripts/github-triage/classify-jev.mjs';
import { extractTemplates, parseTemplateText, isTemplateFile } from '../../scripts/github-triage/parse-templates.mjs';

const packet = () => ({
  config: { duplicate_autoclose_threshold: 0.85 },
  issue: { repo: 'myne', number: 900, title: 'x', body: 'y', author: 'a' },
  repo_context: {
    repo: 'myne',
    issue_types_enabled: ['Task', 'Bug', 'Feature'],
    labels: { type: ['type: bug'], area: ['area: mobile', 'area: crypto'], status: ['status: triage'], meta: [], roadmap: ['roadmap: icebox', 'roadmap: v0.x'] },
    label_descriptions: {},
    milestones: [{ title: 'v0.9', number: 2, state: 'open' }],
  },
  dedup_corpus: [
    { repo: 'myne', number: 1, title: 'related thing', state: 'open', closed_at: null, milestone: null, body_snippet: 'related', labels: [] },
  ],
  sibling_repos: [{ name: 'myne', about: 'core' }],
  templates: [
    { repo: 'myne', filename: 'bug_report.yml', name: 'Bug report', about: 'A defect report', required_sections: ['Version'] },
  ],
});

function answers(over = {}) {
  return {
    target_repo: { type: 'choice', choice: 'myne', confidence: 0.9, probabilities: { myne: 0.9 } },
    type_label: { type: 'choice', choice: 'type: bug', confidence: 0.9, probabilities: { 'type: bug': 0.9 } },
    area_mobile: { type: 'noul', noul: 0.9 },
    area_crypto: { type: 'noul', noul: 0.1 },
    severity: { type: 'score', score: 1, confidence: 0.9, probabilities: { '0': 0.1, '1': 0.8, '2': 0.1 } },
    template_used: { type: 'choice', choice: 'Bug report', confidence: 0.8 },
    needs_more_info: { type: 'noul', noul: 0.1 },
    dup_0: { type: 'noul', noul: 0.1 },
    rel_0: { type: 'noul', noul: 0.1 },
    ...over,
  };
}

describe('template extraction', () => {
  it('parses real API-shaped entries by name', () => {
    const entries = [{ name: 'bug_report.yml', type: 'file', body: 'name: Bug report\ndescription: A defect report\nbody:\n  - type: textarea\n    attributes:\n      label: Version\n    validations:\n      required: true\n' }];
    const t = extractTemplates(entries, 'myne');
    expect(t).toHaveLength(1);
    expect(t[0].name).toBe('Bug report');
    expect(t[0].required_sections).toContain('Version');
  });

  it('excludes config.yml and directories', () => {
    const entries = [
      { name: 'config.yml', type: 'file', body: 'name: x' },
      { name: 'dir', type: 'dir', body: '' },
      { name: 'a.md', type: 'file', body: '# H' },
    ];
    const t = extractTemplates(entries, 'r');
    expect(t.map((x) => x.filename)).toEqual(['a.md']);
  });

  it('parseTemplateText is import-safe', () => {
    const p = parseTemplateText('x.yml', 'name: X\ndescription: Y');
    expect(p.name).toBe('X');
    expect(p.about).toBe('Y');
  });

  it('isTemplateFile handles missing type', () => {
    expect(isTemplateFile({ name: 'a.yml' })).toBe(true);
  });
});

describe('relatedness independence', () => {
  it('emits relates_to from rel_ answer even when dup is low', () => {
    const p = packet();
    const req = buildRequest(p, 'm');
    const ans = answers({ rel_0: { type: 'noul', noul: 0.6 } });
    const v = buildVerdict(p, req, { answers: ans });
    expect(v.duplicate.is_duplicate).toBe(false);
    expect(v.relationships.map((r: any) => r.type)).toContain('relates_to');
  });

  it('does not emit relates_to for a duplicate candidate', () => {
    const p = packet();
    const req = buildRequest(p, 'm');
    const ans = answers({ dup_0: { type: 'noul', noul: 0.9 }, rel_0: { type: 'noul', noul: 0.9 } });
    const v = buildVerdict(p, req, { answers: ans });
    expect(v.duplicate.is_duplicate).toBe(true);
    expect(v.relationships).toEqual([]);
  });
});

describe('template selection', () => {
  it('does not aggregate missing fields when none selected', () => {
    const p = packet();
    const req = buildRequest(p, 'm');
    const ans = answers({ template_used: { type: 'choice', choice: 'none', confidence: 0.8 } });
    // remove template_used offered? it is offered; 'none' is added by builder
    const v = buildVerdict(p, req, { answers: ans });
    expect(v.template_conformance.template_used).toBeNull();
    expect(v.template_conformance.missing_fields).toEqual([]);
  });

  it('buildQuestions asks rel_ per candidate', () => {
    const p = packet();
    const req = buildRequest(p, 'm');
    const qq = buildQuestions(p, req._shortlist) as any;
    expect(Object.keys(qq).filter((k) => k.startsWith('rel_'))).toHaveLength(req._shortlist.length);
  });

  it('relatedQuestionId matches', () => {
    const p = packet();
    const req = buildRequest(p, 'm');
    const qq = buildQuestions(p, req._shortlist) as any;
    expect(qq[relatedQuestionId(0)]).toBeTruthy();
  });
});

describe('incompatible scope', () => {
  it('drops area not offered even at full confidence', () => {
    const p = packet();
    p.repo_context.labels.area = ['area: mobile'];
    const req = buildRequest(p, 'm');
    const ans = answers({ area_crypto: { type: 'noul', noul: 0.99 } });
    const v = buildVerdict(p, req, { answers: ans });
    expect(v.classification.area_labels).toEqual(['area: mobile']);
  });
});

describe('missing invalid answers', () => {
  it('handles missing answers safely', () => {
    const p = packet();
    const req = buildRequest(p, 'm');
    const v = buildVerdict(p, req, { answers: {} });
    expect(v.classification.type_label).toBeNull();
    expect(v.duplicate.is_duplicate).toBe(false);
  });

  it('ignores invalid template name', () => {
    const p = packet();
    const req = buildRequest(p, 'm');
    const ans = answers({ template_used: { type: 'choice', choice: 'Security report' } });
    const v = buildVerdict(p, req, { answers: ans });
    expect(v.template_conformance.template_used).toBeNull();
  });
});
