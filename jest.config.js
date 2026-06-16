/** @type {import('jest').Config} */
module.exports = {
  testEnvironment: 'node',
  testMatch: ['**/tests/**/*.test.js'],
  setupFilesAfterEnv: ['<rootDir>/tests/setup.js'],
  testPathIgnorePatterns: [
    '<rootDir>/node_modules/',
    '<rootDir>/.claude/',
    '<rootDir>/coverage/',
    '<rootDir>/dist/',
  ],
  modulePathIgnorePatterns: [
    '<rootDir>/node_modules/',
    '<rootDir>/.claude/',
    '<rootDir>/coverage/',
    '<rootDir>/dist/',
  ],
  verbose: true,
}
