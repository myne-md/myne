// jev-questions — the triage criteria, expressed as Jev (System One) questions.
//
// This module replaces the issue-triage SKILL.md as the thing that actually decides. The old
// classifier was a language model asked to emit a JSON verdict, and a prose prompt can be
// satisfied by a plausible-looking document: it could name a label the repo does not have, drop a
// field, or write a comment for the wrong branch, and nothing would catch it. Jev is asked one
// typed question per decision and answers from a closed set, so an answer that names a label the
// repo lacks is not a less likely outcome, it is an impossible one. That is the whole reason for
// the migration and it is worth more than the cost and latency.
//
// Two things follow from Jev not generating text, and both are why the verdict still looks the way
// it does. Every question in a request is evaluated against the SAME state in parallel, so the whole
// classification is one round trip (adding questions barely changes latency). And the fields that
// were never really judgment are computed here or in classify-jev.mjs rather than asked for:
// milestone, roadmap label, issue type and status labels are derivations, not opinions.
//
// A note on where the rules live. `myne-agents/reference/github-issues.md` is the normative
// tracker rulebook and this file is its executable form. The prose and this file must agree; when
// they disagree the prose is wrong and gets corrected in the same change, because a criteria file
// that has quietly diverged from the rulebook is a bot nobody can audit.

// --- how many existing issues to put in front of the model ---------------------
//
// The dedup corpus build-packet assembles can hold 140 entries with 500-character bodies. That does
// not fit the 32k context this is called with, and a corpus that does not fit is not merely
// truncated, it is degraded: the tail candidates never get judged, so a real duplicate sitting at
// position 90 is invisible. Hence a deterministic shortlist, chosen by lexical overlap, and the
// reason the quality of that ranking is the thing that decides dedup recall.
const SHORTLIST_LIMIT = 30;
const RECENCY_SLOTS = 6;

// An `area:` label is kept when the model puts it above this. The label taxonomy is deliberately
// small and a subsystem is often genuinely two areas at once (`area: mobile` plus `area: ui`), so
// this is a low bar on purpose and the count is capped instead.
const AREA_THRESHOLD = 0.5;
const AREA_MAX = 2;

// Words too common in bug reports to carry any signal about which report this is.
const STOPWORDS = new Set([
  'the', 'and', 'for', 'with', 'that', 'this', 'from', 'into', 'when', 'then', 'while', 'are', 'was',
  'were', 'been', 'being', 'its', 'not', 'can', 'could', 'should', 'would', 'will', 'you', 'your',
  'our', 'their', 'they', 'has', 'have', 'had', 'but', 'all', 'any', 'some', 'more', 'most', 'other',
  'new', 'use', 'used', 'using', 'get', 'gets', 'make', 'makes', 'does', 'did', 'doesnt', 'dont',
  'cant', 'wont', 'only', 'also', 'there', 'here', 'what', 'which', 'who', 'how', 'why', 'after',
  'before', 'over', 'under', 'than', 'too', 'very', 'just', 'still', 'again', 'about', 'issue',
  'issues', 'bug', 'please', 'thanks', 'thank', 'hello', 'hi', 'expected', 'actual', 'steps',
  'reproduce', 'version', 'workaround', 'happens', 'happening', 'seems', 'like', 'want', 'need',
]);

function tokenize(text) {
  return String(text || '')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length > 2 && !STOPWORDS.has(w) && !/^\d+$/.test(w));
}

// Inverse document frequency over the corpus plus the incoming issue. Without it a candidate that
// shares the word "editor" scores the same as one sharing "damm32", and the first is noise.
function buildIdf(docs) {
  const df = new Map();
  for (const tokens of docs) {
    for (const t of new Set(tokens)) df.set(t, (df.get(t) || 0) + 1);
  }
  const n = Math.max(docs.length, 1);
  const idf = new Map();
  for (const [t, count] of df) idf.set(t, Math.log(1 + n / count));
  return idf;
}

function scoreCandidate(issueTokens, issueTokenSet, candTokens, candTokenSet, idf) {
  let score = 0;
  for (const t of candTokenSet) {
    if (issueTokenSet.has(t)) score += idf.get(t) || 0;
  }
  // A title hit is worth more than a body hit: issue titles name the subsystem, bodies ramble.
  for (const t of issueTokenSet) {
    if (candTokenSet.has(t)) score += (idf.get(t) || 0) * 0.5;
  }
  return score;
}

// Deterministic, and deliberately not a model call. The shortlist decides which candidates the
// model ever sees, so a ranking step that is itself probabilistic would make dedup recall
// unreproducible between runs over the same issue.
export function shortlistCorpus(corpus, issue, limit = SHORTLIST_LIMIT) {
  const list = (corpus || []).filter((c) => c && c.number);
  if (!list.length) return [];

  const issueTokens = tokenize(`${issue.title || ''}\n${issue.body || ''}`);
  const issueTokenSet = new Set(issueTokens);
  const candTokens = list.map((c) => tokenize(`${c.title || ''}\n${c.body_snippet || ''}`));
  const idf = buildIdf([issueTokens, ...candTokens]);

  const scored = list.map((c, i) => ({
    entry: c,
    // Same-repo first: a duplicate almost always lives next to the original.
    score: scoreCandidate(issueTokens, issueTokenSet, candTokens[i], new Set(candTokens[i]), idf)
      + (c.repo === issue.repo ? 0.75 : 0),
  }));

  const byScore = scored
    .slice()
    .sort((a, b) => b.score - a.score || b.entry.number - a.entry.number);

  // The recency window is kept alongside the lexical one. The old corpus unioned a relevance
  // search with "most recently updated open issues", and dropping the second half would lose a
  // re-report of something filed under entirely different words.
  const recency = (corpus || [])
    .filter((c) => c && c.number && c.state === 'open')
    .sort((a, b) => (b.closed_at || '').localeCompare(a.closed_at || ''));

  const picked = new Map();
  for (const c of recency.slice(0, RECENCY_SLOTS)) {
    if (!picked.has(`${c.repo}#${c.number}`)) picked.set(`${c.repo}#${c.number}`, c);
  }
  for (const { entry } of byScore) {
    if (picked.size >= limit) break;
    const key = `${entry.repo}#${entry.number}`;
    if (!picked.has(key)) picked.set(key, entry);
  }

  return [...picked.values()].slice(0, limit);
}

// --- question ids ------------------------------------------------------------
//
// The id of a question is the only handle between the question and its answer, so the two must be
// derived by the same function rather than by the same formula written twice. These were inline
// string builds in both this file and classify-jev.mjs, and a mismatch there is silent: the question
// is asked, the answer comes back under an id nobody is reading, and the field it fed is simply
// always empty. That is precisely the shape of bug no test of the verdict would catch, because the
// verdict is still valid JSON.

// The label is `area: crypto`, with a space after the colon, so this cannot be a fixed-length
// slice: `'area: crypto'.slice('area:'.length)` is `' crypto'`, and the slug then comes out as
// `area__crypto`. Both the question builder and the answer reader made that mistake in the same way
// and therefore agreed with each other, so every area question was asked and answered correctly
// under a doubled underscore. Nothing failed. A helper exists so there is one definition of the
// slug and the next reader does not have to rediscover the off-by-one.
export function areaSlug(labelName) {
  return String(labelName).replace(/^area:\s*/, '');
}

export function areaQuestionId(slug) {
  return `area_${String(slug).replace(/[^a-z0-9]+/gi, '_')}`;
}

export function templateSectionQuestionId(filename, section) {
  // Truncated because an id is also a JSON key the model echoes back, and a very long section
  // heading would make a needlessly large one. 60 chars is well past any real heading.
  return `tpl_${String(filename).replace(/[^a-z0-9]+/gi, '_')}_${String(section).replace(/[^a-z0-9]+/gi, '_')}`.slice(0, 60);
}

// --- state --------------------------------------------------------------------

const BODY_CAP = 8000;
const SNIPPET_CAP = 240;

export function buildState(packet, shortlist) {
  const issue = packet.issue || {};
  return {
    repository: issue.repo,
    title: issue.title || '',
    body: String(issue.body || '').slice(0, BODY_CAP),
    body_truncated: String(issue.body || '').length > BODY_CAP,
    // Named as prose rather than a flag on its own, because "the rest of the body was cut" is the
    // kind of thing a judge needs stated rather than inferable from a missing tail.
    note: 'This is a GitHub issue filed by a user. Judge only what the report actually says.',
    existing_issues: shortlist.map((c) => ({
      ref: `${c.repo}#${c.number}`,
      title: c.title || '',
      state: c.state,
      milestone: c.milestone || null,
      summary: String(c.body_snippet || '').slice(0, SNIPPET_CAP),
    })),
    repo_catalog: Object.fromEntries(
      (packet.sibling_repos || []).filter((s) => s && s.name).map((s) => [s.name, s.about || '']),
    ),
  };
}

// --- questions ----------------------------------------------------------------
//
// Option sets are built ONLY from what the packet offered. That is not defensive tidiness, it is
// the mechanism: a Jev answer is a distribution over the criteria keys, so the model cannot return
// a repo or a label that is not in there. A repo with no `area:` group simply produces no area
// questions, and `homebrew-tap`-style label sets simply produce a smaller choice.

function labelChoice(id, instructions, names, descriptions) {
  const criteria = {};
  for (const name of names) criteria[name] = (descriptions && descriptions[name]) || name;
  if (Object.keys(criteria).length < 1) return null;
  return { id, question: { type: 'choice', instructions, criteria } };
}

export function buildQuestions(packet, shortlist) {
  const ctx = packet.repo_context || {};
  const labels = ctx.labels || {};
  const descriptions = ctx.label_descriptions || {};
  const questions = {};

  // --- cross-repo routing -----------------------------------------------------
  // The source repo is itself an option, which is what makes "stay where it is" expressible
  // without a special case: should_move is simply "the answer is not the repo it was filed on".
  const repoNames = [...new Set([
    packet.issue?.repo,
    ...(packet.sibling_repos || []).map((s) => s && s.name),
  ].filter(Boolean))];
  if (repoNames.length > 1) {
    const criteria = {};
    for (const name of repoNames) {
      const about = (packet.sibling_repos || []).find((s) => s && s.name === name);
      criteria[name] = `${name}: ${(about && about.about) || name}`;
    }
    questions.target_repo = {
      type: 'choice',
      instructions:
        'Which repository does this issue belong to? Pick the one whose codebase the fix or the '
        + 'question is actually about. Note that the desktop, web and mobile clients all live in '
        + 'the `myne` repository, so a phone or browser report belongs there rather than in a '
        + 'separate mobile repository.',
      criteria,
    };
  }

  // --- type -------------------------------------------------------------------
  const typeQ = labelChoice(
    'type_label',
    'Which `type:` label describes this issue best? Judge what the issue IS, not which '
    + 'subsystem it touches: a defect in the editor is still a bug, not a refactor.',
    labels.type || [],
    descriptions,
  );
  if (typeQ) questions.type_label = typeQ.question;

  // --- areas ------------------------------------------------------------------
  // One noul per area rather than one choice, because the taxonomy allows two and a choice cannot
  // return two. "None of these" is expressed by every area coming back below threshold, so it
  // needs no sentinel option that would compete with a real label.
  for (const name of labels.area || []) {
    questions[areaQuestionId(areaSlug(name))] = {
      type: 'noul',
      instructions: `Is this issue genuinely about ${name}?`,
      criteria: {
        true: `The report is about ${name}, and fixing or answering it requires work there.`,
        false: `The report is not about ${name}, or only brushes against it.`,
      },
    };
  }

  // --- severity ---------------------------------------------------------------
  // A score, not a choice, because severity is an ordered spectrum and the model is documented to
  // place a state on one. The answer is a float position, so the caller reads the level with the
  // highest probability out of `probabilities` rather than rounding.
  questions.severity = {
    type: 'score',
    instructions:
      'How urgent and severe is this issue? Judge the consequence for a user of the released app: '
      + 'losing or corrupting data, a security or cryptography break, or an app that cannot be '
      + 'used at all is the top level. A real bug or a wanted feature that does not block anyone is '
      + 'the middle. A nice-to-have, a rare edge case, or something clearly out of near-term scope '
      + 'is the bottom.',
    criteria: [
      'Low: nice-to-have, a rare edge case, speculative, or clearly out of near-term scope.',
      'Normal: a real bug or a wanted feature that does not block anyone from using the app.',
      'Critical: data loss or corruption, a security or cryptography break, or the app being unusable.',
    ],
  };

  // --- duplicate detection ----------------------------------------------------
  // A noul per shortlisted candidate rather than one choice over all of them. The existing
  // threshold (0.85) is a calibrated probability, and a noul IS a calibrated probability, so the
  // number n8n routes on keeps its meaning. A choice over 30 near-identical options would return a
  // peaked `confidence` that says how decisively the model picked a winner, not how likely that
  // winner is to really be a duplicate, and those are not the same number.
  //
  // The same answer also yields `relates_to` for free, at no extra token cost: a candidate that
  // lands between the "related" and "duplicate" bars is genuinely related and is not a duplicate.
  shortlist.forEach((c, i) => {
    questions[`dup_${i}`] = {
      type: 'noul',
      instructions:
        `Is the new issue reporting the SAME underlying problem or request as \`existing_issues[${i}]\`? `
        + 'Judge the underlying problem, not shared words: two reports that mention the same screen '
        + 'but describe different failures are not duplicates.',
      criteria: {
        true:
          `A user reading both would say this is the same problem, and resolving \`existing_issues[${i}]\` `
          + 'resolves the new report too.',
        false:
          'The two are different problems. Related subject matter alone does not make them duplicates.',
      },
    };
  });

  // --- template conformance ---------------------------------------------------
  const templates = (packet.templates || []).filter((t) => t && (t.name || t.filename));
  if (templates.length) {
    const criteria = {};
    for (const t of templates) criteria[t.name || t.filename] = t.about || t.filename;
    criteria.none = 'No template applies to this issue.';
    questions.template_used = {
      type: 'choice',
      instructions: 'Which issue template should this issue have used, if any?',
      criteria,
    };
  }
  for (const t of templates) {
    for (const section of t.required_sections || []) {
      questions[templateSectionQuestionId(t.filename || t.name || 'x', section)] = {
        type: 'noul',
        instructions: `Is "${section}" MISSING from this issue's body?`,
        criteria: {
          true: `The report does not provide "${section}", so it cannot be acted on without it.`,
          false: `The report provides "${section}", even if briefly.`,
        },
      };
    }
  }

  // --- actionable detail ------------------------------------------------------
  questions.needs_more_info = {
    type: 'noul',
    instructions:
      'Is this report too thin to act on, whatever kind of issue it is? A one-line report with no '
      + 'reproduction, no description of what was expected, or no version is too thin. A detailed '
      + 'feature request is not thin just because it is a request.',
    criteria: {
      true: 'There is not enough here to start work on without asking the reporter for more.',
      false: 'There is enough here to start work on.',
    },
  };

  return questions;
}

export function buildRequest(packet, model) {
  const shortlist = shortlistCorpus(packet.dedup_corpus, packet.issue || {});
  const questions = buildQuestions(packet, shortlist);
  return {
    model,
    state: buildState(packet, shortlist),
    questions,
    // Not part of the API body. Carried so classify-jev.mjs can map `dup_3` back to a repo and
    // issue number without re-deriving the ranking, and so a test can assert the mapping.
    _shortlist: shortlist.map((c) => ({ repo: c.repo, number: c.number, state: c.state, milestone: c.milestone || null })),
    _areas: (packet.repo_context?.labels?.area || []).map((n) => areaSlug(n)),
    _templates: (packet.templates || []).filter((t) => t && (t.name || t.filename))
      .map((t) => ({ id: t.name || t.filename, filename: t.filename, required_sections: t.required_sections || [] })),
  };
}

export const THRESHOLDS = {
  area: AREA_THRESHOLD,
  areaMax: AREA_MAX,
  shortlistLimit: SHORTLIST_LIMIT,
  // A candidate this related is worth a `Related:` reference even though it is not a duplicate.
  relatesFloor: 0.35,
};
