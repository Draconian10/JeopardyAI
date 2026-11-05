import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';
export default defineConfig({
  resolve: { alias: { '@': fileURLToPath(new URL('.', import.meta.url)) } },
  test: {
    include: ['tests/stress/**/*.stress.ts'],
    testTimeout: 180000,
    hookTimeout: 30000,
    fileParallelism: false,
  },
});
