// A fake Ollama for the desktop E2E lane (ai-ollama-local task 9).
//
// **This proves the plumbing, not the network.** The same honesty bound the Tor
// fixture states about itself: a canned local responder shows that Myne builds
// the right request, sends it to the address the user named, and renders what
// comes back. It says nothing about a real Ollama's behaviour, its wire format
// drifting, or anything reachable off this machine.
//
// It counts **accepts**, not requests, and that is the point. The scenario's
// zero-arm has to show that nothing connected — not that no request parsed —
// because "Myne opened a socket and then failed" and "Myne opened no socket"
// are the same from the response's side and completely different from the
// invariant's side (`decisions.md` 2026-08-09: no byte leaves the device unless
// the user has named a provider).
//
// Prior art for the shape, including the control arm that makes a zero mean
// something: `core/src/plugins/sync/no_bypass.rs` +
// `rustls_transport.rs::proxy_down_fails_closed_with_no_direct_connection_attempt`.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo, Socket } from "node:net";

export interface FakeOllama {
  /** The ephemeral loopback port it is listening on. */
  port: number;
  /** `http://127.0.0.1:<port>` — what goes into `ai-endpoint.json`. */
  url: string;
  /** TCP connections accepted since start. The zero-arm's assertion. */
  accepts(): number;
  /** Request paths seen, in order. Lets a scenario assert WHICH endpoint. */
  paths(): string[];
  /** Stop listening and drop every open socket. */
  close(): Promise<void>;
}

/** What the fixture answers, per endpoint. Deterministic — a scenario asserts
 *  on these exact strings, so they must not vary run to run. */
export const FAKE_COMPLETION = "the fake runtime answered";
export const FAKE_MODEL_NAME = "fake-model";
export const FAKE_MODEL_DIGEST = "sha256:0000feed";

/**
 * Start a fake Ollama on an ephemeral loopback port.
 *
 * Binds `127.0.0.1` explicitly rather than a wildcard: the app's validator only
 * admits the three literal loopback names, so a fixture reachable from
 * elsewhere would be testing a configuration the product refuses.
 */
export async function startFakeOllama(): Promise<FakeOllama> {
  let accepted = 0;
  const seen: string[] = [];
  const sockets = new Set<Socket>();

  const server: Server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const path = req.url ?? "";
    seen.push(path);
    // Drain the body — a request whose body is never read can leave the client
    // blocked on backpressure and turn a wiring bug into a timeout.
    req.resume();
    req.on("end", () => {
      const body =
        path.startsWith("/api/tags")
          ? JSON.stringify({
              models: [
                {
                  name: `${FAKE_MODEL_NAME}:latest`,
                  model: `${FAKE_MODEL_NAME}:latest`,
                  digest: FAKE_MODEL_DIGEST,
                },
              ],
            })
          : path.startsWith("/api/chat")
            ? JSON.stringify({ message: { content: FAKE_COMPLETION } })
            : JSON.stringify({ response: FAKE_COMPLETION });
      res.writeHead(200, {
        "content-type": "application/json",
        "content-length": String(Buffer.byteLength(body)),
        connection: "close",
      });
      res.end(body);
    });
  });

  server.on("connection", (socket: Socket) => {
    accepted += 1;
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;

  return {
    port,
    url: `http://127.0.0.1:${port}`,
    accepts: () => accepted,
    paths: () => [...seen],
    close: () =>
      new Promise<void>((resolve) => {
        for (const s of sockets) s.destroy();
        server.close(() => resolve());
      }),
  };
}

/** The `ai-endpoint.json` body pointing the app at `fake`, with a model named.
 *  Both fields are required for the arm to be a backend at all (SYNC-24). */
export function endpointConfigJson(fake: FakeOllama, model = FAKE_MODEL_NAME): string {
  return JSON.stringify({ url: fake.url, model });
}
