// In-process AsyncIterable wrapper around `parse()`. The production app may
// run this same logic off-main-thread via `./main.ts` over `postMessage`;
// the AsyncIterable contract is identical in both modes. Consumer `break`
// runs the generator's normal cleanup, so no further items are pulled.

import { parse } from "../parse";
import type { ParseResult } from "../types";

export type ParseStreamItem = { id: string; bytes: Uint8Array };
export type ParseStreamResult = { id: string; result: ParseResult };

export async function* parseStream(
  items: Iterable<ParseStreamItem>,
): AsyncIterable<ParseStreamResult> {
  for (const item of items) {
    // Yield to the event loop so a consumer `break` is observed before we
    // pull the next item.
    await Promise.resolve();
    yield { id: item.id, result: parse(item.bytes) };
  }
}
