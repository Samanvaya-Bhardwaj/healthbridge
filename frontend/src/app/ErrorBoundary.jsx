import { Component } from 'react';
import { Button } from '../components/ui/Button.jsx';

/** Last-resort boundary: keeps a rendering failure from blanking the whole application. */
export class ErrorBoundary extends Component {
  state = { error: null };

  static getDerivedStateFromError(error) {
    return { error };
  }

  componentDidCatch(error, info) {
    // Error tracking (PHI-scrubbed) is wired in the observability milestone.
    console.error('Unhandled UI error', error, info?.componentStack);
  }

  render() {
    if (!this.state.error) return this.props.children;
    return <ErrorFallback onRetry={() => window.location.reload()} />;
  }
}

export function ErrorFallback({ title = 'Something went wrong', onRetry }) {
  return (
    <div
      role="alert"
      className="mx-auto flex min-h-[60vh] max-w-md flex-col justify-center px-6 py-16 text-center"
    >
      <h1 className="text-xl font-semibold text-text">{title}</h1>
      <p className="mt-3 text-text-muted">
        An unexpected error occurred. Your information is safe. Please try again.
      </p>
      {onRetry && (
        <div className="mt-8">
          <Button onClick={onRetry}>Try again</Button>
        </div>
      )}
    </div>
  );
}
