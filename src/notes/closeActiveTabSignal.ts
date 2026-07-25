// Cross-provider seam for the vim `:q` / `:wq` / `:x` ex commands
// (vim-keyboard-mode, MYND-313).
//
// The ex-command table lives inside the shared editor package, in module scope,
// with no route into the workspace React context that owns the pane tree. Rather
// than thread a callback through every layer, the host emits this window event
// and the editor shell — which already owns tab closing for `Mod-w` — listens.
//
// Deliberately a bare signal with no payload: "close whatever is focused", the
// same thing the close-tab chord means. The shell decides what that is.

export const CLOSE_ACTIVE_TAB_EVENT = "myne-close-active-tab";
