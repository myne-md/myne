// A local fixture artefact origin for the AI model-download E2E lane
// (myne-md/myne#805 task 8).
//
// **This proves the plumbing, not the network.** It serves small, deterministic
// bytes over plain HTTP on a loopback port, so the download command's staging,
// verification against the compiled-in digest, atomic register, cancel and
// mismatch-refusal paths can all be driven without touching the real network or
// shipping a 471 MB model into the repo. The scenario asserts the bytes it
// serves, the same honesty bound `support/fake-ollama.ts` states about itself.
//
// The app is pointed here by `MYNE_E2E_MODEL_ORIGIN=127.0.0.1:<port>`, which is
// read ONLY by the `local-inference-stub` build (`src-tauri/src/plugins/
// local_inference/download.rs::download_origin`). A production build does not
// read the variable at all, so this cannot redirect a shipped binary.
//
// The happy-path bytes match `FIXTURE_ARTIFACTS` in that same Rust file; the
// mismatch arm serves deliberately-corrupted bytes and asserts the host names
// the failure and registers nothing.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo, Socket } from "node:net";

/** The exact bytes a correct download serves. Must match the digest compiled
 *  into `FIXTURE_ARTIFACTS` in `download.rs`. */
export const FIXTURE_EMBEDDING_BYTES = "myne-e2e-fixture-embedding-model-bytes";

/** The path the fixture artefact lives at, mirroring `FIXTURE_ARTIFACTS`. */
const FIXTURE_PATH = "/fixture/embedding/model.safetensors";

export interface FakeModelOrigin {
  /** `127.0.0.1:<port>`: what goes into `MYNE_E2E_MODEL_ORIGIN`. */
  origin: string;
  /** Number of requests served (any path). */
  requests(): number;
  /** Once set, every request answers `corruptBytes` instead of the good bytes. */
  serveCorrupt(corrupt: string): void;
  /** Stop listening and drop every open socket. */
  close(): Promise<void>;
}

/**
 * Start the fixture origin on an ephemeral loopback port. Binds `127.0.0.1`
 * explicitly: the download transport consults the Tor routing gate by host, and
 * loopback is the direct-gate exemption, so a fixture reachable off-device would
 * be testing a configuration the product never uses.
 */
export async function startFakeModelOrigin(): Promise<FakeModelOrigin> {
  let served = 0;
  let corrupt: string | null = null;
  const sockets = new Set<Socket>();

  const server: Server = createServer((req: IncomingMessage, res: ServerResponse) => {
    req.resume();
    req.on("end", () => {
      served += 1;
      const path = req.url ?? "";
      if (path !== FIXTURE_PATH) {
        res.writeHead(404, { "content-type": "text/plain" });
        res.end("not found");
        return;
      }
      const body = corrupt ?? FIXTURE_EMBEDDING_BYTES;
      res.writeHead(200, {
        "content-type": "application/octet-stream",
        "content-length": Buffer.byteLength(body),
      });
      res.end(body);
    });
  });

  server.on("connection", (s: Socket) => {
    sockets.add(s);
    s.on("close", () => sockets.delete(s));
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;

  return {
    origin: `127.0.0.1:${port}`,
    requests: () => served,
    serveCorrupt: (c: string) => {
      corrupt = c;
    },
    close: () =>
      new Promise<void>((resolve) => {
        for (const s of sockets) s.destroy();
        server.close(() => resolve());
      }),
  };
}
