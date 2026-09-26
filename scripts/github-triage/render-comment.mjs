// render-comment — the one piece of the verdict that is prose, produced without a language model.
//
// Jev returns typed decisions and no text, and the old classifier had exactly one field that was
// really free text: `comment_en`. The tempting fix is a second, smaller model call for the sentence.
// That is the wrong shape, for three reasons that all show up in production rather than in theory:
//
//   1. The branch is already known before the sentence is written. `apply-verdict.mjs` picks one of
//      six actions from the verdict, and the right wording for each is fixed. A model is being asked
//      to rediscover a fact the code already holds.
//   2. A model can write a comment for the wrong branch, and the symptom is a bot confidently
//      telling a reporter their problem is fixed when it is not. The cost of that is not a bad
//      sentence.
//   3. The comment is the one field an issue author reads. It deserves the same guarantee the label
//      set now has, and a template is the only way to get it: no em-dash, no vendor name, no
//      internal URL, correct tense and correct pronouns, every time.
//
// So the wording lives here, as data, and the model supplies only the slots. The slots are all
// values the packet already contained, which is also why nothing here can be steered by the contents
// of an issue body: there is no field in which attacker-controlled prose reaches the output.
//
// The six branches are the ones `apply-verdict.mjs` can take. If a seventh is ever added there, the
// test asserts the two lists agree, which is the failure this file exists to make impossible.

const TEMPLATES = {
  // A native transfer. GitHub leaves a redirect from the old number and keeps the author, so the
  // reporter loses nothing and the wording says so.
  moved: (s) => [
    `Thanks for the report! This is about ${s.targetRepo}, so it has been moved to the ${s.targetRepo} `
    + 'repository where it will get the right attention. The discussion carries over, so nothing is lost.',
  ].join(' '),

  // Closed as a duplicate of an issue that is still open. This is the cheapest outcome for the
  // reporter and the one most likely to be wrong, so the invitation to move the detail is the point
  // of the message rather than a courtesy at the end of it.
  duplicateOpen: (s) => [
    `Thanks for the report. This looks like the same problem as #${s.ofIssue}, which is already open.`,
    `If it is the same thing, please add anything new you have to that issue so the fix covers it. `
    + 'If it turns out to be a different problem, say so here and we will take this one on separately.',
  ].join(' '),

  // Closed as a duplicate of an issue that is already CLOSED, so the original was resolved. This is
  // the branch where a wrong answer actively misleads someone: "already fixed" is a claim about the
  // past, and a re-report is exactly what a regression looks like. Hence the explicit ask for the
  // version they tested, which is also the one piece of information that makes a regression
  // reportable at all.
  duplicateFixed: (s) => [
    s.ofMilestone
      ? `Thanks for the report. This was already fixed in #${s.ofIssue}, released in ${s.ofMilestone}.`
      : `Thanks for the report. This was already fixed in #${s.ofIssue}.`,
    'If you are still seeing it on a build that includes that fix, please reopen this issue and tell '
    + 'us which version you tested, because that would mean the fix did not hold.',
  ].join(' '),

  // Below the auto-close threshold: flagged, not closed, because the model was not confident enough
  // to close someone's report and a wrongly closed real report is worse than a redundant open one.
  possibleDuplicate: (s) => [
    `Thanks for the report. This looks related to #${s.ofIssue}.`,
    'It is not the same problem, or there is something in that issue that does not cover yours, please '
    + 'say so here and we will treat this one on its own.',
  ].join(' '),

  // The ordinary case: triaged and labelled, no action needed from the reporter.
  triaged: (s) => (s.needsMoreInfo
    ? [
      'Thanks for the report, it has been triaged and labelled.',
      `There is a little more we need before we can start: ${s.missingList}. `
      + 'Could you add that to this issue?',
    ].join(' ')
    : [
      'Thanks for the report, it has been triaged and labelled so it is on the list.',
      'Nothing else is needed from you right now.',
    ].join(' ')),

  // A report too thin to act on, which is a distinct message from a triaged one: asking for detail
  // is the whole job here, and saying "it is on the list" would be reassuring and untrue.
  needsInfo: (s) => [
    'Thanks for the report.',
    `We need a bit more before this can be worked on: ${s.missingList}. `
    + 'Could you add that to this issue?',
  ].join(' '),
};

function humanList(items) {
  const list = (items || []).filter(Boolean);
  if (!list.length) return '';
  if (list.length === 1) return list[0];
  if (list.length === 2) return `${list[0]} and ${list[1]}`;
  return `${list.slice(0, -1).join(', ')}, and ${list[list.length - 1]}`;
}

// The branch order matters and mirrors apply-verdict.mjs exactly: transfer wins over a duplicate
// because moving an issue that is also a duplicate would close it in the wrong repository, and
// closing wins over flagging because that is the threshold's own meaning.
export function renderComment(verdict, ctx = {}) {
  const v = verdict || {};
  const cls = v.classification || {};
  const dup = v.duplicate || {};
  const cross = v.cross_repo || {};
  const tpl = v.template_conformance || {};
  const threshold = ctx.duplicateThreshold ?? 0.85;

  const confidence = typeof dup.confidence === 'number' ? dup.confidence : 0;
  const missingList = humanList(tpl.missing_fields || []);

  const slots = {
    targetRepo: v.target_repo,
    ofIssue: dup.of_issue,
    ofMilestone: dup.of_milestone,
    needsMoreInfo: !!tpl.needs_more_info,
    missingList,
  };

  let branch;
  if (cross.should_move && v.target_repo && v.target_repo !== ctx.sourceRepo) branch = 'moved';
  else if (dup.is_duplicate && confidence >= threshold && dup.of_issue) {
    branch = dup.of_state === 'closed' ? 'duplicateFixed' : 'duplicateOpen';
  } else if (dup.is_duplicate && confidence >= 0.5 && dup.of_issue) branch = 'possibleDuplicate';
  else if (tpl.needs_more_info) branch = 'needsInfo';
  else branch = 'triaged';

  const body = TEMPLATES[branch](slots);
  return {
    branch,
    comment_en: body,
    // Recorded rather than sent to the reporter. A missing_fields list that is empty while
    // needs_more_info is true is a bug in the question set, and this makes it visible in the run
    // log instead of producing a comment that asks for nothing in particular.
    notes: [
      `branch=${branch}`,
      `confidence=${confidence.toFixed(2)}`,
      missingList ? `missing=${missingList}` : null,
      cls.roadmap_label ? `roadmap=${cls.roadmap_label}` : null,
    ].filter(Boolean).join(' '),
  };
}

export const BRANCHES = Object.keys(TEMPLATES);
export { TEMPLATES, humanList };
