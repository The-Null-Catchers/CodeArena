import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/control/**/*.test.ts"],
    testTimeout: 30000,
    // Control qualification runs after the integration suite against the same
    // API process. The real auth rate limiter can legitimately ask the setup
    // registration to wait for the current IP window to reset. Keep the
    // limiter enabled and give the hook enough time to honor Retry-After.
    hookTimeout: 130000,
    fileParallelism: false,
  },
});
