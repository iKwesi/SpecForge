import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    environment: "node",
    coverage: {
      provider: "v8",
      reporter: ["text", "json-summary", "lcov"],
      all: true,
      include: ["src/**/*.ts"],
      exclude: ["src/**/*.d.ts"]
    }
  }
});
