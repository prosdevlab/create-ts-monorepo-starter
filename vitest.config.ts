import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    restoreMocks: true,
    include: ['packages/**/*.{test,spec}.ts'],
    // dist/ holds the bundled template with its own tests; build/ is tsc output.
    exclude: ['**/node_modules/**', '**/dist/**', '**/build/**'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json', 'html'],
      exclude: ['**/node_modules/**', '**/dist/**', '**/build/**', '**/*.d.ts', '**/test/**'],
    },
  },
});
