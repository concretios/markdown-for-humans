/** @type {import('jest').Config} */
module.exports = {
    preset: 'ts-jest',
    testEnvironment: 'node',
    roots: ['<rootDir>/src'],
    testMatch: [
        '**/__tests__/**/*.test.ts',
        '**/*.test.ts'
    ],
    moduleFileExtensions: ['ts', 'tsx', 'js', 'jsx', 'json', 'node'],
    collectCoverageFrom: [
        'src/**/*.ts',
        '!src/**/*.d.ts',
        '!src/**/__tests__/**',
        // Exclude files that depend heavily on VS Code API (tested via integration tests)
        '!src/extension.ts',
        '!src/editor/MarkdownEditorProvider.ts',
        // Export pipeline depends on VS Code UI + external binaries (Chrome/Word); covered via manual/integration testing.
        '!src/features/documentExport.ts',
        '!src/webview/**'
    ],
    coverageThreshold: {
        global: {
            branches: 60,
            functions: 60,
            lines: 60,
            statements: 60
        }
    },
    coverageReporters: ['text', 'lcov', 'html'],
    // Mock VS Code and other modules for unit tests
    moduleNameMapper: {
        '^vscode$': '<rootDir>/src/__mocks__/vscode.ts',
        '^mermaid$': '<rootDir>/src/__mocks__/mermaid.ts',
        '\\.(css|less|scss)$': '<rootDir>/src/__mocks__/styleMock.ts'
    },
    setupFiles: ['<rootDir>/src/__tests__/setup.ts'],
    setupFilesAfterEnv: ['<rootDir>/src/__tests__/setup-after-env.ts'],
    verbose: true,
    // Fail tests on console warnings/errors to catch issues early
    silent: false
};
