// Web Worker entry. Bundlers (Vite) wire it up via:
//   new Worker(new URL("./main.ts", import.meta.url), { type: "module" })
//
// Message protocol:
//   In:  { kind: "parse"; id: string; bytes: Uint8Array }
//   In:  { kind: "cancel" }
//   Out: { kind: "result"; id: string; result: ParseResult }
//   Out: { kind: "cancelled" }

import { parse } from "../parse";
import type { ParseResult } from "../types";

type WorkerSelf = {
  addEventListener(
    type: "message",
    listener: (e: { data: unknown }) => void,
  ): void;
  postMessage(message: unknown): void;
  close(): void;
};

declare const self: WorkerSelf;

type IncomingMessage =
  | { kind: "parse"; id: string; bytes: Uint8Array }
  | { kind: "cancel" };

type OutgoingMessage =
  | { kind: "result"; id: string; result: ParseResult }
  | { kind: "cancelled" };

self.addEventListener("message", (e: { data: unknown }) => {
  const msg = e.data as IncomingMessage;
  if (msg.kind === "cancel") {
    const reply: OutgoingMessage = { kind: "cancelled" };
    self.postMessage(reply);
    self.close();
    return;
  }
  if (msg.kind === "parse") {
    const result = parse(msg.bytes);
    const reply: OutgoingMessage = { kind: "result", id: msg.id, result };
    self.postMessage(reply);
  }
});
