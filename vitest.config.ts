import { defineConfig } from 'vitest/config';
import { resolve } from 'path';

export default defineConfig({
  test: {
    // Node is the fast default for the pure-lib suite; UI tests opt into a DOM with a
    // per-file `// @vitest-environment jsdom` docblock (the first-class UI harness).
    environment: 'node',
    setupFiles: ['./tests/setup-dom.ts'],
  },
  resolve: {
    alias: {
      '@': resolve(__dirname, '.'),
    },
  },
});
