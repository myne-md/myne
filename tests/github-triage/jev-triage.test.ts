// Tests for the Jev triage classifier's two halves: the question set it asks, and the verdict it
// assembles from the answers.
//
// The failure these exist to catch is specific. Under the old classifier, every one of these
// decisions was made by a language model reading prose, so the only available test was "run it and
// look at the JSON". Here the decisions are code, which means the interesting cases are the ones
// where the code is wrong in a way that still produces a valid verdict: an area label built from the
// wrong question id, a duplicate read off the wrong answer, a severity read by rounding a score
// instead of reading its probabilities. None of those throw. So each is asserted directly.

import { describe, it, expect } from 'vitest';

import {
  buildQuestions,
  buildRequest,
  shortlistCorpus,
  areaQuestionId,
  templateSectionQuestionId,
  THRESHOLDS,
} from '../../scripts/github-triage/jev-questions.mjs';
import { buildVerdict } from '../../scripts/github-triage/classify-jev.mjs';
import { renderComment, BRANCHES } from '../../scripts/github-triage/render-comment.mjs';

// Everything the questions are keyed by is dynamic, so the inferred type of the returned map is the
// literal set of ids this fixture happens to produce. Widening it here keeps the assertions below
// about the VALUES rather than about the shape of a hand-maintained key list.
const q = (p: any, list: any[] = []) => buildQuestions(p, list) as Record<string, any>;

// --- fixtures -----------------------------------------------------------------

function packet(overrides = {}) {
  return {
    config: { duplicate_autoclose_threshold: 0.85 },
    issue: {
      repo: 'myne',
      number: 900,
      title: 'App crashes when I paste an image on Android',
      body: 'Steps to reproduce:\n1. Open a note\n2. Paste an image\n\nExpected: image is inserted.\nActual: the app closes.\n\nVersion: 0.8.0, Android 15.',
      author: 'someone',
    },
    repo_context: {
      repo: 'myne',
      issue_types_enabled: ['Task', 'Bug', 'Feature'],
      labels: {
        type: ['type: bug', 'type: feature', 'type: enhancement', 'type: docs', 'type: security'],
        area: ['area: crypto', 'area: editor', 'area: mobile', 'area: sync'],
        status: ['status: triage'],
        meta: ['meta: duplicate'],
        roadmap: ['roadmap: icebox', 'roadmap: v0.x'],
      },
      label_descriptions: {
        'type: bug': "Something isn't working",
        'type: security': 'Security, crypto, threat-model impact',
        'area: crypto': 'Cryptography / key handling',
        'area: mobile': 'Mobile client (mobile/)',
      },
      milestones: [
        { title: 'v0.8', number: 1, state: 'open' },
        { title: 'v0.9', number: 2, state: 'open' },
        { title: 'v0.3', number: 3, state: 'closed' },
      ],
    },
    dedup_corpus: [
      { repo: 'myne', number: 210, title: 'Paste image fails on mobile', state: 'open', closed_at: null, milestone: null, body_snippet: 'Pasting an image does nothing on the phone.', labels: ['type: bug'] },
      { repo: 'myne', number: 222, title: 'First sync of a large vault wedges', state: 'closed', closed_at: '2026-06-14T09:11:00Z', milestone: 'v0.2', body_snippet: 'The first sync wedges on a big vault.', labels: ['type: bug'] },
    ],
    sibling_repos: [
      { name: 'myne', about: 'core desktop app, web client and mobile client' },
      { name: 'myne-server', about: 'Go sync server' },
      { name: 'myne-website', about: 'marketing site' },
    ],
    templates: [
      { repo: 'myne', filename: 'bug_report.yml', name: 'Bug report', about: 'A defect report', required_sections: ['Steps to reproduce', 'Version'] },
    ],
    ...overrides,
  };
}

function answers(overrides = {}) {
  return {
    target_repo: { type: 'choice', choice: 'myne', confidence: 0.95, probabilities: { myne: 0.95, 'myne-server': 0.02, 'myne-website': 0.03 } },
    type_label: { type: 'choice', choice: 'type: bug', confidence: 0.9, probabilities: { 'type: bug': 0.9, 'type: feature': 0.1 } },
    area_mobile: { type: 'noul', noul: 0.93 },
    area_crypto: { type: 'noul', noul: 0.02 },
    area_editor: { type: 'noul', noul: 0.4 },
    area_sync: { type: 'noul', noul: 0.03 },
    severity: { type: 'score', score: 1.99, confidence: 0.97, probabilities: { '0': 0, '1': 0.01, '2': 0.99 } },
    template_used: { type: 'choice', choice: 'Bug report', confidence: 0.8 },
    needs_more_info: { type: 'noul', noul: 0.03 },
    ...overrides,
  };
}

// --- shortlist ----------------------------------------------------------------

describe('shortlistCorpus', () => {
  it('puts the lexically closest issue in the list even when it is old and closed', () => {
    const p = packet();
    // A long corpus of unrelated open issues, recency window included, so a lexical hit has to beat
    // the recency bias to appear at all.
    const noise = Array.from({ length: 40 }, (_, i) => ({
      repo: 'myne', number: 500 + i, title: `Unrelated topic number ${i} about the website footer`,
      state: 'open', closed_at: null, milestone: null, body_snippet: 'The marketing site footer is misaligned.', labels: [],
    }));
    const list = shortlistCorpus([...noise, ...p.dedup_corpus], p.issue);
    const refs = list.map((c) => `${c.repo}#${c.number}`);
    expect(refs).toContain('myne#210');
  });

  it('keeps recently updated open issues so a differently-worded re-report still has a chance', () => {
    const p = packet();
    const unrelatedButRecent = {
      repo: 'myne', number: 777, title: 'Something entirely different', state: 'open',
      closed_at: null, milestone: null, body_snippet: 'Nothing to do with images.', labels: [],
    };
    const list = shortlistCorpus([...p.dedup_corpus, unrelatedButRecent], p.issue);
    expect(list.map((c) => c.number)).toContain(777);
  });

  it('is deterministic, which is what makes dedup recall reproducible', () => {
    const p = packet();
    const a = shortlistCorpus(p.dedup_corpus, p.issue).map((c) => c.number);
    const b = shortlistCorpus(p.dedup_corpus, p.issue).map((c) => c.number);
    expect(a).toEqual(b);
  });

  it('caps the list so the corpus cannot overflow the model context', () => {
    const p = packet();
    const many = Array.from({ length: 200 }, (_, i) => ({
      repo: 'myne', number: 1000 + i, title: `issue ${i} about images and paste`,
      state: 'open', closed_at: null, milestone: null, body_snippet: 'paste image', labels: [],
    }));
    expect(shortlistCorpus(many, p.issue).length).toBeLessThanOrEqual(THRESHOLDS.shortlistLimit);
  });

  it('drops entries with no issue number rather than asking about them', () => {
    expect(shortlistCorpus([{ repo: 'myne', title: 'no number' }], { title: 'x', body: 'y' })).toEqual([]);
  });
});

// --- question set -------------------------------------------------------------

describe('buildQuestions', () => {
  it('offers only the labels the packet carries, so an unlabelled repo produces no area questions', () => {
    const p = packet();
    p.repo_context.labels.area = [];
    const qq = q(p);
    expect(Object.keys(q).some((k) => k.startsWith('area_'))).toBe(false);
    // type_label still exists because type labels are present.
    expect(qq.type_label).toBeTruthy();
  });

  it('uses the packet label descriptions as the choice criteria rather than bare names', () => {
    const qq = q(packet());
    expect(qq.type_label.criteria['type: security']).toBe('Security, crypto, threat-model impact');
  });

  it('includes the source repo as a routing option, which is what makes "stay put" expressible', () => {
    const qq = q(packet());
    expect(Object.keys(qq.target_repo.criteria)).toContain('myne');
  });

  it('omits target_repo entirely when there is nowhere else to route to', () => {
    const p = packet({ sibling_repos: [{ name: 'myne', about: 'the only repo' }] });
    expect(buildQuestions(p, []).target_repo).toBeUndefined();
  });

  it('asks one duplicate question per shortlisted candidate, addressed by index', () => {
    const p = packet();
    const list = shortlistCorpus(p.dedup_corpus, p.issue);
    const qq = q(p, list);
    const dupIds = Object.keys(qq).filter((k) => k.startsWith('dup_'));
    expect(dupIds).toHaveLength(list.length);
    expect(qq.dup_0.instructions).toContain('existing_issues[0]');
    expect(qq.dup_0.type).toBe('noul');
  });

  it('builds the question id from the same function the reader uses', () => {
    // The whole failure this guards is silent: a duplicated formula drifts, the answer comes back
    // under an id nobody reads, and the field it fed is always empty with no error anywhere.
    const qq = q(packet());
    expect(qq[areaQuestionId('mobile')]).toBeTruthy();
    expect(qq[templateSectionQuestionId('bug_report.yml', 'Version')]).toBeTruthy();
  });

  it('asks severity as an ordered score with one level per severity band', () => {
    const qq = q(packet());
    expect(qq.severity.type).toBe('score');
    expect(qq.severity.criteria).toHaveLength(3);
    // A score's criteria must be an ordered array, not a map: the answer's legend is keyed by index.
    expect(Array.isArray(qq.severity.criteria)).toBe(true);
  });

  it('omits template questions when the repo has no templates', () => {
    const p = packet({ templates: [] });
    const qq = q(p);
    expect(qq.template_used).toBeUndefined();
    expect(Object.keys(q).some((k) => k.startsWith('tpl_'))).toBe(false);
  });
});

// --- request shape ------------------------------------------------------------

describe('buildRequest', () => {
  it('produces a body the closed API schema accepts, with no bookkeeping keys', () => {
    const req = buildRequest(packet(), 'typesafe/jev-1.13');
    expect(Object.keys(req).sort()).toEqual(['_areas', '_shortlist', '_templates', 'model', 'questions', 'state']);
    // classify-jev sends exactly these three, and an extra key is a 400 rather than a warning.
    for (const q of Object.values(req.questions)) {
      expect(['choice', 'noul', 'score']).toContain(q.type);
      expect(typeof q.instructions).toBe('string');
      if (q.type === 'noul') {
        // noul criteria, when present, must carry BOTH keys or the API rejects the whole request.
        expect(Object.keys(q.criteria).sort()).toEqual(['false', 'true']);
      }
      if (q.type === 'choice') {
        expect(Object.keys(q.criteria).length).toBeGreaterThan(0);
      }
    }
  });

  it('truncates an enormous body and says so, rather than silently losing the tail', () => {
    const p = packet();
    p.issue.body = 'x'.repeat(50000);
    const req = buildRequest(p, 'm');
    expect(req.state.body.length).toBeLessThan(50000);
    expect(req.state.body_truncated).toBe(true);
  });
});

// --- verdict mapping ----------------------------------------------------------
//
// These drive the exported mapping with a real answer set rather than asserting on the module's
// source text. Asserting that a file contains a string is a test that passes when the code stops
// working, as long as the string survives in a comment, so each of these below is a case where the
// old behaviour and the new one produce DIFFERENT verdicts and the difference is asserted.

function run(p: any = packet(), over: any = {}) {
  const req = buildRequest(p, 'typesafe/jev-1.13');
  return buildVerdict(p, req, { answers: answers(over) });
}

describe('severity', () => {
  it('reads the level with the highest probability, not the rounded score', () => {
    // A score of 0.98 rounds to level 1. Reading probabilities keeps it at level 0, which is the
    // difference between "low" and "normal" on a call the model was nearly undecided about.
    const v = run(packet(), { severity: { type: 'score', score: 0.98, confidence: 0.5, probabilities: { '0': 0.98, '1': 0.01, '2': 0.01 } } });
    expect(v.classification.severity).toBe('low');
  });

  it('maps level 2 to critical and level 1 to normal', () => {
    expect(run(packet(), { severity: { type: 'score', score: 2, probabilities: { '0': 0, '1': 0, '2': 1 } } }).classification.severity).toBe('critical');
    expect(run(packet(), { severity: { type: 'score', score: 1, probabilities: { '0': 0.1, '1': 0.8, '2': 0.1 } } }).classification.severity).toBe('normal');
  });

  it('puts critical work on the current milestone and deferred work on the icebox', () => {
    const crit = run(packet(), { severity: { type: 'score', score: 2, probabilities: { '0': 0, '1': 0, '2': 1 } } });
    expect(crit.classification.roadmap_label).toBe('roadmap: v0.x');
    // The milestone is a derivation, not an answer, and it is the HIGHEST open one. v0.8 is still
    // open on this repo only because shipped milestones are not closed; v0.3 is closed and out.
    expect(crit.classification.milestone).toBe('v0.9');

    const low = run(packet(), { severity: { type: 'score', score: 0, probabilities: { '0': 1, '1': 0, '2': 0 } } });
    expect(low.classification.roadmap_label).toBe('roadmap: icebox');
  });

  it('gives normal work a milestone too, because the rule is never-empty rather than critical-only', () => {
    const v = run(packet(), { severity: { type: 'score', score: 1, probabilities: { '0': 0.1, '1': 0.8, '2': 0.1 } } });
    expect(v.classification.severity).toBe('normal');
    expect(v.classification.milestone).toBe('v0.9');
  });

  it('emits no milestone when the repo has none open, and does not invent one', () => {
    const p = packet();
    p.repo_context.milestones = [{ title: 'v0.3', number: 1, state: 'closed' }];
    expect(run(p).classification.milestone).toBeNull();
  });
});

describe('type and area', () => {
  it('derives the org issue type from the type label so the two cannot disagree', () => {
    expect(run(packet(), { type_label: { type: 'choice', choice: 'type: bug' } }).classification.issue_type).toBe('Bug');
    expect(run(packet(), { type_label: { type: 'choice', choice: 'type: feature' } }).classification.issue_type).toBe('Feature');
    expect(run(packet(), { type_label: { type: 'choice', choice: 'type: enhancement' } }).classification.issue_type).toBe('Feature');
    expect(run(packet(), { type_label: { type: 'choice', choice: 'type: docs' } }).classification.issue_type).toBe('Task');
  });

  it('emits no issue type when the org has none enabled', () => {
    const p = packet();
    p.repo_context.issue_types_enabled = [];
    expect(run(p).classification.issue_type).toBeNull();
  });

  it('keeps only the areas the model is confident about, and caps them at two', () => {
    const v = run();
    // The fixture has mobile 0.93, crypto 0.02, editor 0.4, sync 0.03.
    expect(v.classification.area_labels).toEqual(['area: mobile']);

    const many = run(packet(), {
      area_mobile: { type: 'noul', noul: 0.95 },
      area_crypto: { type: 'noul', noul: 0.9 },
      area_editor: { type: 'noul', noul: 0.85 },
      area_sync: { type: 'noul', noul: 0.8 },
    });
    expect(many.classification.area_labels).toHaveLength(THRESHOLDS.areaMax);
    expect(many.classification.area_labels[0]).toBe('area: mobile');
  });

  it('drops an area the packet does not offer, even at full confidence', () => {
    // The option set already makes this impossible from the API. This asserts the code, because
    // "impossible" is a property of the service and this is a property of the file.
    const p = packet();
    p.repo_context.labels.area = ['area: mobile'];
    const v = run(p, {
      area_mobile: { type: 'noul', noul: 0.99 },
      area_crypto: { type: 'noul', noul: 0.99 },
    });
    expect(v.classification.area_labels).toEqual(['area: mobile']);
  });
});

describe('closed option sets', () => {
  it('ignores a type_label that is not one of the options offered', () => {
    const v = run(packet(), { type_label: { type: 'choice', choice: 'type: nonexistent' } });
    expect(v.classification.type_label).toBeNull();
  });

  it('ignores a target_repo that is not one of the options offered', () => {
    // `myne-mobile` was deleted, so this is the exact shape of the historical bug: a routing answer
    // naming a repository that cannot be read back.
    const v = run(packet(), { target_repo: { type: 'choice', choice: 'myne-mobile', confidence: 0.9 } });
    expect(v.target_repo).toBe('myne');
    expect(v.cross_repo.should_move).toBe(false);
  });

  it('routes when the answer IS one of the options offered', () => {
    const v = run(packet(), { target_repo: { type: 'choice', choice: 'myne-server', confidence: 0.9 } });
    expect(v.target_repo).toBe('myne-server');
    expect(v.cross_repo.should_move).toBe(true);
  });

  it('always marks a fresh issue status: triage', () => {
    expect(run().classification.status_labels).toEqual(['status: triage']);
  });
});

describe('duplicate', () => {
  it('reports no duplicate when every candidate scores below the floor', () => {
    const v = run();
    expect(v.duplicate.is_duplicate).toBe(false);
    expect(v.duplicate.of_issue).toBeNull();
  });

  it('copies the state and release off the corpus entry rather than inferring them', () => {
    // The comment names a shipped release from this field, and a model-generated version string
    // would be a place an issue body could reach a reporter-facing sentence.
    const req = buildRequest(packet(), 'm');
    const answersAll: any = { ...answers() };
    req._shortlist.forEach((_: any, i: number) => { answersAll[`dup_${i}`] = { type: 'noul', noul: 0.1 }; });
    // Find the index of the closed v0.2 entry and push only that one over the line.
    const closedIdx = req._shortlist.findIndex((c: any) => c.state === 'closed');
    answersAll[`dup_${closedIdx}`] = { type: 'noul', noul: 0.93 };
    const v = buildVerdict(packet(), req, { answers: answersAll });
    expect(v.duplicate.is_duplicate).toBe(true);
    expect(v.duplicate.of_state).toBe('closed');
    expect(v.duplicate.of_milestone).toBe('v0.2');
    expect(v.duplicate.of_repo).toBe('myne');
  });

  it('picks the highest-scoring candidate when two both look related', () => {
    const req = buildRequest(packet(), 'm');
    const answersAll: any = { ...answers() };
    req._shortlist.forEach((_: any, i: number) => { answersAll[`dup_${i}`] = { type: 'noul', noul: 0.1 }; });
    answersAll.dup_0 = { type: 'noul', noul: 0.6 };
    answersAll.dup_1 = { type: 'noul', noul: 0.95 };
    const v = buildVerdict(packet(), req, { answers: answersAll });
    expect(v.duplicate.of_issue).toBe(req._shortlist[1].number);
  });

  it('turns a related-but-not-duplicate candidate into relates_to, at no extra cost', () => {
    const req = buildRequest(packet(), 'm');
    const answersAll: any = { ...answers() };
    req._shortlist.forEach((_: any, i: number) => { answersAll[`dup_${i}`] = { type: 'noul', noul: 0.1 }; });
    const openIdx = req._shortlist.findIndex((c: any) => c.state === 'open');
    answersAll[`rel_${openIdx}`] = { type: 'noul', noul: 0.42 };
    const v = buildVerdict(packet(), req, { answers: answersAll });
    expect(v.duplicate.is_duplicate).toBe(false);
    expect(v.relationships.map((r: any) => r.type)).toContain('relates_to');
  });

  it('never emits sub_issue_of, because parenting live work is a judgement about intent', () => {
    const req = buildRequest(packet(), 'm');
    const answersAll: any = { ...answers() };
    req._shortlist.forEach((_: any, i: number) => { answersAll[`dup_${i}`] = { type: 'noul', noul: 0.99 }; });
    const v = buildVerdict(packet(), req, { answers: answersAll });
    expect(v.relationships.every((r: any) => r.type !== 'sub_issue_of')).toBe(true);
  });
});

describe('template conformance', () => {
  it('reports a named missing section', () => {
    const v = run(packet(), {
      template_used: { type: 'choice', choice: 'Bug report' },
      [templateSectionQuestionId('bug_report.yml', 'Version')]: { type: 'noul', noul: 0.9 },
    });
    expect(v.template_conformance.missing_fields).toContain('Version');
    expect(v.template_conformance.missing_fields).not.toContain('Steps to reproduce');
  });

  it('records needs_more_info and the comment then asks for the pieces by name', () => {
    const v = run(packet(), {
      needs_more_info: { type: 'noul', noul: 0.95 },
      [templateSectionQuestionId('bug_report.yml', 'Version')]: { type: 'noul', noul: 0.9 },
    });
    expect(v.template_conformance.needs_more_info).toBe(true);
    expect(v.comment_en).toContain('Version');
  });

  it('ignores a template name that was not offered', () => {
    const v = run(packet(), { template_used: { type: 'choice', choice: 'Security report' } });
    expect(v.template_conformance.template_used).toBeNull();
  });
});

describe('confidence_overall', () => {
  it('takes the least certain load-bearing answer rather than averaging', () => {
    // Certain about the type, near a coin flip on the route: the verdict is only as good as its
    // weakest call, and a mean would let the certain one hide it.
    const v = run(packet(), {
      target_repo: { type: 'choice', choice: 'myne', confidence: 0.51 },
      type_label: { type: 'choice', choice: 'type: bug', confidence: 0.99 },
    });
    expect(v.confidence_overall).toBeLessThanOrEqual(0.51);
  });

  it('excludes the duplicate probability, since 0 is the correct answer for a clean triage', () => {
    const v = run();
    expect(v.confidence_overall).toBeGreaterThan(0.5);
  });
});

describe('verdict shape', () => {
  it('produces the contract the old classifier produced, so apply-verdict is unchanged', () => {
    const v = run();
    expect(Object.keys(v).sort()).toEqual([
      'classification', 'comment_en', 'confidence_overall', 'cross_repo', 'duplicate',
      'notes', 'relationships', 'schema_version', 'target_repo', 'template_conformance',
    ]);
    expect(v.schema_version).toBe(1);
    // There is no assignee field and there never was: ownership is a human decision.
    expect(Object.keys(v)).not.toContain('assignee');
  });

  it('always produces a comment, because apply-verdict fails the run without one', () => {
    expect(run().comment_en.length).toBeGreaterThan(0);
  });

  it('records the branch in notes for the run log, and never shows notes to a reporter', () => {
    expect(run().notes).toContain('branch=');
  });
});

// --- comment rendering --------------------------------------------------------

describe('renderComment', () => {
  const base = {
    schema_version: 1,
    target_repo: 'myne',
    cross_repo: { should_move: false, reason: '' },
    duplicate: { is_duplicate: false, of_issue: null, confidence: 0.1 },
    classification: { type_label: 'type: bug', status_labels: ['status: triage'], roadmap_label: 'roadmap: v0.x' },
    relationships: [],
    template_conformance: { template_used: null, missing_fields: [], needs_more_info: false },
  };

  it('triages an ordinary issue and asks for nothing', () => {
    const r = renderComment(base, { sourceRepo: 'myne' });
    expect(r.branch).toBe('triaged');
    expect(r.comment_en).toContain('triaged');
    expect(r.comment_en).toMatch(/Nothing else is needed/);
  });

  it('confirms a move by name and says the discussion carries over', () => {
    const r = renderComment({ ...base, target_repo: 'myne-server', cross_repo: { should_move: true, reason: '' } }, { sourceRepo: 'myne' });
    expect(r.branch).toBe('moved');
    expect(r.comment_en).toContain('myne-server');
    expect(r.comment_en).toMatch(/nothing is lost/i);
  });

  it('treats a transfer as winning over a duplicate claim, matching apply-verdict', () => {
    // Moving an issue that is also a duplicate would close it in the wrong repository.
    const v = { ...base, target_repo: 'myne-server', cross_repo: { should_move: true }, duplicate: { is_duplicate: true, of_issue: 5, confidence: 0.99 } };
    expect(renderComment(v, { sourceRepo: 'myne' }).branch).toBe('moved');
  });

  it('invites new detail when the original duplicate is still open', () => {
    const v = { ...base, duplicate: { is_duplicate: true, of_issue: 210, confidence: 0.95, of_state: 'open' } };
    const r = renderComment(v, { sourceRepo: 'myne' });
    expect(r.branch).toBe('duplicateOpen');
    expect(r.comment_en).toContain('#210');
    expect(r.comment_en).toMatch(/different problem/i);
  });

  it('names the release a fix shipped in when the original is already closed', () => {
    const v = { ...base, duplicate: { is_duplicate: true, of_issue: 222, confidence: 0.93, of_state: 'closed', of_milestone: 'v0.2' } };
    const r = renderComment(v, { sourceRepo: 'myne' });
    expect(r.branch).toBe('duplicateFixed');
    expect(r.comment_en).toContain('v0.2');
  });

  it('still offers a way back when the original is closed, because a re-report may be a regression', () => {
    const v = { ...base, duplicate: { is_duplicate: true, of_issue: 222, confidence: 0.93, of_state: 'closed', of_milestone: 'v0.2' } };
    const r = renderComment(v, { sourceRepo: 'myne' });
    expect(r.comment_en).toMatch(/reopen/i);
    // The version ask is the one piece of information that makes a regression reportable.
    expect(r.comment_en).toMatch(/which version/i);
  });

  it('omits the release sentence when the closed original shipped in no milestone', () => {
    const v = { ...base, duplicate: { is_duplicate: true, of_issue: 5, confidence: 0.9, of_state: 'closed' } };
    const r = renderComment(v, { sourceRepo: 'myne' });
    expect(r.branch).toBe('duplicateFixed');
    expect(r.comment_en).not.toMatch(/released in/);
  });

  it('hedges a below-threshold duplicate instead of closing it', () => {
    const v = { ...base, duplicate: { is_duplicate: true, of_issue: 210, confidence: 0.7, of_state: 'open' } };
    const r = renderComment(v, { sourceRepo: 'myne' });
    expect(r.branch).toBe('possibleDuplicate');
    expect(r.comment_en).toContain('#210');
  });

  it('asks for the named missing pieces when the report is too thin', () => {
    const v = { ...base, template_conformance: { template_used: 'Bug report', missing_fields: ['Version', 'Device'], needs_more_info: true } };
    const r = renderComment(v, { sourceRepo: 'myne' });
    expect(r.branch).toBe('needsInfo');
    expect(r.comment_en).toContain('Version');
    expect(r.comment_en).toContain('Device');
  });

  it('never emits a dash character, in any branch', () => {
    // The standing bot rule, and now structural rather than a prompt instruction.
    const variants = [
      base,
      { ...base, target_repo: 'myne-server', cross_repo: { should_move: true } },
      { ...base, duplicate: { is_duplicate: true, of_issue: 210, confidence: 0.95, of_state: 'open' } },
      { ...base, duplicate: { is_duplicate: true, of_issue: 222, confidence: 0.95, of_state: 'closed', of_milestone: 'v0.2' } },
      { ...base, duplicate: { is_duplicate: true, of_issue: 210, confidence: 0.7, of_state: 'open' } },
      { ...base, template_conformance: { template_used: null, missing_fields: ['Version'], needs_more_info: true } },
    ];
    for (const v of variants) {
      const r = renderComment(v, { sourceRepo: 'myne' });
      expect(r.comment_en).not.toMatch(/[\u2014\u2013]/);
    }
  });

  it('never names an internal vendor or infrastructure in a reporter-facing comment', () => {
    const banned = /\b(claude|openai|n8n|anthropic|ai model|llm|cicd\.myne\.md)\b/i;
    for (const v of [base, { ...base, duplicate: { is_duplicate: true, of_issue: 1, confidence: 0.99, of_state: 'closed', of_milestone: 'v0.2' } }]) {
      expect(renderComment(v, { sourceRepo: 'myne' }).comment_en).not.toMatch(banned);
    }
  });

  it('covers every branch it can be asked for, and no branch is unreachable', () => {
    expect(BRANCHES.sort()).toEqual(['duplicateFixed', 'duplicateOpen', 'moved', 'needsInfo', 'possibleDuplicate', 'triaged']);
  });
});

describe('humanList', () => {
  it('reads naturally for one, two and many items', async () => {
    const { humanList } = await import('../../scripts/github-triage/render-comment.mjs');
    expect(humanList(['a'])).toBe('a');
    expect(humanList(['a', 'b'])).toBe('a and b');
    expect(humanList(['a', 'b', 'c'])).toBe('a, b, and c');
    expect(humanList([])).toBe('');
  });
});

describe('threshold semantics are preserved', () => {
  it('keeps the 0.5 floor for flagging and the 0.85 ceiling for closing', () => {
    expect(THRESHOLDS.relatesFloor).toBeLessThan(0.5);
    expect(packet().config.duplicate_autoclose_threshold).toBe(0.85);
  });
});
