// `FileSystemSyncAccessHandle` — the OPFS write API this client is built on.
//
// # Why this declaration is needed at all
//
// TypeScript ships `FileSystemFileHandle` in `lib.dom`, but **not**
// `createSyncAccessHandle`, because the method exists only in a dedicated
// Worker — it is declared in `lib.webworker`, and this project compiles the page
// and the Worker under one `lib.dom` configuration (the Worker is a module in
// the same `web/` tree, not a separately-configured project).
//
// So this is not a polyfill or a workaround for a missing browser feature. It is
// the type for a method that exists in exactly the context this file's consumer
// runs in, and nowhere else — which is itself the reason the whole storage layer
// has to live in a Worker (`decisions.md` 2026-07-26: Safari implements no
// `createWritable`, so there is no main-thread alternative).
//
// Kept minimal on purpose: only the six members `opfs.ts` calls. A fuller
// transcription of the spec would be more surface to drift.

interface FileSystemSyncAccessHandle {
  /** Bytes currently in the file. */
  getSize(): number;
  /**
   * Read into `buffer` starting at `options.at`. Returns bytes actually read,
   * which is less than `buffer.length` at end-of-file.
   *
   * `ArrayBufferView`, not `BufferSource`: the spec's parameter type is
   * `AllowSharedBufferSource`, which admits a `SharedArrayBuffer`-backed view.
   * `BufferSource` excludes those, so it would reject a plain `Uint8Array`
   * whose buffer type TypeScript has widened to `ArrayBufferLike` — which is
   * every `Uint8Array` arriving from wasm-bindgen.
   */
  read(buffer: ArrayBufferView, options?: { at?: number }): number;
  /** Write `buffer` at `options.at`. Returns bytes written. */
  write(buffer: ArrayBufferView, options?: { at?: number }): number;
  /** Resize. Called with `0` before every overwrite — see `opfs.ts`. */
  truncate(newSize: number): void;
  /**
   * Flush to storage. Explicitly **not** a crash-atomicity guarantee: that gap
   * is what task 18's double-buffered `.a`/`.b` scheme exists to close.
   */
  flush(): void;
  /** Release the file's exclusive lock. Always in a `finally`. */
  close(): void;
}

interface FileSystemFileHandle {
  /**
   * Acquire an **exclusive** lock on the file and return a synchronous handle.
   *
   * Dedicated-Worker-only in every browser. A second acquisition while one is
   * open rejects with `NoModificationAllowedError`, which is why `opfs.ts`
   * acquires per operation and never caches.
   */
  createSyncAccessHandle(): Promise<FileSystemSyncAccessHandle>;
}

interface FileSystemDirectoryHandle {
  /** Async iterator over `[name, handle]`. Present in browsers, absent from `lib.dom`. */
  entries(): AsyncIterableIterator<[string, FileSystemHandle]>;
}
