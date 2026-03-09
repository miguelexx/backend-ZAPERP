/** @type {import('jest').Config} */
module.exports = {
  testEnvironment: 'node',
  testMatch: ['**/tests/**/*.test.js'],
  setupFilesAfterEnv: ['<rootDir>/tests/setup.js'],
  modulePathIgnorePatterns: ['<rootDir>/node_modules/'],
  verbose: true,
}
