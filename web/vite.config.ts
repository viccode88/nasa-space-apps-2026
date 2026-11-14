import { resolve } from 'node:path';
import { defineConfig } from 'vitest/config';

// Relative base so the build works at any path (GitHub Pages project site).
export default defineConfig({
  base: './',
  // The methods page imports ../docs/METHODS.md and its figures.
  server: { fs: { allow: ['..'] } },
  build: {
    target: 'es2022',
    rollupOptions: {
      input: {
        main: resolve(import.meta.dirname, 'index.html'),
        methods: resolve(import.meta.dirname, 'methods.html'),
      },
    },
  },
  test: { include: ['src/**/*.test.ts'] },
});
