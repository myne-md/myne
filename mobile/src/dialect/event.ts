// Shim: the shared dialect, reached the way every other mobile shim reaches it.
// `myne-md/myne#1037` needs the event record's instant formatter here, and the
// alternative to this one line would be a second copy of it in the mobile tree.
export * from "@myne/dialect/event";
