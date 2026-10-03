import { Component } from 'react';
import { Button } from '../components/ui/Button.jsx';
import { reportClientError } from '../lib/errorReporting.js';
import { AlertTriangle, RotateCcw } from 'lucide-react';

/** Last-resort boundary: keeps a rendering failure from blanking the whole application. */
export class ErrorBoundary extends Component {
  state = { error: null };

  static getDerivedStateFromError(error) {
    return { error };
  }

  componentDidCatch(error, info) {
    // Only the error class and route leave the browser (lib/errorReporting.js).
    reportClientError('render_error', error);
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
      <span
        aria-hidden="true"
        className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-full bg-warning/10 text-warning"
      >
        <AlertTriangle className="h-6 w-6" />
      </span>
      <h1 className="text-xl font-semibold text-text">{title}</h1>
      <p className="mt-3 text-text-muted">
        An unexpected error occurred. Your information is safe. Please try again.
      </p>
      {onRetry && (
        <div className="mt-8">
          <Button icon={RotateCcw} onClick={onRetry}>
            Try again
          </Button>
        </div>
      )}
    </div>
  );
}
