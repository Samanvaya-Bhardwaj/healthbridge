import js from '@eslint/js';
import globals from 'globals';
import reactHooks from 'eslint-plugin-react-hooks';
import reactRefresh from 'eslint-plugin-react-refresh';

export default [
  {
    ignores: ['**/node_modules/**', '**/dist/**', '**/coverage/**', 'ai-service/**', 'docs/**'],
  },
  js.configs.recommended,
  {
    files: ['backend/**/*.js', 'shared/**/*.js', 'scripts/**/*.{js,mjs}', 'e2e/**/*.js', '*.js'],
    languageOptions: {
      ecmaVersion: 2024,
      sourceType: 'module',
      globals: { ...globals.node },
    },
    rules: {
      'no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      'no-console': ['error', { allow: ['error', 'warn', 'log'] }],
      eqeqeq: ['error', 'always'],
    },
  },
  {
    // Application code must log through the structured logger, never console.
    files: ['backend/src/**/*.js'],
    rules: { 'no-console': 'error' },
  },
  {
    files: ['frontend/**/*.{js,jsx}'],
    languageOptions: {
      ecmaVersion: 2024,
      sourceType: 'module',
      globals: { ...globals.browser },
      parserOptions: { ecmaFeatures: { jsx: true } },
    },
    plugins: { 'react-hooks': reactHooks, 'react-refresh': reactRefresh },
    rules: {
      ...reactHooks.configs.recommended.rules,
      'react-refresh/only-export-components': ['warn', { allowConstantExport: true }],
      'no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^[A-Z_]' }],
      eqeqeq: ['error', 'always'],
    },
  },
  {
    files: ['**/*.test.{js,jsx}', '**/tests/**/*.{js,jsx}', 'frontend/vite.config.js'],
    languageOptions: { globals: { ...globals.node } },
  },
];
