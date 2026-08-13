// Mobile shim into the shared `@myne/dialect` conflict-copy orchestrators
// (buildConflictCopyContent / clearConflictMarkers / createConflictCopy /
// applyConflictVersion / undoConflictVersion + the `ConflictCopyHost` seam).
// Mobile injects its own note/prefs IO into the host (src/lib/conflictCopy.ts);
// the orchestrator logic is consumed as source, never re-implemented (SYNC-11).
export * from "@myne/dialect/conflictCopy";
