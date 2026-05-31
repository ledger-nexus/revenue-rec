import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    // Encryption tests touch the shared Neon DB and run sequentially
    // with the rest of the portfolio. 60s mirrors ledger-core's
    // testTimeout for parity.
    testTimeout: 60_000,
    hookTimeout: 30_000,
  },
  resolve: {
    alias: {
      "@/": new URL("./src/", import.meta.url).pathname,
    },
  },
});
