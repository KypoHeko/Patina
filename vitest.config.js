import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'jsdom',
    include: ['src/js/test/*.test.js'],
    globals: true,
    setupFiles: ['src/test/setup.js'],
  },
});
