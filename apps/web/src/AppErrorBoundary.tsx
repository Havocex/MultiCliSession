import { Component, type ErrorInfo, type ReactNode } from 'react';

export class AppErrorBoundary extends Component<
  { children: ReactNode },
  { error?: Error }
> {
  state: { error?: Error } = {};

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error('[Multi CLI Session] render failure', error, info.componentStack);
  }

  render() {
    if (!this.state.error) return this.props.children;
    return (
      <main className="fatal-error" role="alert">
        <div>
          <small>RECOVERY MODE</small>
          <h1>The interface could not finish rendering</h1>
          <p>Your projects and conversations remain stored on disk.</p>
          <pre>{this.state.error.message}</pre>
          <button type="button" onClick={() => window.location.reload()}>Reload application</button>
        </div>
      </main>
    );
  }
}
