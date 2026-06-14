import { defineConfig } from "vitest/config"

export default defineConfig({
  test: {
    include: ["tests/integration/**/*.integration.test.ts"],
    environment: "node",
    // Integration tests call a live SAP system — give each one up to 30s
    testTimeout: 30000,
    // Run serially to avoid saturating the SAP session
    pool: "forks",
    poolOptions: { forks: { singleFork: true } },
  },
})
