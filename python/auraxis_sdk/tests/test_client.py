import contextlib
import json
import socket
import sys
import threading
import unittest
from pathlib import Path

from auraxis_sdk.client import AuraxisClient, AuraxisError, create_client

ROOT = Path(__file__).resolve().parents[1]


def start_fake_server():
    srv = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    srv.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    srv.bind(("127.0.0.1", 0))
    srv.listen(8)
    port = srv.getsockname()[1]

    def handle(conn):
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
                    elif method == "hang":
                        continue
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

    def serve():
        while True:
            try:
                conn, _ = srv.accept()
            except OSError:
                break
            threading.Thread(target=handle, args=(conn,), daemon=True).start()

    threading.Thread(target=serve, daemon=True).start()
    return srv, port


class AuraxisClientTest(unittest.TestCase):
    def setUp(self):
        self.srv, port = start_fake_server()
        self.sock = socket.create_connection(("127.0.0.1", port), timeout=5)
        self.client = AuraxisClient(self.sock, request_timeout=5)

    def tearDown(self):
        self.client.close()
        self.srv.close()

    def test_ping(self):
        self.assertTrue(self.client.ping()["pong"])

    def test_run_agent(self):
        out = self.client.run_agent("修复 bug", description="SDK 任务", project_root="C:/proj")
        self.assertEqual(out["ran"], "修复 bug")
        self.assertEqual(out["description"], "SDK 任务")

    def test_rpc_error_mapping(self):
        with self.assertRaises(AuraxisError) as ctx:
            self.client.run_agent("")
        self.assertIn("prompt 必填", str(ctx.exception))

    def test_search_sessions(self):
        res = self.client.search_sessions("hello", 3)
        self.assertEqual(res["query"], "hello")
        self.assertEqual(res["count"], 0)

    def test_timeout(self):
        with self.assertRaises(AuraxisError) as ctx:
            self.client.request("hang", timeout=0.3)
        self.assertIn("timeout", str(ctx.exception).lower())

    def test_closed_client_rejects(self):
        self.client.close()
        with self.assertRaises(AuraxisError):
            self.client.ping()


class CreateClientTest(unittest.TestCase):
    def test_create_client_with_fake_runtime(self):
        runtime = create_client(
            electron_path=sys.executable,
            main_js=str(ROOT / "tests" / "fake_runtime.py"),
            spawn_timeout=10,
            request_timeout=5,
        )
        try:
            self.assertTrue(runtime.client.ping()["pong"])
            out = runtime.client.run_agent("你好")
            self.assertEqual(out["ran"], "你好")
            self.assertEqual(runtime.client.search_sessions("x")["count"], 0)
        finally:
            runtime.close()

    def test_drains_stderr_so_a_noisy_runtime_cannot_deadlock(self):
        # 子进程写满 stderr 管道缓冲后，若调用方不排空就会永久阻塞，而父进程还在等
        # 端口 —— 最终只剩一句无信息量的超时。200KB 远超管道缓冲，必须仍能连上。
        runtime = create_client(
            electron_path=sys.executable,
            main_js=str(ROOT / "tests" / "fake_runtime.py"),
            env={"FAKE_RUNTIME_STDERR_BYTES": "200000"},
            spawn_timeout=10,
            request_timeout=5,
        )
        try:
            self.assertTrue(runtime.client.ping()["pong"])
        finally:
            runtime.close()


if __name__ == "__main__":
    unittest.main()
