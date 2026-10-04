import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/long/**/*.long.test.ts'],
    testTimeout: 900_000,
    hookTimeout: 60_000,
  },
});
