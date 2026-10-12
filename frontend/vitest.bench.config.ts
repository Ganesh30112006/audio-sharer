import { defineConfig } from 'vitest/config';

// Codec benchmark: `npm run bench:codec` (see bench/README.md).
export default defineConfig({
  test: {
    environment: 'node',
    include: ['bench/**/*.bench.test.ts'],
    testTimeout: 600_000,
    pool: 'forks',
    fileParallelism: false,
  },
});
