import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts", "test/unit/**/*.spec.ts", "test/integration/**/*.spec.ts"],
    testTimeout: 30000,
    hookTimeout: 30000,
    pool: "forks",
  },
});
