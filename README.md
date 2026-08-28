# Auraxis

![CI](https://github.com/yth1120/Auraxis-Agent/actions/workflows/build.yml/badge.svg)
![License](https://img.shields.io/badge/license-MIT-blue)

Auraxis 是一个基于 Electron + React 19 + TypeScript 的桌面端 AI 智能体工作台，提供统一的 ReAct 步进引擎、多智能体调度、Code / Work 模式、MCP 连接器、文档处理、终端、插件扩展和持久化项目记忆。

## 界面预览

![Auraxis 主界面](https://github.com/user-attachments/assets/cc06146b-51a2-4b2e-a6c4-41aca0a0fb5e)

![Auraxis 工作台](https://github.com/user-attachments/assets/88f118c2-fc15-4779-8be3-928cb9c04ae8)

## 功能亮点

- 统一聊天、多 Agent 与 Code Mode 执行链路
- 71+ 模型工具与完整权限、审批、沙箱管线
- Chat / Work / Code 三种工作模式
- MCP、飞书/Lark、DeepSeek Harness 等连接器
- Word、Excel、PPT、PDF 文档技能
- TypeScript 与 Python 两套 SDK
- Windows / macOS / Linux 三平台构建与 E2E
- 本地账户、加密凭据、记忆与全文检索

## 环境要求

- Node.js `>=22.12`
- npm `>=10`
- Python `>=3.9`（仅使用 Python SDK 时需要；Windows 可用 `winget install Python.Python.3.10`）

## 快速开始

```powershell
git clone https://github.com/yth1120/Auraxis-Agent.git
cd Auraxis
npm install
Copy-Item .env.example .env
npm run electron:dev
```

首次运行前请在 `.env` 中填写 `DEEPSEEK_API_KEY`，也可以在应用设置页中配置模型密钥。

## 常用命令

| 命令                       | 作用                                   |
| -------------------------- | -------------------------------------- |
| `npm run electron:dev`     | 启动 Electron 开发环境                 |
| `npm run electron:compile` | 编译主进程                             |
| `npm run sdk:build`        | 编译 TypeScript SDK                    |
| `npm run sdk:test`         | 运行 TypeScript SDK 单元测试           |
| `npm run sdk:test:py`      | 运行 Python SDK 单元测试               |
| `npm run sdk:smoke`        | 启动真实无头 runtime 并验证 SDK 连通性 |
| `npm run test`             | 运行全量单元测试                       |
| `npm run check`            | Lint、编译、类型检查和全量测试         |
| `npm run build`            | 全量构建并打包                         |

## SDK

- TypeScript：[packages/auraxis-sdk](packages/auraxis-sdk/README.md)
- Python：[python/auraxis_sdk](python/auraxis_sdk/README.md)

SDK 通过换行分隔的 JSON-RPC 2.0 协议驱动 Auraxis 无头 runtime，支持 `ping`、`agent.run` 和 `session.search`。

## 文档

- [工程规范](AGENTS.md)
- [架构与开发文档（英文）](docs/README.md)
- [架构与开发文档（中文）](docs/README.zh-CN.md)
- [更新日志](CHANGELOG.md)

## 安全

模型编写的任意代码执行默认关闭。工具执行必须经过权限配置、沙箱门、审批与路径边界校验；只有显式设置 `AURAXIS_ALLOW_UNSAFE_CODE=1` 的受信开发环境才会启用不安全代码执行。

## License

[MIT](LICENSE)
