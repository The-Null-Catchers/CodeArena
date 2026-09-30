import { defineConfig } from "vitest/config";
export default defineConfig({
  test: {
    include: ["tests/redis/**/*.test.ts"],
    env: { REDIS_URL: process.env.TEST_REDIS_URL || "redis://localhost:6380" },
    testTimeout: 15000,
    hookTimeout: 15000,
    fileParallelism: false,
  },
});
