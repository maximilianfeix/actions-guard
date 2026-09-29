import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    coverage: {
      provider: "v8",
      include: ["src/**/*.ts"],
      // three-line entry points: they only wire process.argv/env to tested code
      exclude: ["src/bin.ts", "src/main.ts"],
      reporter: ["text", "lcov", "json-summary"],
      // CI fails below these – the goal is well above them
      thresholds: { lines: 90, functions: 90, branches: 85, statements: 90 },
    },
  },
});
