// Client-core re-export of the `live` plugin's error enum (epic live-collab,
// `collab-editor-bridge` task 3). The type itself lives in `@myne/client-core`
// so desktop, web and mobile share one mirror; `tests/types/rustEnumParity.test.ts`
// holds it to the Rust enum.
export * from "@myne/client-core/types/live-session-error";
