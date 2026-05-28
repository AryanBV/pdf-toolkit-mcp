import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    globals: false,
    include: ["test/**/*.test.ts"],
    // Integration tests spawn the server as a child process; the forks pool
    // handles nested child_process stdio reliably (worker threads do not).
    pool: "forks",
    testTimeout: 30_000,
    hookTimeout: 30_000,
    coverage: {
      provider: "v8",
      reporter: ["text", "lcov"],
      include: ["src/**/*.ts"],
      exclude: ["src/index.ts", "src/types.ts", "src/prompts/**"],
    },
  },
});
