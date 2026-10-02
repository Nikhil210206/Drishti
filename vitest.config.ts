import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["packages/*/test/**/*.test.ts", "apps/*/test/**/*.test.ts"],
    // Snapshot tests launch headless Chromium once per file.
    testTimeout: 20000,
    hookTimeout: 60000,
  },
});
