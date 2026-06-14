/**
 * Shared helpers for integration tests.
 *
 * Integration tests run only when SAP_TEST_CONNECTION is set:
 *   SAP_TEST_CONNECTION=CAR npm run test:integration
 *
 * They are read-only — no writes, no transports, no deletions.
 * Every test that modifies SAP state is excluded from this suite.
 */

export const CONNECTION_ID = process.env.SAP_TEST_CONNECTION

/**
 * Call at the top of each integration describe block.
 * Skips the whole suite when no connection is configured.
 */
export function requireConnection(): void {
  if (!CONNECTION_ID) {
    throw new Error(
      "Integration tests require SAP_TEST_CONNECTION=<id> to be set.\n" +
      "Example: SAP_TEST_CONNECTION=CAR npm run test:integration"
    )
  }
}
