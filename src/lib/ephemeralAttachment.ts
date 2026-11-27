// The composer's own lane: a file that is read and sent, never stored.
//
// A photograph of a receipt is a question about a receipt, not a note in the
// vault: importing it would leave a permanent blob, a catalog row, a text-cache
// row and a sync entry for a picture the person wanted to ask about once. This
// module reads such a file through `attachment_extract_ephemeral` — the same
// extractor the import path runs, with no vault, no key and no catalog — and
// returns the text the agent already knows how to carry
// (`myne_core::plugins::agent::prompt::Document`).
//
// **What leaves the device is the reading, not the file.** The agent's request
// carries `{ name, text }` and nothing else, exactly as an imported document's
// text already does, so the protocol, the prompt budget and the untrusted span
// that carries a document are unchanged.

import { invoke } from "../platform/core";

/** What the host answers: the reading, or why there is none. */
export interface EphemeralReading {
  /** The display name the composer shows beside the chip. */
  name: string;
  /** Empty unless `status` is `ok`. */
  text: string;
  /** `ok` | `empty` | `unsupported` | `failed`. */
  status: "ok" | "empty" | "unsupported" | "failed";
  /** Characters before the extractor's truncation. */
  char_count: number;
  truncated: boolean;
}

/** The hosts cap a payload at the attachment cap (64 MiB); refuse earlier. */
const MAX_DEVICE_BYTES = 64 * 1024 * 1024;

/**
 * Read one picked, pasted or photographed file without making an attachment.
 *
 * Rejects only when the file cannot be read at all; a file that reads and yields
 * no text resolves with `status` set, because "this page was blank" and "this
 * format is not one I can read" are sentences the composer owes the user, not
 * exceptions.
 */
export async function readEphemeralFile(file: File): Promise<EphemeralReading> {
  if (file.size > MAX_DEVICE_BYTES) {
    return { name: file.name, text: "", status: "failed", char_count: 0, truncated: false };
  }
  // The same byte-array shape `attachment_import` takes, so one marshalling
  // contract serves both lanes and no base64 step can disagree about padding.
  const bytes = Array.from(new Uint8Array(await file.arrayBuffer()));
  return await invoke<EphemeralReading>("plugin:attachments|attachment_extract_ephemeral", {
    source: {
      kind: "bytes",
      bytes,
      filename: file.name === "" ? null : file.name,
    },
  });
}
