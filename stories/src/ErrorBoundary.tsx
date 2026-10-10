// One story that throws must not take the catalogue down with it
// (myne-md/myne#843).
//
// Before this there was no boundary anywhere in the shell, so a single
// render-time error unmounted every story at once: a missing compile-time
// global in `AboutPanel` (`__UPDATE_CHANNEL__`) blanked the whole catalogue the
// first time that panel was opened, and from then on every OTHER story was
// unreachable too, because there was no stage left to render into. The failure
// mode is worse than the bug: the catalogue exists so one surface is reviewable
// at a time, and one bad surface made the other 177 unopenable.
//
// The app carries `RootErrorBoundary` for the same reason; the catalogue mounts
// stories the app would never mount together, so it needs the boundary at the
// STORY frame rather than once at the root. A class, because React boundaries
// have no hook form, and keyed by story id at the call site, so selecting a
// different story mounts a fresh boundary and the error does not stick.

import { Component, type ErrorInfo, type ReactNode } from "react";

interface StoryErrorBoundaryProps {
  /** The story id, so the message says which surface failed. */
  id: string;
  children: ReactNode;
}

interface StoryErrorBoundaryState {
  error: Error | null;
}

const WRAP_STYLE = {
  margin: "var(--space-4)",
  padding: "var(--space-4)",
  border: "1px solid var(--line-2)",
  borderLeft: "3px solid var(--danger)",
  borderRadius: "var(--radius-2)",
  background: "var(--bg-2)",
  color: "var(--fg-1)",
  fontFamily: "var(--font-sans)",
  fontSize: "var(--text-sm)",
} as const;

const TITLE_STYLE = {
  fontWeight: "var(--weight-semibold)",
  marginBottom: "var(--space-2)",
} as const;

const DETAIL_STYLE = {
  fontFamily: "var(--font-mono)",
  fontSize: "var(--text-xs)",
  color: "var(--fg-3)",
  whiteSpace: "pre-wrap",
} as const;

export class StoryErrorBoundary extends Component<
  StoryErrorBoundaryProps,
  StoryErrorBoundaryState
> {
  state: StoryErrorBoundaryState = { error: null };

  static getDerivedStateFromError(error: Error): StoryErrorBoundaryState {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    // The catalogue is dev tooling; the console is where a maintainer looks and
    // the component stack is the part the rendered message cannot carry.
    console.error(`[stories] ${this.props.id} threw during render`, error, info.componentStack);
  }

  render(): ReactNode {
    const { error } = this.state;
    if (error === null) return this.props.children;
    return (
      <div data-testid="stories.error" style={WRAP_STYLE}>
        <div style={TITLE_STYLE}>This story failed to render: {this.props.id}</div>
        <div style={DETAIL_STYLE}>{error.message}</div>
      </div>
    );
  }
}
