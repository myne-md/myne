// Real-render axe-core pass for the E2E harness (MYND-93, task 7).
//
// The Vitest tier (tests/a11y/) runs axe in jsdom — fast, but jsdom can't
// compute layout/paint, so its `color-contrast` rule is disabled there. THIS
// tier injects the axe-core source into the real WebKit WebView and runs the
// FULL WCAG 2.2 AA rule set INCLUDING contrast and target-size (the two rules
// jsdom cannot evaluate). This is the authoritative check.
//
// Rule scope is imported from the shared config so the two tiers never drift.

import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { WCAG_AA_TAGS } from "../../tests/a11y/axe-config";
import type { Session } from "./webdriver";

const require = createRequire(import.meta.url);
/** The axe-core UMD source, read once; injected into the page per run. */
const AXE_SOURCE = readFileSync(require.resolve("axe-core"), "utf8");

/**
 * Wait for the page's FINISHED-state styles before sampling it.
 *
 * `color-contrast` is not a property of a token pair alone: axe walks each text
 * node's ancestor chain, multiplies every ancestor's computed `opacity` into an
 * effective alpha, and blends the colours before computing the ratio. A
 * computed `opacity` reflects the CURRENT animated value, so an element inside a
 * running fade is measured part-way through it and reports a violation the user
 * never sees.
 *
 * The unlock front door is exactly that case and it is not hypothetical. Its
 * shell carries an entrance animation (`AuthShell`, `data-enter`, the
 * `myne-auth-enter-forward`/`-back` keyframes in `client-core/src/components.css`:
 * `opacity: 0` to `1` over `--duration-base`, 180 ms), and AX-2 runs axe as soon
 * as `unlock.form` exists, which is the first frame of that fade. Every text node
 * inside `.myne-auth-view` is then sampled at a fraction of its real contrast,
 * and the three that tip below AA are the three with the least headroom to begin
 * with — the heading subtitle and the two secondary links. The tokens are fine;
 * the measurement happened mid-transition.
 *
 * `getAnimations()` is the standard way to ask, and it is what separates "the
 * interface is low-contrast" from "the interface was photographed while it was
 * still arriving". INFINITE animations are deliberately excluded rather than
 * waited on: a spinner runs forever by design, and waiting for it would put every
 * axe run behind a full timeout.
 *
 * A bounded wait rather than an assertion: if something genuinely never settles
 * the sampling proceeds and whatever axe reports is the honest answer, rather
 * than a new failure mode in the harness.
 */
async function settleAnimations(session: Session, timeoutMs = 3_000): Promise<void> {
  await session.executeAsync<number>(
    "var done = arguments[arguments.length - 1];" +
      "var deadline = Date.now() + arguments[0];" +
      "function running() {" +
      "  if (typeof document.getAnimations !== 'function') return [];" +
      "  return document.getAnimations().filter(function (a) {" +
      "    if (a.playState !== 'running') return false;" +
      "    var t = a.effect && a.effect.getComputedTiming ? a.effect.getComputedTiming() : null;" +
      "    return !(t && t.iterations === Infinity);" +
      "  });" +
      "}" +
      "function check() {" +
      "  var left = running();" +
      "  if (left.length === 0 || Date.now() > deadline) { done(left.length); return; }" +
      "  requestAnimationFrame(check);" +
      "}" +
      "requestAnimationFrame(check);",
    [timeoutMs],
  );
}

export interface AxeViolation {
  id: string;
  impact: string | null;
  help: string;
  /** Number of DOM nodes that tripped this rule. */
  nodes: number;
  /** CSS-path targets of the offending nodes (first few), for triage. */
  targets: string[];
}

/**
 * Inject axe into the page and run the WCAG 2.2 AA rule set (contrast and
 * target-size included) against `contextSelector` (default: the whole document).
 * Returns the violations — empty array means the screen passed.
 */
export async function runAxeInPage(
  session: Session,
  contextSelector?: string,
): Promise<AxeViolation[]> {
  // Settle first: see `settleAnimations` for why a running fade is not a
  // contrast defect.
  await settleAnimations(session);

  // Define window.axe (idempotent — re-injecting is harmless).
  await session.execute(AXE_SOURCE);

  const options = { runOnly: { type: "tag", values: [...WCAG_AA_TAGS] } };
  const result = await session.executeAsync<{ violations: RawViolation[] }>(
    "var done = arguments[arguments.length - 1];" +
      "var sel = arguments[0];" +
      "var ctx = sel ? document.querySelector(sel) : document;" +
      "window.axe.run(ctx || document, arguments[1]).then(function (r) {" +
      "  done({ violations: r.violations });" +
      "}).catch(function (e) {" +
      "  done({ violations: [{ id: 'axe-run-error', impact: 'critical'," +
      "    help: String(e && e.message ? e.message : e)," +
      "    nodes: [{ target: ['(axe threw)'] }] }] });" +
      "});",
    [contextSelector ?? null, options],
  );

  return result.violations.map((v) => ({
    id: v.id,
    impact: v.impact ?? null,
    help: v.help,
    nodes: v.nodes.length,
    targets: v.nodes.slice(0, 5).flatMap((n) => n.target ?? []),
  }));
}

/** Readable one-line-per-violation summary for assertion messages. */
export function formatAxe(violations: AxeViolation[]): string {
  if (violations.length === 0) return "(no violations)";
  return violations
    .map(
      (v) =>
        `[${v.impact ?? "n/a"}] ${v.id}: ${v.help} (${v.nodes} node(s)) — ${v.targets.join(", ")}`,
    )
    .join("\n");
}

interface RawViolation {
  id: string;
  impact: string | null;
  help: string;
  nodes: Array<{ target?: string[] }>;
}
