import { defineConfig } from 'vitest/config';
import path from 'path';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    setupFiles: ['src/test/setup.ts'],
    exclude: ['dist-electron/**', 'dist/**', 'packages/auraxis-sdk/dist/**', 'release/**', 'node_modules/**'],
    coverage: {
      provider: 'v8',
      // json-summary 输出 coverage/coverage-summary.json，设置面板的
      // 「测试覆盖率」页读取同一份文件展示真实数据。
      reporter: ['text', 'json-summary'],
      // 全仓库单测分支门禁：统计 electron/、src/stores/、src/core/。
      // main.ts / preload.ts 依赖真实 Electron 窗口生命周期，由 E2E、
      // SDK smoke 与 headless CLI 覆盖，故从单元门禁中排除。
      // 当前实际：statements 87.76% / lines 90.03% / branches 80.22% /
      // functions 82.20%。
      thresholds: { lines: 80, branches: 80, functions: 80, statements: 80 },
      include: ['electron/**/*.ts', 'src/stores/**/*.ts', 'src/core/**/*.ts'],
      exclude: [
        'dist-electron/**',
        'dist/**',
        '**/__tests__/**',
        '**/*.test.*',
        '**/node_modules/**',
        'electron/main.ts',
        'electron/preload.ts',
      ],
    },
    testTimeout: 30000,
    hookTimeout: 30000,
    teardownTimeout: 30000,
  },
  resolve: {
    alias: {
      '@': path.resolve(import.meta.dirname, 'src'),
    },
  },
});
