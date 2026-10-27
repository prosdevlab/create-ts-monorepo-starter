import { defineConfig } from 'vitest/config';

// The generated-project tests (`pnpm test:e2e`): slow and online, so `pnpm test` leaves them out.
export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    restoreMocks: true,
    include: ['packages/cli/test/e2e/**/*.test.ts'],
  },
});
