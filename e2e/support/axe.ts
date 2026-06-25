// Real-render axe-core pass for the E2E harness (MYND-93, task 7).
//
// The Vitest tier (tests/a11y/) runs axe in jsdom — fast, but jsdom can't
// compute layout/paint, so its `color-contrast` rule is disabled there. THIS
// tier injects the axe-core source into the real WebKit WebView and runs the
// FULL WCAG 2.1 AA rule set INCLUDING contrast — the authoritative check.
//
// Rule scope is imported from the shared config so the two tiers never drift.

import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { WCAG_AA_TAGS } from "../../tests/a11y/axe-config";
import type { Session } from "./webdriver";

const require = createRequire(import.meta.url);
/** The axe-core UMD source, read once; injected into the page per run. */
const AXE_SOURCE = readFileSync(require.resolve("axe-core"), "utf8");

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
 * Inject axe into the page and run the WCAG 2.1 AA rule set (contrast
 * included) against `contextSelector` (default: the whole document).
 * Returns the violations — empty array means the screen passed.
 */
export async function runAxeInPage(
  session: Session,
  contextSelector?: string,
): Promise<AxeViolation[]> {
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
