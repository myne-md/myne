// The three real Worker host bridges the wasm module resolves by exact
// namespace. Each is an IO seam, not a hook — and each is exactly the shape a
// hook would take, which is why they are named in ALLOWED_GLOBALS rather than
// inferred.
globalThis.__myneOpfs = 1;
globalThis.__myneSyncHttp = 1;
globalThis.__myneAttachmentUrl = 1;
