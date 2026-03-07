module.exports = {
  rootDir: __dirname,
  testEnvironment: 'node',
  testTimeout: 15000,
  testMatch: ['**/tests/**/*.test.(js|ts)'],
  modulePathIgnorePatterns: ['<rootDir>/.cursor/'],
  watchPathIgnorePatterns: ['<rootDir>/.cursor/'],
  transform: {
    '^.+\\.(ts|tsx)$': '<rootDir>/scripts/jest-ts-transformer.cjs',
  },
};
