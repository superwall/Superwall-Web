import { defineConfig } from "vitest/config"

export default defineConfig({
  // Resolve workspace @superwall/* deps to their .ts source (same custom
  // condition tsconfig.base.json uses) so tests run without a dist build.
  resolve: {
    conditions: ["@superwall/source"],
  },
  test: {
    environment: "happy-dom",
    globals: true,
  },
})
