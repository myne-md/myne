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
// Bar: WCAG level **2.2** AA (myne-md/myne#728, task 17; raised from 2.1,
// which is what `myne-agents/docs/decisions/ui/0263` gated and what `PRODUCT.md` had
// already been promising past). The tag set is the whole of the difference:
// adding `wcag22aa` turns on the 2.2 rules axe HAS, which in practice means
// `target-size` (SC 2.5.8). The other five 2.2 additions have no axe rule at
// all and are manual-checklist items instead (2.5.7 dragging, 2.4.11 focus
// obscured, 3.3.8 accessible authentication, 3.3.7 redundant entry, 3.2.6
// consistent help) - tasks 12 to 15 did those and each records its audit.

import axe, { type RunOptions, type AxeResults } from "axe-core";

/** WCAG 2.2 A + AA tag set: the single source of rule scope for both tiers. */
export const WCAG_AA_TAGS = [
  "wcag2a",
  "wcag2aa",
  "wcag21a",
  "wcag21aa",
  "wcag22aa",
] as const;

/**
 * Rules that need real LAYOUT and so cannot run in jsdom. Disabled explicitly
 * rather than left to axe's own detection: an incomplete result that quietly
 * becomes a pass is indistinguishable from a rule that ran.
 *
 * `target-size` joins `color-contrast` here with the 2.2 tag set. Both measure
 * boxes on screen, and jsdom reports every box as zero by zero, so in jsdom
 * the rule can only be noise in one direction or the other. The real
 * measurement is `e2e/a11y-axe.e2e.ts`, which runs the same tag set against
 * the live WebView.
 */
export const LAYOUT_ONLY_RULES = ["color-contrast", "target-size"] as const;

/**
 * Base options shared by both tiers: run only the WCAG 2.2 AA rule set.
 *
 * `wcag22a` is deliberately absent. The two level-A criteria 2.2 adds have no
 * axe rule at all, so the tag would widen the declared scope without widening
 * what runs, and a tag list that claims more than it checks is the drift this
 * file exists to prevent.
 */
export const baseAxeOptions: RunOptions = {
  runOnly: { type: "tag", values: [...WCAG_AA_TAGS] },
};

/**
 * Run axe against a DOM subtree in jsdom.
 *
 * The layout-dependent rules are off here and verified only in the E2E tier.
 * `contrast` re-enables `color-contrast` for the one spec that feeds axe a
 * fixture with explicit colours; it does NOT re-enable `target-size`, which
 * has no such fixture and no meaning without layout.
 */
export async function runAxe(
  container: Element,
  opts: { contrast?: boolean } = {},
): Promise<AxeResults> {
  const disabled: Record<string, { enabled: false }> = {};
  for (const rule of LAYOUT_ONLY_RULES) {
    if (rule === "color-contrast" && opts.contrast === true) continue;
    disabled[rule] = { enabled: false };
  }
  return axe.run(container, { ...baseAxeOptions, rules: disabled });
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
