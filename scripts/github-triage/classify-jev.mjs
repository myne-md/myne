#!/usr/bin/env node
// classify-jev — the triage classifier, as one Jev (System One) request.
//
// Replaces classify.mjs, which prepended a 200-line prose prompt to the packet and asked a language
// model to emit a JSON verdict, then parsed whatever came back. Three things went wrong with that
// and none of them were visible in a green run:
//
//   - the model could name a label, a repo or a milestone the packet did not offer, and the only
//     defence was a sentence in the prompt telling it not to;
//   - it could return a verdict missing a field, or a comment for the wrong branch, and the caller
//     had to tolerate both;
//   - the comment, the one field a reporter reads, was generated prose, so its wording was a
//     sampling outcome on the exact input where being wrong is most expensive.
//
// Jev has none of those failure modes because every answer is a distribution over options this file
// supplies. The verdict is assembled here from typed answers, the derivable fields are computed
// rather than asked for, and the comment comes from render-comment.mjs. The skill's prose is now
// the spec of these questions rather than the thing being executed.
//
// Env:
//   TRIAGE_PACKET     path to the packet JSON written by build-packet.mjs
//   TRIAGE_OUT        where the verdict is written (default: next to the packet)
//   OPENROUTER_API_KEY  the OpenRouter key (Jev is billed to the OpenRouter account)
//   TRIAGE_JEV_MODEL  model id (default: typesafe/jev-1.13, PINNED on purpose: jev-latest can move
//                     under the thresholds tuned against it)
//   TRIAGE_JEV_URL    endpoint (default: the OpenRouter Decisions API)

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';

import { buildRequest, THRESHOLDS, areaQuestionId, templateSectionQuestionId } from './jev-questions.mjs';
import { renderComment } from './render-comment.mjs';

const __dirname = dirname(new URL(import.meta.url).pathname);

const PACKET = process.env.TRIAGE_PACKET || join(__dirname, '..', '.triage', 'packet.json');
const OUT = process.env.TRIAGE_OUT || join(dirname(PACKET), 'verdict.json');
const MODEL = process.env.TRIAGE_JEV_MODEL || 'typesafe/jev-1.13';
const URL_ = process.env.TRIAGE_JEV_URL || 'https://openrouter.ai/api/alpha/decisions';
const KEY = process.env.OPENROUTER_API_KEY || '';
const TIMEOUT_MS = Number(process.env.TRIAGE_TIMEOUT_MS || 120000);

// --- derivations -------------------------------------------------------------

// Highest OPEN milestone, numerically. A shipped release is routinely left open, so the lowest open
// milestone is not where work is landing, and string order would put v0.10 below v0.5. This mirrors
// apply-verdict.mjs, which needs the same answer to write the field; the verdict carries the title so
// the two cannot disagree about which milestone was picked.
function currentMilestoneTitle(milestones) {
  let best = null;
  let bestKey = null;
  for (const m of milestones || []) {
    if (!m || m.state !== 'open') continue;
    const hit = String(m.title).match(/(\d+(?:\.\d+)*)/);
    if (!hit) continue;
    const key = hit[1].split('.').map(Number);
    let better = false;
    if (!bestKey) better = true;
    else {
      const n = Math.max(key.length, bestKey.length);
      for (let i = 0; i < n && !better; i++) {
        const x = key[i] ?? 0;
        const y = bestKey[i] ?? 0;
        if (x !== y) better = x > y;
      }
    }
    if (better) { best = m; bestKey = key; }
  }
  return best ? best.title : null;
}

// The `type:` label already decided this. Deriving it means the org issue type can never disagree
// with the label, which is the failure mode of asking for both and comparing them afterwards.
function issueTypeFor(typeLabel, enabled) {
  if (!enabled || !enabled.length) return null;
  if (typeLabel === 'type: bug') return 'Bug';
  if (typeLabel === 'type: feature' || typeLabel === 'type: enhancement') return 'Feature';
  return 'Task';
}

// Severity picks the era. The label is only emitted if the repo actually has it, because the whole
// point of the closed option set is that nothing outside the packet can be named.
function roadmapFor(severity, available) {
  const has = (n) => (available || []).includes(n);
  if (severity === 'low') {
    if (has('roadmap: icebox')) return 'roadmap: icebox';
    return null;
  }
  if (has('roadmap: v0.x')) return 'roadmap: v0.x';
  if (has('roadmap: v1.x')) return 'roadmap: v1.x';
  return null;
}

// A score answer is a float position, so the level is read off the highest probability rather than
// by rounding: a position of 0.98 is still level 0, and rounding it to 1 would relabel a marginal
// call as a confident one.
function topLevel(answer, levelCount) {
  if (!answer) return null;
  const probs = answer.probabilities || {};
  let bestIdx = null;
  let bestVal = -1;
  for (let i = 0; i < levelCount; i++) {
    const v = Number(probs[String(i)]);
    if (Number.isFinite(v) && v > bestVal) { bestVal = v; bestIdx = i; }
  }
  return bestIdx;
}

function noulOf(answers, id) {
  const a = answers[id];
  if (!a || typeof a.noul !== 'number') return null;
  return a.noul;
}

// --- request -----------------------------------------------------------------

export async function askJev(body) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  let res;
  try {
    res = await fetch(URL_, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${KEY}`,
        'Content-Type': 'application/json',
        'HTTP-Referer': 'https://github.com/myne-md/myne',
        'X-Title': 'myne-bot issue triage',
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
  } catch (e) {
    throw new Error(`Jev request failed: ${e.name === 'AbortError' ? `timeout after ${TIMEOUT_MS} ms` : e.message}`);
  } finally {
    clearTimeout(timer);
  }

  const text = await res.text().catch(() => '');
  if (!res.ok) {
    // 400 and 422 are the interesting ones: a malformed question fails the whole pass, and the
    // body says which one. Anything else is a transient upstream problem.
    throw new Error(`Jev HTTP ${res.status} ${URL_}: ${text.slice(0, 400)}`);
  }
  let json;
  try { json = JSON.parse(text); } catch { throw new Error(`Jev returned non-JSON: ${text.slice(0, 300)}`); }
  if (!json.answers || typeof json.answers !== 'object') {
    throw new Error(`Jev response has no answers object: ${text.slice(0, 300)}`);
  }
  return json;
}

// --- mapping -----------------------------------------------------------------

export function buildVerdict(packet, request, jev) {
  const answers = jev.answers || {};
  const ctx = packet.repo_context || {};
  const labelNames = ctx.labels || {};
  const shortlist = request._shortlist || [];
  const sourceRepo = packet.issue?.repo;

  // target_repo: the source repo is an option, so "stayed put" needs no sentinel.
  const targetAnswer = answers.target_repo;
  const targetOffered = new Set(request.questions.target_repo
    ? Object.keys(request.questions.target_repo.criteria)
    : []);
  let targetRepo = sourceRepo;
  if (targetAnswer && typeof targetAnswer.choice === 'string' && targetOffered.has(targetAnswer.choice)) {
    targetRepo = targetAnswer.choice;
  }
  const shouldMove = !!targetRepo && targetRepo !== sourceRepo;

  // type_label
  const typeAnswer = answers.type_label;
  const typeOffered = new Set(request.questions.type_label
    ? Object.keys(request.questions.type_label.criteria)
    : []);
  const typeLabel = (typeAnswer && typeOffered.has(typeAnswer.choice)) ? typeAnswer.choice : null;

  // area_labels: a noul per area, thresholded, capped, and re-checked against the packet. The
  // re-check is redundant with how the questions were built and stays anyway, because it is the
  // difference between "cannot happen" and "is caught here".
  const areaLabels = (request._areas || [])
    .map((slug) => ({ label: `area: ${slug}`, p: noulOf(answers, areaQuestionId(slug)) }))
    .filter((a) => a.p !== null && a.p >= THRESHOLDS.area)
    .sort((a, b) => b.p - a.p)
    .slice(0, THRESHOLDS.areaMax)
    .map((a) => a.label)
    .filter((l) => (labelNames.area || []).includes(l));

  // severity
  const SEVERITIES = ['low', 'normal', 'critical'];
  const sevIdx = topLevel(answers.severity, SEVERITIES.length);
  const severity = sevIdx === null ? 'normal' : SEVERITIES[sevIdx];

  // duplicate: argmax over the per-candidate nouls.
  const dupScored = shortlist
    .map((c, i) => ({ c, p: noulOf(answers, `dup_${i}`) }))
    .filter((d) => d.p !== null)
    .sort((a, b) => b.p - a.p);
  const best = dupScored[0] || null;
  const bestP = best ? best.p : 0;
  const isDuplicate = !!best && bestP >= 0.5;
  const duplicate = {
    is_duplicate: isDuplicate,
    of_issue: isDuplicate ? best.c.number : null,
    // The noul IS a calibrated probability, so this is the number the 0.85 threshold means. Rounded
    // to two places because it is logged and compared, and a 17-digit float is noise in both.
    confidence: Number(bestP.toFixed(2)),
    // Copied from the corpus entry rather than inferred, so the comment can name the release a fix
    // shipped in without the model having to produce a version string.
    ...(isDuplicate ? {
      of_repo: best.c.repo,
      of_state: best.c.state,
      ...(best.c.milestone ? { of_milestone: best.c.milestone } : {}),
    } : {}),
  };

  // relationships: the candidates that are related but not duplicates fall out of the same
  // probabilities the duplicate block already read, so they cost no extra tokens and no extra
  // question. `sub_issue_of` is not inferred: parenting live work to a tracked issue is a judgement
  // about intent, and an empty array is the correct answer far more often than not.
  const relationships = dupScored
    .filter((d) => d.p >= THRESHOLDS.relatesFloor && d.p < 0.5 && d.c.state !== 'closed')
    .slice(0, 3)
    .map((d) => ({
      type: 'relates_to',
      repo: d.c.repo,
      issue: d.c.number,
      reason: `Overlapping subject matter (${d.p.toFixed(2)}), not the same problem.`,
    }));

  // template conformance
  const tplAnswer = answers.template_used;
  const templates = request._templates || [];
  let templateUsed = null;
  if (tplAnswer && typeof tplAnswer.choice === 'string' && tplAnswer.choice !== 'none') {
    const hit = templates.find((t) => t.id === tplAnswer.choice);
    if (hit) templateUsed = hit.id;
  }
  const missingFields = [];
  for (const t of templates) {
    if (!t.required_sections || !t.required_sections.length) continue;
    if (templateUsed && t.id !== templateUsed) continue;
    for (const section of t.required_sections) {
      const p = noulOf(answers, templateSectionQuestionId(t.filename || t.id, section));
      if (p !== null && p >= THRESHOLDS.area) missingFields.push(section);
    }
  }
  const needsMoreInfoRaw = noulOf(answers, 'needs_more_info');
  const needsMoreInfo = (needsMoreInfoRaw ?? 0) >= 0.5;

  const milestone = currentMilestoneTitle(ctx.milestones);

  const classification = {
    issue_type: issueTypeFor(typeLabel, ctx.issue_types_enabled || []),
    type_label: typeLabel,
    area_labels: areaLabels,
    status_labels: ['status: triage'],
    severity,
    roadmap_label: roadmapFor(severity, labelNames.roadmap || []),
    milestone,
  };

  const verdict = {
    schema_version: 1,
    target_repo: targetRepo,
    cross_repo: {
      should_move: shouldMove,
      // Composed rather than generated: the repo name is the reason, and a model-written sentence
      // here would be the only remaining place an issue body could influence what a human reads.
      reason: shouldMove
        ? `Routed to ${targetRepo}: the fix belongs to that repository, not ${sourceRepo}.`
        : `Stays in ${sourceRepo}.`,
    },
    duplicate,
    classification,
    relationships,
    template_conformance: {
      template_used: templateUsed,
      missing_fields: missingFields,
      needs_more_info: needsMoreInfo,
    },
    comment_en: '',
    notes: '',
    confidence_overall: confidenceOverall(answers, targetAnswer, typeAnswer),
  };

  const rendered = renderComment(verdict, {
    duplicateThreshold: packet.config?.duplicate_autoclose_threshold ?? 0.85,
    sourceRepo,
  });
  verdict.comment_en = rendered.comment_en;
  verdict.notes = rendered.notes;

  return verdict;
}

// A single number for the run log. The minimum is the honest aggregate: a verdict is only as
// trustworthy as its least certain load-bearing call, and a mean would let one certain answer paper
// over one coin flip.
//
// Two answers are deliberately transformed or left out, and for the same reason each: a probability
// whose LOW value is the good outcome must not be minimised as though it were a confidence.
// `needs_more_info` is one: 0.03 means the model is confident the report is actionable, and taking
// the raw minimum would score every clean triage at 0.03. The duplicate probability is the other,
// and it is left out entirely rather than flipped, because 0 is the correct answer for the
// overwhelming majority of issues and including it as `1 - p` would just move the same distortion.
function confidenceOverall(answers, targetAnswer, typeAnswer) {
  const parts = [];
  const push = (v) => { if (typeof v === 'number' && Number.isFinite(v)) parts.push(v); };
  push(targetAnswer && targetAnswer.confidence);
  push(typeAnswer && typeAnswer.confidence);
  const sev = answers.severity;
  if (sev && typeof sev.confidence === 'number') push(sev.confidence);
  const thin = noulOf(answers, 'needs_more_info');
  if (thin !== null) push(Number((1 - thin).toFixed(2)));
  if (!parts.length) return 0;
  return Number(Math.min(...parts).toFixed(2));
}

// --- main --------------------------------------------------------------------

async function main() {
  if (!KEY) {
    console.error('FATAL: set OPENROUTER_API_KEY (Jev is reached through OpenRouter)');
    process.exit(1);
  }

  let packetFile;
  try { packetFile = JSON.parse(readFileSync(PACKET, 'utf8')); } catch (e) {
    console.error(`FATAL: packet at ${PACKET} is not valid JSON: ${e.message}`);
    process.exit(1);
  }
  const packet = packetFile.packet || packetFile;

  const request = buildRequest(packet, MODEL);
  const questionCount = Object.keys(request.questions).length;
  console.log(
    `classify-jev: model=${MODEL} questions=${questionCount} `
    + `shortlist=${(request._shortlist || []).length} packet=${PACKET}`,
  );

  // The body is the request minus the keys this module added for its own bookkeeping. Sending them
  // would be a 400, since the API validates the body against a closed schema.
  const body = { model: request.model, state: request.state, questions: request.questions };

  const jev = await askJev(body);
  const verdict = buildVerdict(packet, request, jev);

  mkdirSync(dirname(OUT), { recursive: true });
  writeFileSync(OUT, JSON.stringify(verdict, null, 2));
  console.log(
    `classify-jev: model=${jev.model} cost_usd=${(jev.usage && jev.usage.cost) ?? '?'} `
    + `input_tokens=${(jev.usage && jev.usage.input_tokens) ?? '?'} -> ${OUT}`,
  );
}

const isEntry = process.argv[1]
  && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isEntry) main().catch((e) => {
  // Exits non-zero on purpose. apply-verdict.mjs treats a missing verdict as the destroy-nothing
  // case: it keeps whatever labels the issue already has, adds `status: triage`, and fails loudly.
  // That is the correct behaviour for a classifier outage, and it means an outage never costs a
  // label a creating skill had already set.
  console.error(`classify-jev: ${e.message}`);
  process.exit(1);
});
