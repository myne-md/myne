// `useFilterCount` — the filter builder's live result count (Saved Views #4 /
// MYND-282, task 4). Evaluates a draft `FilterNode` against the same
// `RunViewContext` the saved-view render uses (`useRunViewContext`) and returns
// how many live notes match, so the builder can show "N notes" before the user
// commits. Read-only projection — it never persists; only the builder's explicit
// Save writes the view. `null` while the first evaluation is in flight.

import { useEffect, useState } from "react";
import type { FilterNode } from "../../lib/prefs";
import { useIndexNonce } from "../indexNonce";
import { useRunViewContext } from "./useRunViewContext";
import { evaluateFilter } from "../queryEngine";

export function useFilterCount(filter: FilterNode): number | null {
  const ctx = useRunViewContext();
  const indexNonce = useIndexNonce();
  const [count, setCount] = useState<number | null>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        // `evaluateFilter` never throws for the representable leaf set; a locked
        // vault / index hiccup surfaces as 0 rather than an exception.
        const ids = await evaluateFilter(filter, ctx.liveIds, ctx.resolvers);
        if (!cancelled) setCount(ids.length);
      } catch {
        if (!cancelled) setCount(null);
      }
    })();
    return () => {
      cancelled = true;
    };
    // `indexNonce` is a re-run trigger only (the current data is read via `ctx`).
  }, [filter, ctx, indexNonce]);

  return count;
}
