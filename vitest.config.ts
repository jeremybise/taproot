import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  test: {
    include: [
      'packages/*/src/**/*.test.ts',
      'packages/*/src/**/*.test.tsx',
      // `create-taproot` has no `src/` — it is one `index.mjs` plus template directories, because a
      // package invoked through `npx` on a machine that has installed nothing cannot have a build
      // step. Its test sits beside it, so the pattern has to reach a package root as well.
      'packages/*/*.test.ts',
    ],
    // Node by default — the core suites talk to a real database and never touch a DOM. Files that
    // render React opt in with a `@vitest-environment jsdom` docblock, which is per-file and
    // explicit (Vitest 4 removed `environmentMatchGlobs`).
    environment: 'node',
  },
});
