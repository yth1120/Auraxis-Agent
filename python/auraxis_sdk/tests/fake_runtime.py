"""Fake Auraxis runtime for the Python SDK integration test."""

import contextlib
import json
import os
import socket
import sys
import threading
import time


def main() -> None:
    srv = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    srv.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    srv.bind(("127.0.0.1", 0))
    srv.listen(8)
    port = srv.getsockname()[1]
    # 可选：在报出端口前先向 stderr 写入大量数据。调用方若不排空 stderr，这里会写满
    # 管道缓冲并永久阻塞 —— 正是回归用例 test_drains_stderr 要复现的场景。
    noisy = int(os.environ.get("FAKE_RUNTIME_STDERR_BYTES", "0") or "0")
    for _ in range(noisy // 100):
        sys.stderr.write("x" * 99 + "\n")
    sys.stderr.flush()

    print(f"AURAXIS_SDK_PORT={port}", flush=True)

    def handle(conn: socket.socket) -> None:
        buf = b""
        try:
            while True:
                data = conn.recv(65536)
                if not data:
                    break
                buf += data
                while b"\n" in buf:
                    line, buf = buf.split(b"\n", 1)
                    req = json.loads(line)
                    method = req["method"]
                    if method == "ping":
                        out = {"jsonrpc": "2.0", "id": req["id"], "result": {"pong": True, "time": 1}}
                    elif method == "agent.run":
                        params = req.get("params", {})
                        if not params.get("prompt"):
                            out = {
                                "jsonrpc": "2.0",
                                "id": req["id"],
                                "error": {"code": -32602, "message": "prompt 必填"},
                            }
                        else:
                            out = {
                                "jsonrpc": "2.0",
                                "id": req["id"],
                                "result": {"ran": params["prompt"], "description": params.get("description")},
                            }
                    elif method == "session.search":
                        out = {
                            "jsonrpc": "2.0",
                            "id": req["id"],
                            "result": {"query": req["params"]["query"], "count": 0, "results": []},
                        }
                    else:
                        out = {
                            "jsonrpc": "2.0",
                            "id": req["id"],
                            "error": {"code": -32601, "message": "unknown method"},
                        }
                    conn.sendall((json.dumps(out) + "\n").encode())
        except OSError:
            pass
        finally:
            with contextlib.suppress(OSError):
                conn.close()

    def serve() -> None:
        while True:
            try:
                conn, _ = srv.accept()
            except OSError:
                break
            threading.Thread(target=handle, args=(conn,), daemon=True).start()

    threading.Thread(target=serve, daemon=True).start()
    while True:
        time.sleep(1)


if __name__ == "__main__":
    main()
