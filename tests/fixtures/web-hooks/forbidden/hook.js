// Two shapes the guard's original pattern could not see: the wrong host object
// (this project installs its bridges on `globalThis`), and a SUFFIXED name
// reached by bracket access, where a word-boundary anchor also failed.
//
// This file deliberately carries NOTHING matching the guard's four other
// patterns, so a spec asserting on exit status alone cannot pass for the wrong
// reason. Keep it that way — including in these comments.
globalThis.__myneDebug = { dumpKeys };
window["__myneOpfsDebug"] = {};
