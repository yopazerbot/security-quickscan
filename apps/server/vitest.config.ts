import { defineConfig } from 'vitest/config';

export default defineConfig({
  // Integration tests share one database and run migrations: run files one at a time.
  test: { fileParallelism: false },
});
