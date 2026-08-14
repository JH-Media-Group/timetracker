import { defineConfig } from "vitest/config";
import { resolve } from "node:path";

export default defineConfig({
  test: {
    environment: "node",
    globals: false,
    include: ["src/**/*.test.ts", "tests/**/*.test.ts"],
    setupFiles: ["./tests/setup.ts"],
    // Integration tests share one database. Running files in parallel would
    // have them truncating each other's fixtures mid-assertion.
    fileParallelism: false,
    testTimeout: 20000,
    hookTimeout: 30000,
  },
  resolve: {
    alias: { "@": resolve(__dirname, "./src") },
  },
});
