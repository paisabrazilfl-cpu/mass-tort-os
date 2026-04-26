import { Component, type ErrorInfo, type ReactNode } from "react";
import { AlertTriangle, RotateCw } from "lucide-react";
import { Button } from "@/components/ui/button";

interface Props {
  children: ReactNode;
  /** Reset key — when it changes, the boundary clears its error state. */
  resetKey?: string;
}

interface State {
  error: Error | null;
}

export class RouteErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    // eslint-disable-next-line no-console
    console.error("RouteErrorBoundary caught an error:", error, info);
  }

  componentDidUpdate(prev: Props) {
    if (prev.resetKey !== this.props.resetKey && this.state.error) {
      this.setState({ error: null });
    }
  }

  private handleRetry = () => this.setState({ error: null });

  render() {
    const { error } = this.state;
    if (!error) return this.props.children;

    return (
      <div role="alert" className="mx-auto max-w-xl py-12">
        <div className="flex items-start gap-4 rounded-lg border border-destructive/40 bg-destructive/5 p-6">
          <AlertTriangle className="mt-0.5 h-6 w-6 flex-shrink-0 text-destructive" aria-hidden="true" />
          <div className="flex-1 space-y-3">
            <div>
              <h2 className="text-lg font-semibold">This page hit an error</h2>
              <p className="mt-1 text-sm text-muted-foreground">
                The rest of MTOS is still working. Try reloading this page or returning to the dashboard.
              </p>
            </div>
            <details className="text-xs">
              <summary className="cursor-pointer text-muted-foreground hover:text-foreground">
                Error details
              </summary>
              <pre className="mt-2 max-h-40 overflow-auto whitespace-pre-wrap rounded bg-muted p-2 font-mono text-[11px]">
                {error.message}
              </pre>
            </details>
            <div className="flex flex-wrap gap-2">
              <Button size="sm" variant="default" onClick={this.handleRetry}>
                <RotateCw className="mr-2 h-4 w-4" /> Retry
              </Button>
              <Button size="sm" variant="outline" asChild>
                <a href="./">Back to dashboard</a>
              </Button>
            </div>
          </div>
        </div>
      </div>
    );
  }
}
