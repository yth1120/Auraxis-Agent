"""Auraxis Python SDK — client for an Auraxis runtime over JSON-RPC 2.0.

The runtime is the Electron main process launched with ``--sdk``. It
advertises a loopback TCP port on stdout (``AURAXIS_SDK_PORT=<port>``);
this client reads the port, connects, and speaks newline-delimited JSON-RPC.
"""

from __future__ import annotations

import contextlib
import json
import os
import queue
import re
import secrets
import socket
import subprocess
import threading
import time
from collections import deque
from pathlib import Path
from typing import Any


class AuraxisError(RuntimeError):
    """Raised for RPC errors, timeouts, and runtime failures."""


def _repo_root() -> Path:
    return Path(__file__).resolve().parents[3]  # python/auraxis_sdk/auraxis_sdk -> repo root


def _find_electron() -> str:
    env = os.environ.get("AURAXIS_ELECTRON")
    if env:
        return env
    exe = "electron.exe" if os.name == "nt" else "electron"
    candidate = _repo_root() / "node_modules" / "electron" / "dist" / exe
    if candidate.exists():
        return str(candidate)
    raise AuraxisError("找不到 Electron，请设置 AURAXIS_ELECTRON 环境变量")


def _default_main() -> str:
    env = os.environ.get("AURAXIS_MAIN_JS")
    if env:
        return env
    candidate = _repo_root() / "dist-electron" / "main.js"
    if candidate.exists():
        return str(candidate)
    raise AuraxisError("找不到 dist-electron/main.js，请先运行 npm run electron:compile")


class _Request:
    __slots__ = ("error", "event", "result")

    def __init__(self) -> None:
        self.event = threading.Event()
        self.result: Any = None
        self.error: BaseException | None = None


class AuraxisClient:
    """JSON-RPC client over one TCP connection."""

    def __init__(self, sock: socket.socket, request_timeout: float = 120.0, token: str | None = None) -> None:
        self._sock = sock
        self._request_timeout = request_timeout
        self._token = token
        self._lock = threading.Lock()
        self._pending: dict[int, _Request] = {}
        self._next_id = 0
        self._closed = False
        self._reader = threading.Thread(target=self._read_loop, daemon=True)
        self._reader.start()

    def _read_loop(self) -> None:
        buf = b""
        try:
            while True:
                data = self._sock.recv(65536)
                if not data:
                    break
                buf += data
                while b"\n" in buf:
                    line, buf = buf.split(b"\n", 1)
                    line = line.strip()
                    if not line:
                        continue
                    try:
                        msg = json.loads(line)
                    except ValueError:
                        continue
                    rid = msg.get("id")
                    if rid is None:
                        continue
                    with self._lock:
                        req = self._pending.pop(rid, None)
                    if req is None:
                        continue
                    if "error" in msg:
                        err = msg["error"] or {}
                        req.error = AuraxisError(
                            f"Auraxis RPC error ({err.get('code')}): {err.get('message')}"
                        )
                    else:
                        req.result = msg.get("result")
                    req.event.set()
        except OSError:
            pass
        finally:
            with self._lock:
                pending = list(self._pending.values())
                self._pending.clear()
            for req in pending:
                req.error = AuraxisError("Auraxis runtime closed")
                req.event.set()

    def request(self, method: str, params: dict | None = None, timeout: float | None = None) -> Any:
        if self._closed:
            raise AuraxisError("Auraxis client is closed")
        with self._lock:
            self._next_id += 1
            rid = self._next_id
            req = _Request()
            self._pending[rid] = req
        payload = (
            json.dumps({"jsonrpc": "2.0", "id": rid, "method": method, "params": params or {}}) + "\n"
        )
        try:
            self._sock.sendall(payload.encode("utf-8"))
        except OSError as exc:
            with self._lock:
                self._pending.pop(rid, None)
            raise AuraxisError(f"发送请求失败: {exc}") from exc
        if not req.event.wait(timeout if timeout is not None else self._request_timeout):
            with self._lock:
                self._pending.pop(rid, None)
            raise AuraxisError(f"Auraxis RPC timeout: {method}")
        if req.error:
            raise req.error
        return req.result

    def ping(self) -> dict:
        return self.request("ping")

    def run_agent(
        self,
        prompt: str,
        description: str | None = None,
        subagent_type: str | None = None,
        project_root: str | None = None,
    ) -> Any:
        params = {
                "prompt": prompt,
                "description": description,
                "subagentType": subagent_type,
                "projectRoot": project_root,
            }
        if self._token:
            params["token"] = self._token
        return self.request("agent.run", params)

    def search_sessions(self, query: str, limit: int | None = None) -> dict:
        params = {"query": query, "limit": limit}
        if self._token:
            params["token"] = self._token
        return self.request("session.search", params)

    def close(self) -> None:
        if self._closed:
            return
        self._closed = True
        with contextlib.suppress(OSError):
            self._sock.close()


class AuraxisRuntime:
    """Spawned runtime process plus its connected client (context manager)."""

    def __init__(self, client: AuraxisClient, proc: subprocess.Popen) -> None:
        self.client = client
        self._proc = proc

    def __enter__(self) -> AuraxisClient:
        return self.client

    def __exit__(self, *exc: Any) -> None:
        self.close()

    def close(self) -> None:
        with contextlib.suppress(Exception):
            self.client.close()
        if self._proc.poll() is None:
            with contextlib.suppress(Exception):
                self._proc.kill()
        # kill 只发信号、不回收：必须 wait 才能收尸，否则子进程以僵尸态残留，
        # CPython 在 GC 时会告警 "subprocess ... is still running"。
        with contextlib.suppress(Exception):
            self._proc.wait(timeout=5)
        # Popen 只是持有管道引用，不负责关闭；等子进程收尸后再显式关掉，
        # 否则 GC 时同样告警 unclosed file。
        for stream in (self._proc.stdin, self._proc.stdout, self._proc.stderr):
            with contextlib.suppress(Exception):
                if stream is not None:
                    stream.close()


def create_client(
    electron_path: str | None = None,
    main_js: str | None = None,
    env: dict | None = None,
    spawn_timeout: float = 30.0,
    request_timeout: float = 120.0,
) -> AuraxisRuntime:
    """Spawn the Auraxis runtime, read its advertised port, and connect."""
    electron = electron_path or _find_electron()
    main = main_js or _default_main()
    proc_env = dict(os.environ)
    if env:
        proc_env.update(env)
    # TCP 服务默认强制鉴权：未配置时生成随机 token 并传给运行时。
    token = (env or {}).get("AURAXIS_SDK_TOKEN") or os.environ.get("AURAXIS_SDK_TOKEN") or secrets.token_hex(24)
    proc_env["AURAXIS_SDK_TOKEN"] = token

    proc = subprocess.Popen(
        [electron, main, "--sdk"],
        stdin=subprocess.DEVNULL,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        env=proc_env,
    )
    # 收窄必须落在局部绑定上：闭包捕获的是可变属性 proc.stdout，外层 assert 对
    # 闭包体无效（pyright reportOptionalMemberAccess），运行期也可能被改。
    stdout = proc.stdout
    assert stdout is not None

    lines: queue.Queue[str | None] = queue.Queue()

    def _reader() -> None:
        try:
            for raw in iter(stdout.readline, b""):
                lines.put(raw.decode("utf-8", "replace"))
        except (OSError, ValueError):
            # 关闭 close() 会显式关掉管道，阻塞中的 readline 会抛 ValueError。
            pass
        finally:
            lines.put(None)

    threading.Thread(target=_reader, daemon=True).start()

    # stderr 必须持续排空：只设 PIPE 而不读，子进程一旦写满管道缓冲就会永久阻塞，
    # 而父进程还在等端口 —— 最终以一句毫无线索的超时收场。排空线程在整个会话期间
    # 保持存活，并保留末尾若干行用于失败诊断（对应 TS SDK 的 onStderr）。
    stderr = proc.stderr
    stderr_tail: deque[str] = deque(maxlen=50)

    def _drain_stderr() -> None:
        if stderr is None:
            return
        try:
            for raw in iter(stderr.readline, b""):
                stderr_tail.append(raw.decode("utf-8", "replace").rstrip())
        except (OSError, ValueError):
            pass

    def stderr_hint() -> str:
        if not stderr_tail:
            return ""
        return "\n--- runtime stderr (tail) ---\n" + "\n".join(stderr_tail)

    threading.Thread(target=_drain_stderr, daemon=True).start()

    port: int | None = None
    deadline = time.monotonic() + spawn_timeout
    while time.monotonic() < deadline:
        if proc.poll() is not None:
            raise AuraxisError(f"Auraxis runtime exited (code={proc.returncode}){stderr_hint()}")
        try:
            line = lines.get(timeout=0.2)
        except queue.Empty:
            continue
        if line is None:
            continue
        match = re.search(r"AURAXIS_SDK_PORT=(\d+)", line)
        if match:
            port = int(match.group(1))
            break

    if port is None:
        proc.kill()
        raise AuraxisError(f"Auraxis runtime 未在超时内输出 SDK 端口{stderr_hint()}")

    sock = socket.create_connection(("127.0.0.1", port), timeout=10)
    client = AuraxisClient(sock, request_timeout, token)
    try:
        client.request("ping", timeout=min(2.0, request_timeout))
    except Exception as exc:
        client.close()
        proc.kill()
        raise AuraxisError(f"无法连接 Auraxis runtime: {exc}") from exc
    return AuraxisRuntime(client, proc)
