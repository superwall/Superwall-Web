import { fileURLToPath } from "node:url"
import { defineConfig } from "vitest/config"

export default defineConfig({
  resolve: {
    alias: {
      // `#superscript-loader` is a package.json subpath import that maps to
      // dist/ for published consumers. Point it at the source Node loader so
      // tests run against src without requiring a prior build.
      "#superscript-loader": fileURLToPath(
        new URL("./src/internal/superscript-loader.ts", import.meta.url),
      ),
    },
  },
  test: {
    environment: "happy-dom",
    globals: true,
  },
})
