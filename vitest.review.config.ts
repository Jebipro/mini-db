import { defineConfig } from 'vitest/config';

/** Independent post-implementation review tests (CLAUDE_INDEPENDENT_REVIEW.md). Not part of `npm run check`. */
export default defineConfig({
  test: {
    include: ['tests/review/**/*.review.test.ts'],
    testTimeout: 600_000,
    hookTimeout: 60_000,
  },
});
