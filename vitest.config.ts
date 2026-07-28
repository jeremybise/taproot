import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Tests import from `src` as `.js` (NodeNext style), so Vitest needs to resolve TS sources.
    include: ['packages/*/src/**/*.test.ts'],
    environment: 'node',
  },
});
