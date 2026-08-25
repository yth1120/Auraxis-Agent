import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import path from 'path';
import fs from 'fs';
import type { Plugin } from 'vite';

/**
 * 测试覆盖率报告（coverage/coverage-summary.json）是 gitignore 的开发期产物。
 * - 浏览器模式（纯 vite）：把 /coverage/coverage-summary.json 提供给渲染层读取；
 * - 生产构建：文件存在时一并拷贝进 dist/coverage/，让打包产物也能展示。
 * Electron 桌面端优先走 IPC（coverage:get），从开发目录实时读取。
 */
function coverageSummaryPlugin(): Plugin {
  const summaryFile = () => path.resolve(import.meta.dirname, 'coverage', 'coverage-summary.json');
  return {
    name: 'auraxis-coverage-summary',
    configureServer(server) {
      server.middlewares.use('/coverage/coverage-summary.json', (_req, res) => {
        const file = summaryFile();
        if (!fs.existsSync(file)) {
          res.statusCode = 404;
          res.end('not found');
          return;
        }
        res.setHeader('Content-Type', 'application/json');
        res.setHeader('Cache-Control', 'no-store');
        fs.createReadStream(file).pipe(res);
      });
    },
    closeBundle() {
      const src = summaryFile();
      if (!fs.existsSync(src)) return;
      const destDir = path.resolve(import.meta.dirname, 'dist', 'coverage');
      fs.mkdirSync(destDir, { recursive: true });
      fs.copyFileSync(src, path.join(destDir, 'coverage-summary.json'));
    },
  };
}

export default defineConfig({
  plugins: [tailwindcss(), react(), coverageSummaryPlugin()],
  base: './',
  resolve: {
    alias: {
      '@': path.resolve(import.meta.dirname, 'src'),
    },
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    chunkSizeWarningLimit: 1000,
    // Electron 44 ships Chromium 152 — target the real runtime so Vite skips
    // unnecessary legacy-syntax polyfills.
    target: 'chrome152',
    rollupOptions: {
      input: {
        main: path.resolve(import.meta.dirname, 'index.html'),
      },
      output: {
        manualChunks(id) {
          if (id.includes('node_modules/@rc-component')) {
            return 'vendor-rc';
          }
          if (
            id.includes('node_modules/antd') ||
            id.includes('node_modules/@ant-design') ||
            id.includes('node_modules/rc-')
          ) {
            return 'vendor-antd';
          }
          if (
            id.includes('node_modules/react-markdown') ||
            id.includes('node_modules/remark-') ||
            id.includes('node_modules/rehype-') ||
            id.includes('node_modules/unified') ||
            id.includes('node_modules/mdast') ||
            id.includes('node_modules/hast') ||
            id.includes('node_modules/micromark')
          ) {
            return 'vendor-markdown';
          }
          if (id.includes('node_modules/echarts') || id.includes('node_modules/zrender')) {
            return 'vendor-echarts';
          }
          if (id.includes('node_modules/react/') || id.includes('node_modules/react-dom/')) {
            return 'vendor-react';
          }
          if (id.includes('node_modules/lucide-react')) {
            return 'vendor-icons';
          }
          if (id.includes('node_modules/react-virtuoso')) {
            return 'vendor-virtuoso';
          }
          if (id.includes('node_modules/@xyflow')) {
            return 'vendor-flow';
          }
          if (id.includes('node_modules/allotment')) {
            return 'vendor-layout';
          }
          if (id.includes('node_modules/katex')) {
            return 'vendor-katex';
          }
          if (id.includes('node_modules/highlight.js') || id.includes('node_modules/@highlightjs')) {
            return 'vendor-hljs';
          }
        },
      },
    },
  },
  server: {
    port: 5173,
  },
});
