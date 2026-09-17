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
      // 测试文件是一段可读的叙事：长 describe + 长用例是常态，
      // 规模阈值在这里只会逼出无意义的拆分（用例被切碎后更难读）。
      'max-lines-per-function': 'off',
      'max-lines': 'off',
    },
  },
  {
    // 渲染层组件：函数体主体是声明式 JSX 树，行数由布局复杂度决定，
    // 拆分只能靠"为了行数而拆"的伪子组件；逻辑复杂度（complexity）
    // 仍然全量生效，真实的分支债务不会被掩盖。
    files: ['src/components/**/*.{ts,tsx}'],
    rules: {
      'max-lines-per-function': 'off',
    },
  },
  {
    // 纯数据 / 纯类型聚合文件：i18n 词表与 IPC 契约声明，
    // 行数反映的是 key/接口数量而不是实现规模。
    files: ['src/i18n/*.ts', 'src/types/electron-api.ts'],
    rules: {
      'max-lines': 'off',
    },
  },
);
