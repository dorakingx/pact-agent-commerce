"use client";

import { Component, type ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { Callout } from "@/components/ui/callout";

interface Props {
  children: ReactNode;
  /** Forget the saved layout: a layout Studio cannot load is the likeliest reason it would not start. */
  onResetLayout: () => void;
}

interface State {
  error: Error | null;
  /** Bumped to remount the dashboard after a failure. */
  attempt: number;
}

/**
 * Keeps a failure inside the dashboard from taking the Operations page with it. AG Studio is a
 * large third-party editor fed with saved state from this browser; if it throws while rendering,
 * the visitor gets an explanation and two ways forward instead of a blank page.
 */
export class StudioErrorBoundary extends Component<Props, State> {
  state: State = { error: null, attempt: 0 };

  static getDerivedStateFromError(error: Error): Partial<State> {
    return { error };
  }

  private retry = (): void => {
    this.setState((state) => ({ error: null, attempt: state.attempt + 1 }));
  };

  private resetAndRetry = (): void => {
    this.props.onResetLayout();
    this.retry();
  };

  render(): ReactNode {
    if (this.state.error === null) return <div key={this.state.attempt}>{this.props.children}</div>;
    return (
      <Callout
        tone="danger"
        title="The dashboard editor could not start"
        data-testid="studio-editor-error"
        action={
          <div className="flex flex-wrap gap-2">
            <Button variant="secondary" size="sm" onClick={this.retry}>
              Try again
            </Button>
            <Button variant="secondary" size="sm" onClick={this.resetAndRetry}>
              Reset layout and retry
            </Button>
          </div>
        }
      >
        The rest of Operations is unaffected. If you customised this dashboard, resetting its saved layout usually fixes it.
        <span className="mt-1 block font-mono text-xs text-muted">{this.state.error.message.slice(0, 200)}</span>
      </Callout>
    );
  }
}
