// React binding for the shared date/time display settings (myne#279).
//
// Split from `datetimeFormat.ts` so that module stays importable from non-React
// call sites (and from a plain Vitest run) without pulling React in.

import { useSyncExternalStore } from "react";
import {
  dateTimeDisplay,
  subscribeDateTimeDisplay,
  type DateTimeDisplay,
} from "./datetimeFormat";

/** Re-renders the caller when the user changes a date/time display setting. */
export function useDateTimeDisplay(): DateTimeDisplay {
  return useSyncExternalStore(subscribeDateTimeDisplay, dateTimeDisplay, dateTimeDisplay);
}
