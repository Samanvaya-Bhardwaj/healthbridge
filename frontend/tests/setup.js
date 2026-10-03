import '@testing-library/jest-dom/vitest';
import { afterEach, vi } from 'vitest';
import { cleanup, configure } from '@testing-library/react';

// Whole-app renders (router, auth bootstrap, queries) can take over a second when the full
// suite runs in parallel on a busy machine; the 1 s default made such tests flaky.
configure({ asyncUtilTimeout: 5000 });

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});
