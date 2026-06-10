import { defineConfig } from "vitest/config";
import path from "node:path";

// Mirror tsconfig.json's `paths` for vitest so `@/...` imports resolve
// at test time the same way Next.js + tsc resolve them in app code.
export default defineConfig({
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "src"),
    },
  },
});
