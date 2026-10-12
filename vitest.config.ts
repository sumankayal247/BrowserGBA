import { defineConfig } from 'vitest/config';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  resolve: {
    alias: { '@': path.join(root, 'src') },
  },
  test: {
    root,
    globals: true,
    environment: 'happy-dom',
    setupFiles: [path.join(root, 'tests', 'setup.ts')],
    include: ['tests/**/*.test.ts', 'src/**/*.test.ts'],
    exclude: ['tests/browser/**', 'node_modules/**', 'dist/**'],
    restoreMocks: true,
    coverage: {
      provider: 'v8',
      reportsDirectory: 'coverage',
      include: ['src/**/*.ts'],
      exclude: ['src/**/*.test.ts', 'src/**/*.d.ts'],
    },
  },
});
