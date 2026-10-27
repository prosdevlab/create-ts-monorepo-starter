import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    restoreMocks: true,
    include: ['packages/**/*.{test,spec}.ts'],
    // dist/ holds the bundled template with its own tests; build/ is tsc output.
    // test/e2e generates real projects (slow, online): `pnpm test:e2e` runs it.
    exclude: ['**/node_modules/**', '**/dist/**', '**/build/**', 'packages/cli/test/e2e/**'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json', 'html'],
      exclude: ['**/node_modules/**', '**/dist/**', '**/build/**', '**/*.d.ts', '**/test/**'],
    },
  },
});
