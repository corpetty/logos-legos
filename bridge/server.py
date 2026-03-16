#!/usr/bin/env python3
"""
Logos Legos Bridge Server

A thin HTTP server that bridges the web UI to a running logoscore instance.
Wraps the `logoscore` and `lm` CLI tools, exposing them as REST endpoints.

Falls back to mock/simulation mode when logoscore is not available.

Endpoints:
  GET  /api/status          - Bridge and logoscore status
  GET  /api/modules          - List available modules with metadata and methods
  GET  /api/modules/:name    - Get a single module's details
  POST /api/execute          - Execute a single method call
  POST /api/workflow         - Execute a full workflow pipeline
  GET  /api/discover         - Trigger re-discovery of modules

Usage:
  python3 bridge/server.py [--port 8081] [--module-dir /path/to/modules] [--mock]
"""

import argparse
import json
import os
import shutil
import subprocess
import sys
import time
import traceback
from http.server import HTTPServer, BaseHTTPRequestHandler
from pathlib import Path
from urllib.parse import urlparse, parse_qs

# ── Configuration ──────────────────────────────────────────────────────────

DEFAULT_PORT = 8081
DEFAULT_MODULE_DIR = None  # Auto-detect or use --module-dir

# ── Module Discovery ───────────────────────────────────────────────────────

class ModuleDiscovery:
    """Discovers and introspects Logos Core modules via lm/logoscore CLI."""

    def __init__(self, module_dir=None, mock=False):
        self.module_dir = module_dir
        self.mock = mock
        self.modules = {}
        self._logoscore_path = shutil.which("logoscore")
        self._lm_path = shutil.which("lm")
        self._last_discovery = 0

    @property
    def has_logoscore(self):
        return self._logoscore_path is not None and not self.mock

    @property
    def has_lm(self):
        return self._lm_path is not None and not self.mock

    def status(self):
        return {
            "mode": "mock" if self.mock or not self.has_logoscore else "live",
            "logoscore": {
                "available": self.has_logoscore,
                "path": self._logoscore_path,
            },
            "lm": {
                "available": self.has_lm,
                "path": self._lm_path,
            },
            "moduleDir": self.module_dir,
            "modulesLoaded": len(self.modules),
            "lastDiscovery": self._last_discovery,
        }

    def discover(self):
        """Discover all available modules."""
        self._last_discovery = time.time()

        if self.mock or not self.has_lm:
            self.modules = self._mock_modules()
            return self.modules

        # Real discovery via lm CLI
        modules = {}
        module_dir = self.module_dir or self._find_module_dir()
        if not module_dir:
            print("[bridge] No module directory found, using mock data")
            self.modules = self._mock_modules()
            return self.modules

        module_paths = self._find_module_files(module_dir)
        for path in module_paths:
            try:
                meta = self._get_metadata(path)
                methods = self._get_methods(path)
                if meta and meta.get("name"):
                    modules[meta["name"]] = {
                        **meta,
                        "methods": methods,
                        "path": str(path),
                    }
            except Exception as e:
                print(f"[bridge] Error introspecting {path}: {e}")

        if modules:
            self.modules = modules
        else:
            print("[bridge] No modules discovered via CLI, using mock data")
            self.modules = self._mock_modules()

        return self.modules

    def _find_module_dir(self):
        """Try common locations for the module directory."""
        candidates = [
            os.environ.get("LOGOS_MODULE_DIR"),
            os.path.expanduser("~/.logos/modules"),
            "/usr/local/lib/logos/modules",
        ]
        for c in candidates:
            if c and os.path.isdir(c):
                return c
        return None

    def _find_module_files(self, module_dir):
        """Find .so/.dylib files in the module directory."""
        paths = []
        for root, _, files in os.walk(module_dir):
            for f in files:
                if f.endswith((".so", ".dylib")):
                    paths.append(os.path.join(root, f))
        return paths

    def _get_metadata(self, module_path):
        """Run `lm metadata` on a module."""
        try:
            result = subprocess.run(
                [self._lm_path, "metadata", str(module_path)],
                capture_output=True, text=True, timeout=10,
            )
            if result.returncode == 0:
                return self._parse_lm_metadata(result.stdout)
        except subprocess.TimeoutExpired:
            print(f"[bridge] Timeout getting metadata for {module_path}")
        except Exception as e:
            print(f"[bridge] Error getting metadata: {e}")
        return None

    def _get_methods(self, module_path):
        """Run `lm methods` on a module."""
        try:
            result = subprocess.run(
                [self._lm_path, "methods", str(module_path)],
                capture_output=True, text=True, timeout=10,
            )
            if result.returncode == 0:
                return self._parse_lm_methods(result.stdout)
        except subprocess.TimeoutExpired:
            print(f"[bridge] Timeout getting methods for {module_path}")
        except Exception as e:
            print(f"[bridge] Error getting methods: {e}")
        return []

    def _parse_lm_metadata(self, output):
        """Parse `lm metadata` output into a dict."""
        meta = {}
        for line in output.strip().splitlines():
            if ":" in line:
                key, _, value = line.partition(":")
                key = key.strip()
                value = value.strip()
                if key == "dependencies":
                    value = [d.strip() for d in value.strip("[]").split(",") if d.strip()]
                meta[key] = value
        return meta

    def _parse_lm_methods(self, output):
        """Parse `lm methods` output into a list of method dicts."""
        methods = []
        for line in output.strip().splitlines():
            line = line.strip()
            if not line or line.startswith("#"):
                continue
            # Expected format: methodName(param1: type1, param2: type2) -> ReturnType
            try:
                name_end = line.index("(")
                name = line[:name_end].strip()
                params_end = line.index(")")
                params_str = line[name_end + 1:params_end]
                return_type = "void"
                if "->" in line:
                    return_type = line.split("->")[-1].strip()

                inputs = []
                if params_str.strip():
                    for param in params_str.split(","):
                        param = param.strip()
                        if ":" in param:
                            pname, ptype = param.split(":", 1)
                            inputs.append({
                                "name": pname.strip(),
                                "type": ptype.strip(),
                            })

                outputs = []
                if return_type != "void":
                    outputs.append({
                        "name": "result",
                        "type": return_type,
                    })

                methods.append({
                    "name": name,
                    "inputs": inputs,
                    "outputs": outputs,
                })
            except (ValueError, IndexError):
                continue
        return methods

    def _mock_modules(self):
        """Load mock modules from the data/modules.json file."""
        mock_path = Path(__file__).parent.parent / "data" / "modules.json"
        if mock_path.exists():
            with open(mock_path) as f:
                data = json.load(f)
            modules = {}
            for mod in data.get("modules", []):
                modules[mod["name"]] = mod
            return modules
        return {}


# ── Method Execution ───────────────────────────────────────────────────────

class MethodExecutor:
    """Executes Logos Core module methods via logoscore CLI."""

    def __init__(self, discovery: ModuleDiscovery):
        self.discovery = discovery
        self._process = None

    def execute(self, module_name, method_name, params=None):
        """Execute a single method call."""
        params = params or {}

        if self.discovery.mock or not self.discovery.has_logoscore:
            return self._mock_execute(module_name, method_name, params)

        return self._live_execute(module_name, method_name, params)

    def execute_workflow(self, pipeline):
        """Execute a workflow pipeline (list of steps in order)."""
        results = []
        context = {}  # Carries data between steps

        for step in pipeline:
            module = step.get("module")
            method = step.get("method")
            params = step.get("params", {})

            # Merge context into params (for connected inputs)
            for key, source in step.get("inputBindings", {}).items():
                src_node = source.get("nodeId")
                src_output = source.get("output")
                if src_node in context and src_output in context[src_node]:
                    params[key] = context[src_node][src_output]

            result = self.execute(module, method, params)
            results.append({
                "nodeId": step.get("nodeId"),
                "module": module,
                "method": method,
                "result": result,
            })

            # Store outputs in context for downstream steps
            if result.get("success") and result.get("data"):
                context[step.get("nodeId")] = result["data"]

        return {
            "success": all(r["result"].get("success") for r in results),
            "steps": results,
        }

    def _live_execute(self, module_name, method_name, params):
        """Execute via logoscore CLI."""
        # Build the logos.<module>.<method>(params) call
        short_name = module_name.replace("logos-", "").replace("-module", "")
        param_str = ", ".join(
            f'"{v}"' if isinstance(v, str) else str(v)
            for v in params.values()
        )
        call = f"logos.{short_name}.{method_name}({param_str})"

        try:
            cmd = [self.discovery._logoscore_path]
            if self.discovery.module_dir:
                cmd.extend(["-m", self.discovery.module_dir])
            cmd.extend(["-c", call])

            result = subprocess.run(
                cmd, capture_output=True, text=True, timeout=30,
            )

            if result.returncode == 0:
                try:
                    data = json.loads(result.stdout)
                except json.JSONDecodeError:
                    data = {"raw": result.stdout.strip()}
                return {
                    "success": True,
                    "data": data,
                    "call": call,
                }
            else:
                return {
                    "success": False,
                    "error": result.stderr.strip() or f"Exit code {result.returncode}",
                    "call": call,
                }
        except subprocess.TimeoutExpired:
            return {"success": False, "error": "Execution timed out", "call": call}
        except Exception as e:
            return {"success": False, "error": str(e), "call": call}

    def _mock_execute(self, module_name, method_name, params):
        """Return simulated execution results."""
        short_name = module_name.replace("logos-", "").replace("-module", "")
        call = f"logos.{short_name}.{method_name}({json.dumps(params)})"

        # Generate plausible mock responses based on method patterns
        mock_data = self._generate_mock_response(module_name, method_name, params)

        return {
            "success": True,
            "data": mock_data,
            "call": call,
            "mock": True,
        }

    def _generate_mock_response(self, module_name, method_name, params):
        """Generate plausible mock data based on method name patterns."""
        ts = int(time.time())

        if "send" in method_name.lower():
            return {
                "messageId": f"msg_{ts}",
                "timestamp": ts,
                "status": "sent",
            }
        elif "get" in method_name.lower() and "balance" in method_name.lower():
            return {
                "address": params.get("address", "0x1234...abcd"),
                "balance": "142.5",
                "token": "LOGOS",
                "lastUpdated": ts,
            }
        elif "get" in method_name.lower() and "block" in method_name.lower():
            return {
                "blockNumber": 1847293,
                "hash": "0xabc123...def456",
                "timestamp": ts,
                "transactions": 42,
                "parentHash": "0x789012...345678",
            }
        elif "get" in method_name.lower() and "history" in method_name.lower():
            return [
                {"id": f"item_{i}", "timestamp": ts - i * 60}
                for i in range(min(int(params.get("limit", 5)), 10))
            ]
        elif "store" in method_name.lower():
            return {
                "contentId": f"cid_{ts}",
                "size": len(str(params.get("data", ""))),
                "status": "stored",
            }
        elif "list" in method_name.lower():
            return [
                {"name": f"item_{i}", "status": "active"}
                for i in range(3)
            ]
        elif "create" in method_name.lower():
            return {
                "id": f"new_{ts}",
                "created": True,
                "timestamp": ts,
            }
        elif "discover" in method_name.lower():
            return [
                {"peerId": f"peer_{i}", "capabilities": ["chat", "storage"]}
                for i in range(3)
            ]
        elif "status" in method_name.lower():
            return {
                "synced": True,
                "peers": 12,
                "blockHeight": 1847293,
                "uptime": 86400,
            }
        elif "sign" in method_name.lower():
            return {
                "signature": "0xsig_mock_abc123...",
                "signer": params.get("address", "0x1234...abcd"),
            }
        elif "connect" in method_name.lower():
            return {
                "connectionId": f"conn_{ts}",
                "status": "connected",
                "server": params.get("server", "irc.example.com"),
            }
        elif "subscribe" in method_name.lower():
            return {
                "subscriptionId": f"sub_{ts}",
                "topic": params.get("topic", "default"),
                "status": "subscribed",
            }
        elif "publish" in method_name.lower() or "relay" in method_name.lower():
            return {
                "delivered": True,
                "timestamp": ts,
            }
        elif "announce" in method_name.lower():
            return {
                "announced": True,
                "capability": params.get("capability", "unknown"),
            }
        elif "install" in method_name.lower():
            return {
                "installed": True,
                "package": params.get("packageName", "unknown"),
                "version": "0.1.0",
            }
        elif "search" in method_name.lower():
            return [
                {"name": f"logos-result-{i}", "version": "0.1.0"}
                for i in range(3)
            ]
        elif "authenticate" in method_name.lower():
            return {
                "token": f"tok_{ts}",
                "expiresIn": 3600,
            }
        else:
            return {"status": "ok", "timestamp": ts}


# ── HTTP Handler ───────────────────────────────────────────────────────────

class BridgeHandler(BaseHTTPRequestHandler):
    """HTTP request handler for the bridge API."""

    discovery: ModuleDiscovery = None
    executor: MethodExecutor = None
    frontend_origin: str = "http://localhost:8080"

    def do_OPTIONS(self):
        self.send_response(204)
        self._cors_headers()
        self.end_headers()

    def do_GET(self):
        path = urlparse(self.path).path

        if path == "/api/status":
            self._json_response(self.discovery.status())

        elif path == "/api/modules":
            if not self.discovery.modules:
                self.discovery.discover()
            # Return as array for frontend compatibility
            modules = list(self.discovery.modules.values())
            self._json_response({"modules": modules, "mode": self.discovery.status()["mode"]})

        elif path.startswith("/api/modules/"):
            name = path[len("/api/modules/"):]
            mod = self.discovery.modules.get(name)
            if mod:
                self._json_response(mod)
            else:
                self._json_response({"error": f"Module '{name}' not found"}, 404)

        elif path == "/api/discover":
            self.discovery.discover()
            self._json_response({
                "discovered": len(self.discovery.modules),
                "modules": list(self.discovery.modules.keys()),
            })

        else:
            self._json_response({"error": "Not found"}, 404)

    def do_POST(self):
        path = urlparse(self.path).path
        body = self._read_body()

        if path == "/api/execute":
            module = body.get("module")
            method = body.get("method")
            params = body.get("params", {})
            if not module or not method:
                self._json_response({"error": "module and method required"}, 400)
                return
            result = self.executor.execute(module, method, params)
            self._json_response(result)

        elif path == "/api/workflow":
            pipeline = body.get("pipeline", [])
            if not pipeline:
                self._json_response({"error": "pipeline required"}, 400)
                return
            result = self.executor.execute_workflow(pipeline)
            self._json_response(result)

        else:
            self._json_response({"error": "Not found"}, 404)

    def _read_body(self):
        length = int(self.headers.get("Content-Length", 0))
        if length == 0:
            return {}
        raw = self.rfile.read(length)
        try:
            return json.loads(raw)
        except json.JSONDecodeError:
            return {}

    def _json_response(self, data, status=200):
        self.send_response(status)
        self._cors_headers()
        self.send_header("Content-Type", "application/json")
        self.end_headers()
        self.wfile.write(json.dumps(data, indent=2).encode())

    def _cors_headers(self):
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")

    def log_message(self, format, *args):
        print(f"[bridge] {args[0]}" if args else "")


# ── Main ───────────────────────────────────────────────────────────────────

def main():
    parser = argparse.ArgumentParser(description="Logos Legos Bridge Server")
    parser.add_argument("--port", type=int, default=DEFAULT_PORT, help="Server port")
    parser.add_argument("--module-dir", type=str, default=None, help="Path to Logos modules directory")
    parser.add_argument("--mock", action="store_true", help="Force mock mode (no CLI calls)")
    args = parser.parse_args()

    discovery = ModuleDiscovery(module_dir=args.module_dir, mock=args.mock)
    executor = MethodExecutor(discovery)

    # Initial discovery
    print(f"[bridge] Discovering modules...")
    discovery.discover()
    status = discovery.status()
    print(f"[bridge] Mode: {status['mode']}")
    print(f"[bridge] logoscore: {'found at ' + status['logoscore']['path'] if status['logoscore']['available'] else 'not found'}")
    print(f"[bridge] lm: {'found at ' + status['lm']['path'] if status['lm']['available'] else 'not found'}")
    print(f"[bridge] Modules loaded: {status['modulesLoaded']}")

    # Set handler class attributes
    BridgeHandler.discovery = discovery
    BridgeHandler.executor = executor

    server = HTTPServer(("0.0.0.0", args.port), BridgeHandler)
    print(f"[bridge] Listening on http://localhost:{args.port}")
    print(f"[bridge] API docs: GET /api/status, GET /api/modules, POST /api/execute, POST /api/workflow")

    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\n[bridge] Shutting down")
        server.shutdown()


if __name__ == "__main__":
    main()
