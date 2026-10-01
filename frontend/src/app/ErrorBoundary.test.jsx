import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { ErrorBoundary } from './ErrorBoundary.jsx';

function Broken() {
  throw new Error('render failure');
}

describe('ErrorBoundary', () => {
  it('renders an accessible fallback instead of a blank screen', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    render(
      <ErrorBoundary>
        <Broken />
      </ErrorBoundary>,
    );
    expect(screen.getByRole('alert')).toHaveTextContent(/something went wrong/i);
    expect(screen.getByRole('button', { name: /try again/i })).toBeInTheDocument();
  });
});
