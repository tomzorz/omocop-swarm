import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts'],
    // Tests open real SQLite files and real JSONL archives in temp directories,
    // so they must not share a working directory.
    pool: 'forks',
  },
});
