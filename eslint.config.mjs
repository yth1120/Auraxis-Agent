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
    // 这些规则对当前代码库噪音过大或属于有意为之；每一项都应视为待还债务，
    // 新增代码不要依赖它们（见 AGENTS.md「代码卫生」）。
    rules: {
      'no-undef': 'off',
      '@typescript-eslint/no-require-imports': 'off',
      // 复杂度/规模的"预算"：先以 warning 形式暴露，避免债务继续静默增长。
      complexity: ['warn', 30],
      'max-depth': ['warn', 5],
      'max-lines-per-function': ['warn', 220],
      'max-lines': ['warn', 800],
    },
  },
  {
    files: ['**/*.test.{ts,tsx}', '**/__tests__/**/*.{ts,tsx}'],
    rules: {
      '@typescript-eslint/no-explicit-any': 'off',
    },
  },
);
