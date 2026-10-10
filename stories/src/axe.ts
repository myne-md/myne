// axe-core against the rendered story (myne-md/myne#845).
//
// The research was unambiguous here: Storybook's Accessibility panel is axe-core
// with the results split into **Violations / Passes / Incomplete**, and the split
// is the point. axe finds only about 57% of WCAG issues, so a panel that shows
// only failures overstates its own coverage; `incomplete` is axe saying "I cannot
// tell, a human must look", and hiding it would make the panel a worse reviewer
// than no panel.
//
// `axe-core` is already a dependency of this repository, so the catalogue adds no
// new package. It runs in the browser the catalogue already is, against the story
// frame, on the theme that is active.
//
// The suites in `tests/a11y/` and the axe lane in E2E remain the GATE. This module
// exists so a reviewer can see the facts for the component in front of them, and
// the tab says so.

import * as axeModule from "axe-core";

/**
 * axe-core ships CommonJS (`main: axe.js`, no `exports` map and no `default`
 * key), so the runner is either the namespace itself or its interop `default`.
 *
 * The first version imported the default directly and it was `undefined` in the
 * Vite/ESM graph: every `axe.run` call threw a TypeError, the promise rejected,
 * and because nothing caught it the panel sat on "running axe" forever with no
 * error anywhere. Hence both the tolerant resolution here and the `.catch` at the
 * call site.
 */
interface AxeApi {
  run(context: Element, options?: Record<string, unknown>): Promise<axeModule.AxeResults>;
  version: string;
}

const axe = ((axeModule as unknown as { default?: AxeApi }).default ??
  (axeModule as unknown as AxeApi)) as AxeApi;

/** True when the runner resolved, so the panel can say so instead of hanging. */
export const axeAvailable = typeof axe?.run === "function";

/** One axe rule's outcome, flattened to what the panel renders. */
export interface AxeRule {
  /** The axe rule id, e.g. `color-contrast`. */
  id: string;
  /** axe's own one-line description of the rule. */
  help: string;
  /** The WCAG tags the rule carries, e.g. `wcag2aa`, `best-practice`. */
  tags: string[];
  /** How many elements in the subtree the rule matched. */
  nodes: number;
  /** axe's impact rating, when it gives one: minor / moderate / serious / critical. */
  impact: string | null;
}

/** axe's three outcomes, which are also the panel's three sub-tabs. */
export interface AxeReport {
  violations: AxeRule[];
  passes: AxeRule[];
  incomplete: AxeRule[];
  /** Rules axe did not run at all (inapplicable), counted but not listed. */
  inapplicable: number;
  /** The axe-core version that produced this report. */
  version: string;
}

/**
 * axe-core keeps one global audit and is not built for two `run()` calls at
 * once, so the calls are serialized through this chain.
 *
 * This is not hypothetical: React 19's StrictMode invokes the effect twice, so
 * two runs were in flight at once, and the panel hung on "running axe" forever
 * with no error and no rejection either. A hang, not a failure, which is the
 * worst shape because nothing reports it.
 */
let queue: Promise<unknown> = Promise.resolve();

function serialized<T>(task: () => Promise<T>): Promise<T> {
  const next = queue.then(task, task);
  queue = next.then(
    () => undefined,
    () => undefined,
  );
  return next;
}

/**
 * Run axe against `root` and bucket the results.
 *
 * `resultTypes` is narrowed deliberately: `inapplicable` is counted but not
 * listed, because a rule that did not apply is not a finding and filling the panel
 * with it would bury the three buckets that are.
 */
export async function runAxe(root: Element): Promise<AxeReport> {
  const results = await serialized(() =>
    axe.run(root, {
      resultTypes: ["violations", "passes", "incomplete", "inapplicable"],
    }),
  );

  const toRules = (list: readonly axeModule.Result[]): AxeRule[] =>
    list.map((result) => ({
      id: result.id,
      help: result.help,
      tags: [...result.tags],
      nodes: result.nodes.length,
      impact: result.impact ?? null,
    }));

  return {
    violations: toRules(results.violations),
    passes: toRules(results.passes),
    incomplete: toRules(results.incomplete),
    inapplicable: results.inapplicable.length,
    version: axe.version,
  };
}
