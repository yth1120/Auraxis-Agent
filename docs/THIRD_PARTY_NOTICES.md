# 第三方声明（THIRD PARTY NOTICES）

本项目（Auraxis）在架构与业务实现上为自研代码，采用 MIT License（见 [LICENSE](../LICENSE)）。以下为项目使用到的第三方开源组件清单；完整版本号、依赖树与许可证原文以 `package.json`、`package-lock.json` 及各自上游仓库为准。

## 运行时依赖

| 依赖                                                     | 用途                    | 许可证                  |
| -------------------------------------------------------- | ----------------------- | ----------------------- |
| Electron                                                 | 桌面运行时              | MIT                     |
| React / React DOM                                        | UI 渲染                 | MIT                     |
| Ant Design (antd)                                        | 组件库                  | MIT                     |
| Zustand                                                  | 状态管理                | MIT                     |
| lucide-react                                             | 图标                    | ISC                     |
| react-virtuoso                                           | 消息列表虚拟化          | MIT                     |
| react-markdown / remark-gfm / remark-math / rehype-katex | Markdown / 数学公式渲染 | MIT                     |
| mermaid                                                  | 图表渲染                | MIT                     |
| echarts                                                  | 热力图 / 图表           | Apache-2.0              |
| highlight.js                                             | 代码高亮                | BSD-3-Clause            |
| @xterm/xterm / @xterm/addon-fit                          | 集成终端 UI             | MIT                     |
| node-pty                                                 | PTY 终端会话            | MIT                     |
| better-sqlite3（可选）                                   | 长期记忆 SQLite 存储    | MIT                     |
| ssh2                                                     | SSH 连接                | MIT                     |
| axios                                                    | HTTP / SSE 请求         | MIT                     |
| mammoth                                                  | Word 文档读取           | BSD-2-Clause            |
| docx                                                     | Word 文档生成           | MIT                     |
| exceljs                                                  | Excel 读写              | MIT                     |
| pptxgenjs                                                | PowerPoint 生成         | MIT                     |
| pdf-parse                                                | PDF 文本提取            | Apache-2.0              |
| pdfkit                                                   | PDF 生成                | MIT                     |
| adm-zip                                                  | PowerPoint ZIP 解析     | MIT                     |
| jszip                                                    | PptxGenJS 压缩组件      | MIT OR GPL-3.0-or-later |
| clsx / dagre / @types/dagre / @xyflow/react / allotment  | 样式与工作流可视化      | MIT                     |
| katex                                                    | 数学公式渲染            | MIT                     |
| iconv-lite                                               | 文本编码转换            | MIT                     |
| mime-types                                               | MIME 类型识别           | MIT                     |

> **说明**：`better-sqlite3` 为可选原生依赖，依赖本机编译工具链；未安装时长期记忆自动回退为 JSON 文件存储，不影响其余功能。

## 研究论文与设计参考

以下论文为本项目「论文驱动开发」的算法与设计参考（实现均为自研，未复制论文代码；论文版权归原作者，正文以 arXiv 页面为准）：

| 论文                                                                                                     | arXiv                                                |
| -------------------------------------------------------------------------------------------------------- | ---------------------------------------------------- |
| Eywa: Provenance-Grounded Long-Term Memory for AI Agents                                                 | [arXiv:2605.30771](https://arxiv.org/abs/2605.30771) |
| MAP-Graph: Provenance-Aware Shared Memory for Multi-Agent Workflows                                      | [arXiv:2608.10509](https://arxiv.org/abs/2608.10509) |
| AGORA: Adapter-Grounded Observation-Action Retention for Inference-Free Prompt Compression in LLM Agents | [arXiv:2605.26596](https://arxiv.org/abs/2605.26596) |
| SWE-Touch: Benchmarking Coding Agents When Users Touch the Code                                          | [arXiv:2608.02499](https://arxiv.org/abs/2608.02499) |
| Oversight Has a Capacity: Calibrating Agent Guards to a Subjective, Fatiguing Human                      | [arXiv:2606.08919](https://arxiv.org/abs/2606.08919) |
| AutoTool: Efficient Tool Selection for Large Language Model Agents                                       | [arXiv:2511.14650](https://arxiv.org/abs/2511.14650) |
| When Self-Evolution Backfires: Pre-Commit Gating against Skill Contamination in LLM Agents               | [arXiv:2608.05810](https://arxiv.org/abs/2608.05810) |

## 开发与构建工具链

| 依赖                                            | 用途              | 许可证     |
| ----------------------------------------------- | ----------------- | ---------- |
| TypeScript                                      | 类型检查与编译    | Apache-2.0 |
| Vite / @vitejs/plugin-react / @tailwindcss/vite | 构建              | MIT        |
| Vitest / @vitest/coverage-v8 / jsdom            | 单元与组件测试    | MIT        |
| @testing-library/react                          | React 组件测试    | MIT        |
| Playwright / @playwright/test                   | 端到端 / 烟雾测试 | Apache-2.0 |
| electron-builder                                | 安装包构建        | MIT        |
| concurrently / wait-on                          | 开发脚本编排      | MIT        |
| tailwindcss                                     | 样式工具          | MIT        |
| 各类 `@types/*` 声明包                          | TypeScript 类型   | MIT        |

## 项目自身声明

- 项目代码：MIT License，版权归 Auraxis Contributors 所有。
- 项目图标与设计资源（`build/`、`public/`、`src/assets/`）：随本项目仓库发布，使用请遵循仓库许可。
- 若分发二进制安装包，Electron 运行时及其依赖的许可证声明见 `node_modules/electron` 与 `node_modules/**/LICENSE*`。
