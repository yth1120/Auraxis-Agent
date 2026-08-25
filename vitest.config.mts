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
      // 校准后的「真实且会守住」门槛：当前实际 85.3% 行/语句、79.17% 分支、
      // 86.22% 函数。
      // 行/语句已达实际天花板区间，取整锁定；分支/函数留足余量。
      thresholds: { lines: 80, branches: 70, functions: 80, statements: 80 },
      include: ['electron/**/*.ts', 'src/stores/**/*.ts', 'src/core/**/*.ts'],
      exclude: ['dist-electron/**', 'dist/**', '**/__tests__/**', '**/*.test.*', '**/node_modules/**'],
    },
    testTimeout: 10000,
  },
  resolve: {
    alias: {
      '@': path.resolve(import.meta.dirname, 'src'),
    },
  },
});
