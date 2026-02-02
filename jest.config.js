module.exports = {
  rootDir: __dirname,
  testEnvironment: 'node',
  testMatch: ['**/tests/**/*.test.(js|ts)'],
  modulePathIgnorePatterns: ['<rootDir>/.cursor/'],
  watchPathIgnorePatterns: ['<rootDir>/.cursor/'],
  transform: {
    '^.+\\.(ts|tsx)$': '<rootDir>/scripts/jest-ts-transformer.cjs',
  },
};
