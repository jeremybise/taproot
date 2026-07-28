import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  test: {
    include: ['packages/*/src/**/*.test.ts', 'packages/*/src/**/*.test.tsx'],
    // Node by default — the core suites talk to a real database and never touch a DOM. Files that
    // render React opt in with a `@vitest-environment jsdom` docblock, which is per-file and
    // explicit (Vitest 4 removed `environmentMatchGlobs`).
    environment: 'node',
  },
});
