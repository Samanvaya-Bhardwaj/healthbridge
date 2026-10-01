import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/**/*.test.js'],
    testTimeout: 15_000,
    // Integration suites share real databases; run files sequentially.
    fileParallelism: false,
  },
});
