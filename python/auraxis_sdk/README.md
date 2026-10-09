# auraxis-sdk (Python)

Python 客户端 SDK，通过 JSON-RPC 2.0（换行分隔，回环 TCP）无头驱动 Auraxis runtime。runtime 即 Electron 主进程以 `--sdk` 参数启动，不创建窗口。

## 前置条件

- Python 3.9+
- 仓库根目录已执行过 `npm install`，且 Electron 已下载
- 已编译主进程：`npm run electron:compile`（生成 `dist-electron/main.js`）

## 安装

```sh
cd python/auraxis_sdk
pip install -e .
```

SDK 无第三方运行时依赖（仅标准库），安装后即可使用。

## 用法

```python
from auraxis_sdk import create_client

with create_client() as client:
    print(client.ping())

    result = client.run_agent(
        prompt="修复登录 bug",
        description="SDK 任务",
        subagent_type="general-purpose",
        project_root="C:/my-project",
    )
    print(result)

    hits = client.search_sessions("登录", 5)
    print(hits)
```

`create_client()` 会以 `--sdk` 无头启动 Electron runtime，读取其 stdout 上的 `AURAXIS_SDK_PORT=<port>` 后连接回环端口，并在 `with` 退出或调用 `close()` 时关闭连接、终止 runtime 进程。

## API

| 函数 / 方法 | 说明 |
|---|---|
| `create_client(electron_path?, main_js?, env?, spawn_timeout?, request_timeout?)` | 启动 runtime 并返回上下文管理器 |
| `client.ping()` | 连通性探测，返回 `{ pong, time }` |
| `client.run_agent(prompt, description?, subagent_type?, project_root?)` | 无头执行一个 Agent 任务 |
| `client.search_sessions(query, limit?)` | 全文检索历史会话 |
| `client.close()` | 关闭连接（`with` 退出时自动调用） |

### 环境变量

- `AURAXIS_ELECTRON` — Electron 可执行文件路径（默认仓库内 `node_modules/electron/dist/electron(.exe)`）
- `AURAXIS_MAIN_JS` — 主进程入口（默认 `dist-electron/main.js`）

模型 API Key 等配置可通过 `env` 参数或仓库根目录的 `.env` 传入 runtime。

## 测试

```sh
cd python/auraxis_sdk
python -m unittest discover -s tests -t .
```

或在仓库根目录运行：`npm run sdk:test:py`

## 开发工具链

静态检查与类型检查与测试一起构成发布前全检（CI 在三个平台上都跑）：

```sh
# 安装钉死版本的开发依赖（ruff / pytest）
python -m pip install -e ".[dev]"

cd python/auraxis_sdk
python -m ruff check .          # 静态检查
npx pyright --project .         # 类型检查（走 Node，本机首次运行会下载）
```

仓库根目录的 `npm run sdk:check:py` 一次跑完三者。规则与目标 Python 版本定义在
`pyproject.toml` 的 `[tool.ruff]` / `[tool.pyright]` 段：按 `requires-python >= 3.9`
判定可用语法，行宽 120 与仓库 Prettier 对齐。

## 发布

`.github/workflows/publish-pypi.yml` 在 `v*` 标签上构建 sdist/wheel 并上传 PyPI
（需要仓库 secret `PYPI_API_TOKEN`；未配置时只构建不发布）。发布前会校验本文件的
`pyproject.toml` 版本与根 `package.json` 一致。
