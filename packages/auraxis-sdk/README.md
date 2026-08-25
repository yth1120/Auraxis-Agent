# @auraxis/sdk

TypeScript 客户端 SDK，用于通过 JSON-RPC 2.0（换行分隔，回环 TCP）无头驱动 Auraxis runtime。runtime 即 Electron 主进程以 `--sdk` 参数启动：不创建窗口、使用独立临时 Chromium profile，与正在运行的桌面 App 互不干扰。

## 前置条件

- 仓库根目录已执行过 `npm install`
- 已编译主进程：`npm run electron:compile`（生成 `dist-electron/main.js`）
- Node.js 18+

## 安装与构建

```sh
npm install
npm run electron:compile   # 生成 runtime 入口
npm run sdk:build          # 编译 SDK 本身（生成 packages/auraxis-sdk/dist）
```

## 用法

```ts
import { createAuraxis } from '@auraxis/sdk';

const client = await createAuraxis(); // 默认使用仓库内 electron + dist-electron/main.js
// 也可指定：createAuraxis({ electronPath, mainJs, spawnTimeoutMs, requestTimeoutMs, onStderr })

const pong = await client.ping();
console.log(pong); // { pong: true, time }

const result = await client.runAgent({
  prompt: '修复登录 bug',
  description: 'SDK 任务',
  subagentType: 'general-purpose',
  projectRoot: 'C:/my-project',
});
console.log(result);

const hits = await client.searchSessions('登录', 5);
console.log(hits);

await client.close();
```

## API

| 方法                                   | 说明                                                                              |
| -------------------------------------- | --------------------------------------------------------------------------------- |
| `createAuraxis(options?)`              | 启动 runtime 并返回已连接的客户端                                                 |
| `client.ping()`                        | 连通性探测，返回 `{ pong, time }`                                                 |
| `client.runAgent(params)`              | 无头执行一个 Agent 任务（`prompt`、`description`、`subagentType`、`projectRoot`） |
| `client.searchSessions(query, limit?)` | 全文检索历史会话                                                                  |
| `client.close()`                       | 关闭连接并终止 runtime 进程                                                       |

### 选项与环境变量

- `electronPath` / `mainJs`：覆盖 runtime 路径；也可用环境变量 `AURAXIS_ELECTRON`、`AURAXIS_MAIN_JS`
- `env`：向 runtime 进程注入额外环境变量（如模型 API Key）
- `spawnTimeoutMs`（默认 30000）：等待 runtime 输出端口的最长时间
- `requestTimeoutMs`（默认 120000）：单次 RPC 请求超时
- `onStderr`：接收 runtime 的 stderr 输出，便于启动排障

## 协议

- 传输：127.0.0.1 回环 TCP（Electron 主进程在 Windows 上无法读取管道 stdin，故不走 stdio）
- 帧格式：每行一个 JSON-RPC 2.0 消息
- 方法：`ping`、`agent.run`、`session.search`
- 启动握手：runtime 在 stdout 输出 `AURAXIS_SDK_PORT=<port>`，客户端据此连接

## 测试

```sh
npm run sdk:test
```
