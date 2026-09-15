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
      // main.ts 与 preload*.ts 依赖真实 Electron 窗口生命周期，由 E2E、
      // SDK smoke 与 headless CLI 覆盖，故从单元门禁中排除（preload 拆分出的
      // 领域模块是等价的 contextBridge 装配层，适用同一条口径）。
      // 当前实际：statements 89.66% / lines 92.00% / branches 81.00% /
      // functions 88.17%。
      thresholds: { lines: 80, branches: 80, functions: 80, statements: 80 },
      include: ['electron/**/*.ts', 'src/stores/**/*.ts', 'src/core/**/*.ts'],
      exclude: [
        'dist-electron/**',
        'dist/**',
        '**/__tests__/**',
        '**/*.test.*',
        '**/node_modules/**',
        'electron/main.ts',
        'electron/preload*.ts',
      ],
    },
    testTimeout: 30000,
    hookTimeout: 30000,
    teardownTimeout: 30000,
    // 显式限制并发：沙箱/PTY 这类重进程用例在默认并发下会被饿死，
    // 出现“2 秒超时却 10 秒还没杀完进程树”的假失败。
    minWorkers: 1,
    maxWorkers: 4,
  },
  resolve: {
    alias: {
      '@': path.resolve(import.meta.dirname, 'src'),
    },
  },
});
