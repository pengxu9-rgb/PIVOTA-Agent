module.exports = {
  rootDir: __dirname,
  testEnvironment: 'node',
  // netGuard: tests may only reach loopback. setupFiles installs the guard before any test
  // module loads; the AfterEnv hooks fail the test during which a blocked attempt happened.
  // See tests/_support/netGuard.cjs.
  setupFiles: ['<rootDir>/tests/setupProxyEnv.js', '<rootDir>/tests/_support/netGuard.cjs'],
  setupFilesAfterEnv: ['<rootDir>/tests/_support/netGuardJestHooks.cjs'],
  testTimeout: 15000,
  testMatch: ['**/tests/**/*.test.(js|ts)'],
  modulePathIgnorePatterns: ['<rootDir>/.cursor/'],
  watchPathIgnorePatterns: ['<rootDir>/.cursor/'],
  transform: {
    '^.+\\.(ts|tsx)$': '<rootDir>/scripts/jest-ts-transformer.cjs',
  },
};
