// Shared axe-core ruleset for both accessibility test tiers (MYND-93).
//
// Two tiers consume this one config so they never drift:
//   - Vitest/jsdom (this dir) — fast structural + ARIA checks on every push.
//     jsdom has no layout/paint, so axe's `color-contrast` rule cannot run
//     there; `runAxe` disables it explicitly (deterministic, not relying on
//     axe's own auto-detection).
//   - E2E/tauri-driver (e2e/support/axe.ts) — real-render pass that DOES judge
//     contrast, importing `WCAG_AA_TAGS` so the rule scope matches.
//
// Bar: WCAG 2.1 level AA (the acceptance criterion in MYND-93).

import axe, { type RunOptions, type AxeResults } from "axe-core";

/** WCAG 2.1 A + AA tag set — the single source of rule scope for both tiers. */
export const WCAG_AA_TAGS = [
  "wcag2a",
  "wcag2aa",
  "wcag21a",
  "wcag21aa",
] as const;

/** Base options shared by both tiers: run only the WCAG 2.1 AA rule set. */
export const baseAxeOptions: RunOptions = {
  runOnly: { type: "tag", values: [...WCAG_AA_TAGS] },
};

/**
 * Run axe against a DOM subtree in jsdom.
 *
 * `contrast` defaults to false: jsdom cannot compute color contrast, so the
 * `color-contrast` rule is disabled here and verified only in the E2E tier.
 */
export async function runAxe(
  container: Element,
  opts: { contrast?: boolean } = {},
): Promise<AxeResults> {
  const options: RunOptions = {
    ...baseAxeOptions,
    rules: opts.contrast ? {} : { "color-contrast": { enabled: false } },
  };
  return axe.run(container, options);
}

/** Human-readable one-line-per-violation summary for test failure messages. */
export function formatViolations(results: AxeResults): string {
  if (results.violations.length === 0) return "(no violations)";
  return results.violations
    .map(
      (v) =>
        `• [${v.impact ?? "n/a"}] ${v.id}: ${v.help} — ${v.nodes.length} node(s)\n    ${v.nodes
          .map((n) => n.target.join(" "))
          .join("\n    ")}`,
    )
    .join("\n");
}
