// App-level error boundary. A render/runtime throw in React unmounts the WHOLE
// tree by default — on mobile that shows as a fully black screen with no clue
// what happened (see the "editor goes blank" report). This catches the throw and
// renders the actual error + stack on screen, so a crash is self-diagnosing
// instead of a silent void. If the screen is still blank with this mounted, the
// fault is NATIVE (no JS error fired), which is itself the diagnostic.

import { Component, type ErrorInfo, type ReactNode } from "react";

interface Props {
  children: ReactNode;
}
interface State {
  error: Error | null;
  info: string | null;
}

export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null, info: null };

  static getDerivedStateFromError(error: Error): Partial<State> {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    // Also log so it shows in Safari Web Inspector / the device console.
    console.error("[myne] render crash:", error, info.componentStack);
    this.setState({ info: info.componentStack ?? null });
  }

  render(): ReactNode {
    const { error, info } = this.state;
    if (!error) return this.props.children;
    return (
      <div
        style={{
          position: "fixed",
          inset: 0,
          zIndex: 9999,
          background: "var(--bg-1)",
          color: "var(--fg-1)",
          padding: "calc(env(safe-area-inset-top, 0px) + 24px) 18px 24px",
          overflowY: "auto",
          WebkitOverflowScrolling: "touch",
        }}
      >
        <div style={{ fontSize: 19, fontWeight: 700, fontFamily: "var(--font-sans)", marginBottom: 10 }}>
          Something crashed
        </div>
        <div
          style={{
            color: "var(--danger)",
            fontFamily: "var(--font-mono)",
            fontSize: 13,
            lineHeight: 1.5,
            whiteSpace: "pre-wrap",
            wordBreak: "break-word",
            marginBottom: 14,
          }}
        >
          {error.name}: {error.message}
        </div>
        {error.stack && (
          <pre
            style={{
              fontFamily: "var(--font-mono)",
              fontSize: 11,
              lineHeight: 1.45,
              color: "var(--fg-3)",
              whiteSpace: "pre-wrap",
              wordBreak: "break-word",
              margin: 0,
            }}
          >
            {error.stack}
          </pre>
        )}
        {info && (
          <pre
            style={{
              fontFamily: "var(--font-mono)",
              fontSize: 11,
              lineHeight: 1.45,
              color: "var(--fg-3)",
              whiteSpace: "pre-wrap",
              wordBreak: "break-word",
              marginTop: 14,
            }}
          >
            {info}
          </pre>
        )}
        <button
          onClick={() => this.setState({ error: null, info: null })}
          style={{
            marginTop: 20,
            height: 46,
            padding: "0 20px",
            border: "1px solid var(--line-2)",
            borderRadius: 10,
            background: "transparent",
            color: "var(--fg-1)",
            fontFamily: "var(--font-sans)",
            fontSize: 15,
            fontWeight: 600,
          }}
        >
          Try again
        </button>
      </div>
    );
  }
}
