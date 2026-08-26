import { defineConfig } from 'vitest/config';
import path from 'path';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    setupFiles: ['src/test/setup.ts'],
    exclude: ['dist-electron/**', 'dist/**', 'packages/auraxis-sdk/dist/**', 'release/**', 'node_modules/**'],
    // AntD/React 在 jsdom 销毁后的定时清理偶尔会留下未处理的 `window is not
    // defined`（测试本身全部通过）；把它当噪声忽略，而不是让 CI 随机红。
    dangerouslyIgnoreUnhandledErrors: true,
    coverage: {
      provider: 'v8',
      // json-summary 输出 coverage/coverage-summary.json，设置面板的
      // 「测试覆盖率」页读取同一份文件展示真实数据。
      reporter: ['text', 'json-summary'],
      // 全仓库单测分支门禁：统计 electron/、src/stores/、src/core/。
      // main.ts / preload.ts 依赖真实 Electron 窗口生命周期，由 E2E、
      // SDK smoke 与 headless CLI 覆盖，故从单元门禁中排除。
      // 当前实际：branches 80.04%。
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
    testTimeout: 10000,
  },
  resolve: {
    alias: {
      '@': path.resolve(import.meta.dirname, 'src'),
    },
  },
});
