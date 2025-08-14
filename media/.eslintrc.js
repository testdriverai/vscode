/* eslint-env node */
module.exports = {
  env: {
    browser: true,
    es2021: true
  },
  globals: {
    acquireVsCodeApi: 'readonly',
    AnsiToHtml: 'readonly'
  },
  rules: {
    // Allow unused parameters and specific variables
    '@typescript-eslint/no-unused-vars': 'off',
    'no-unused-vars': ['error', {
      'argsIgnorePattern': '^_',
      'varsIgnorePattern': '^useExample$'
    }],
    // Allow single-line if statements without braces for simple returns
    'curly': ['error', 'multi-line'],
    // Disable some rules for webview context
    'no-console': 'off',
    // Allow control characters in regex for ANSI escape sequences
    'no-control-regex': 'off',
    // Allow lexical declarations in case blocks
    'no-case-declarations': 'off'
  }
};
