import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/**/*.test.ts"],
    environment: "node",
    // Test files run in parallel and several of them spawn the compiled CLI, so
    // the build happens once here rather than in each file's beforeAll.
    globalSetup: ["./src/test-support/ensure-dist.ts"],
  },
});
