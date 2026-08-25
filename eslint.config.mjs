import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import reactHooks from 'eslint-plugin-react-hooks';
import prettier from 'eslint-config-prettier';

export default tseslint.config(
  {
    ignores: [
      'dist/**',
      'dist-electron/**',
      'release/**',
      'coverage/**',
      'node_modules/**',
      'vendor/**',
      'packages/auraxis-sdk/dist/**',
      'packages/auraxis-sdk/src/__tests__/**',
      'python/**',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['**/*.{ts,tsx,js,mjs}'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      parserOptions: { ecmaFeatures: { jsx: true } },
    },
    plugins: { 'react-hooks': reactHooks },
    rules: {
      'react-hooks/rules-of-hooks': 'error',
      'react-hooks/exhaustive-deps': 'warn',
      '@typescript-eslint/no-explicit-any': 'warn',
      '@typescript-eslint/no-unused-vars': [
        'warn',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrors: 'none' },
      ],
      '@typescript-eslint/ban-ts-comment': 'off',
      // These rules are noisy or intentional for this codebase; keep them documented.
      '@typescript-eslint/no-unsafe-function-type': 'off',
      'no-useless-assignment': 'off',
      'no-regex-spaces': 'off',
      'no-control-regex': 'off',
      'no-irregular-whitespace': 'off',
      'no-undef': 'off',
    },
  },
  prettier,
  {
    // Baseline exceptions for currently inherited code; keep hooks and unused-var warnings visible.
    rules: {
      'no-undef': 'off',
      '@typescript-eslint/no-require-imports': 'off',
      'no-useless-escape': 'off',
      'no-empty': 'off',
      'prefer-const': 'off',
      'no-misleading-character-class': 'off',
      '@typescript-eslint/no-unnecessary-type-constraint': 'off',
      'preserve-caught-error': 'off',
    },
  },
  {
    files: ['**/*.test.{ts,tsx}', '**/__tests__/**/*.{ts,tsx}'],
    rules: {
      '@typescript-eslint/no-explicit-any': 'off',
    },
  },
);
