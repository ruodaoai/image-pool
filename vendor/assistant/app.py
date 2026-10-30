from __future__ import annotations

import argparse
import json
import os
import re
import secrets
import shutil
import socket
import subprocess
import sys
import threading
import time
import traceback
import urllib.error
import urllib.request
import uuid
from datetime import datetime
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any
from urllib.parse import parse_qs, urlparse


APP_ROOT = Path(__file__).resolve().parent
WEB_ROOT = APP_ROOT / "web"
CSRF_TOKEN = secrets.token_urlsafe(32)
JOBS: dict[str, dict[str, Any]] = {}
JOBS_LOCK = threading.Lock()
REPO_URL = "https://github.com/yang0/fpbrowser2api.git"


def json_bytes(value: Any) -> bytes:
    return json.dumps(value, ensure_ascii=False).encode("utf-8")


def now_text() -> str:
    return datetime.now().strftime("%H:%M:%S")


def append_job(job_id: str, message: str) -> None:
    with JOBS_LOCK:
        job = JOBS.get(job_id)
        if not job:
            return
        job["logs"].append(f"[{now_text()}] {message.rstrip()}")
        job["logs"] = job["logs"][-500:]


def set_job(job_id: str, **values: Any) -> None:
    with JOBS_LOCK:
        if job_id in JOBS:
            JOBS[job_id].update(values)


def create_job(kind: str) -> str:
    job_id = uuid.uuid4().hex
    with JOBS_LOCK:
        JOBS[job_id] = {
            "id": job_id,
            "kind": kind,
            "status": "running",
            "logs": [],
            "created_at": time.time(),
        }
    return job_id


def run_logged(job_id: str, command: list[str], cwd: Path | None = None, env: dict[str, str] | None = None) -> None:
    display = " ".join(command)
    append_job(job_id, f"执行：{display}")
    process = subprocess.Popen(
        command,
        cwd=str(cwd) if cwd else None,
        env=env,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        text=True,
        encoding="utf-8",
        errors="replace",
        creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
    )
    assert process.stdout is not None
    for line in process.stdout:
        append_job(job_id, line)
    code = process.wait()
    if code != 0:
        raise RuntimeError(f"命令执行失败，退出代码 {code}：{display}")


def normalize_install_dir(raw: str) -> Path:
    raw = (raw or "").strip().strip('"')
    if not raw:
        raise ValueError("请填写安装目录")
    path = Path(raw).expanduser()
    if not path.is_absolute():
        raise ValueError("安装目录必须是绝对路径，例如 C:\\AI\\fpbrowser2api")
    return path.resolve()


def install_worker(job_id: str, install_dir: Path, branch: str) -> None:
    try:
        git_bin = shutil.which("git")
        python_bin = sys.executable
        if not git_bin:
            raise RuntimeError("未找到 Git，请先安装 Git for Windows")
        if not python_bin or not Path(python_bin).exists():
            raise RuntimeError("未找到 Python，请先安装 Python 3.11 或更高版本")

        if (install_dir / "main.py").exists():
            append_job(job_id, f"检测到现有项目，跳过下载：{install_dir}")
        else:
            if install_dir.exists() and any(install_dir.iterdir()):
                raise RuntimeError("安装目录已存在且非空，请换一个空目录")
            install_dir.parent.mkdir(parents=True, exist_ok=True)
            clone_command = [git_bin, "clone", "--depth", "1"]
            if branch:
                clone_command += ["--branch", branch]
            clone_command += [REPO_URL, str(install_dir)]
            run_logged(job_id, clone_command)

        venv_python = install_dir / ".venv" / "Scripts" / "python.exe"
        if not venv_python.exists():
            run_logged(job_id, [python_bin, "-m", "venv", ".venv"], cwd=install_dir)
        else:
            append_job(job_id, "检测到现有 .venv，跳过创建虚拟环境")

        run_logged(job_id, [str(venv_python), "-m", "pip", "install", "--upgrade", "pip"], cwd=install_dir)
        run_logged(job_id, [str(venv_python), "-m", "pip", "install", "-r", "requirements.txt"], cwd=install_dir)
        append_job(job_id, "依赖安装完成")
        set_job(job_id, status="completed", result={"install_dir": str(install_dir)})
    except Exception as exc:
        append_job(job_id, f"失败：{exc}")
        set_job(job_id, status="failed", error=str(exc))


def toml_literal(value: Any) -> str:
    if isinstance(value, bool):
        return "true" if value else "false"
    if isinstance(value, int):
        return str(value)
    return json.dumps(str(value), ensure_ascii=False)


def upsert_toml(text: str, section: str, key: str, value: Any) -> str:
    lines = text.splitlines()
    section_header = f"[{section}]"
    section_index = next((i for i, line in enumerate(lines) if line.strip() == section_header), None)
    new_line = f"{key} = {toml_literal(value)}"
    if section_index is None:
        if lines and lines[-1].strip():
            lines.append("")
        lines.extend([section_header, new_line])
        return "\n".join(lines) + "\n"

    end_index = len(lines)
    for index in range(section_index + 1, len(lines)):
        if re.match(r"^\s*\[[^]]+\]\s*$", lines[index]):
            end_index = index
            break
    key_pattern = re.compile(rf"^\s*{re.escape(key)}\s*=")
    for index in range(section_index + 1, end_index):
        if key_pattern.match(lines[index]):
            lines[index] = new_line
            return "\n".join(lines) + "\n"
    lines.insert(end_index, new_line)
    return "\n".join(lines) + "\n"


def configure_project(payload: dict[str, Any]) -> dict[str, Any]:
    install_dir = normalize_install_dir(str(payload.get("install_dir", "")))
    if not (install_dir / "main.py").exists():
        raise ValueError("安装目录中没有 main.py，请先完成安装")
    config_dir = install_dir / "config"
    config_path = config_dir / "setting.toml"
    example_path = config_dir / "setting_example.toml"
    config_dir.mkdir(parents=True, exist_ok=True)
    if config_path.exists():
        text = config_path.read_text(encoding="utf-8")
        backup = config_path.with_name(f"setting.toml.bak-{datetime.now().strftime('%Y%m%d-%H%M%S')}")
        shutil.copy2(config_path, backup)
    elif example_path.exists():
        text = example_path.read_text(encoding="utf-8")
        backup = None
    else:
        text = ""
        backup = None

    port = int(payload.get("port", 8000))
    if not 1024 <= port <= 65535:
        raise ValueError("端口必须在 1024–65535 之间")
    admin_username = str(payload.get("admin_username", "admin")).strip() or "admin"
    admin_password = str(payload.get("admin_password", ""))
    api_key = str(payload.get("api_key", ""))
    bridge_token = str(payload.get("bridge_token", ""))
    if len(admin_password) < 10:
        raise ValueError("后台密码至少 10 个字符")
    if len(api_key) < 20 or len(bridge_token) < 20:
        raise ValueError("API Key 和 Bridge Token 至少 20 个字符")

    values = {
        ("server", "host"): "127.0.0.1",
        ("server", "port"): port,
        ("global", "admin_username"): admin_username,
        ("global", "admin_password"): admin_password,
        ("global", "api_key"): api_key,
        ("system", "proxy_enabled"): bool(payload.get("proxy_enabled", False)),
        ("system", "proxy_url"): str(payload.get("proxy_url", "")).strip(),
        ("system", "debug_enabled"): True,
        ("system", "log_to_file"): True,
        ("extension_executor", "enabled"): True,
        ("extension_executor", "base_url"): f"127.0.0.1:{port}",
        ("extension_executor", "bridge_token"): bridge_token,
        ("extension_executor", "task_timeout_seconds"): 1800,
    }
    for (section, key), value in values.items():
        text = upsert_toml(text, section, key, value)
    config_path.write_text(text, encoding="utf-8")
    return {
        "ok": True,
        "config_path": str(config_path),
        "backup_path": str(backup) if backup else None,
        "port": port,
    }


def probe_port(host: str, port: int, timeout: float = 0.6) -> bool:
    try:
        with socket.create_connection((host, port), timeout=timeout):
            return True
    except OSError:
        return False


def request_json(url: str, method: str = "GET", headers: dict[str, str] | None = None, body: Any = None, timeout: int = 12) -> Any:
    data = json_bytes(body) if body is not None else None
    request_headers = {"Accept": "application/json", **(headers or {})}
    if body is not None:
        request_headers["Content-Type"] = "application/json"
    request = urllib.request.Request(url, data=data, headers=request_headers, method=method)
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            raw = response.read().decode("utf-8", errors="replace")
            return json.loads(raw) if raw.strip() else {"ok": True, "status": response.status}
    except urllib.error.HTTPError as exc:
        raw = exc.read().decode("utf-8", errors="replace")
        try:
            detail = json.loads(raw)
        except json.JSONDecodeError:
            detail = raw[:1000]
        raise RuntimeError(f"HTTP {exc.code}: {detail}") from exc
    except urllib.error.URLError as exc:
        raise RuntimeError(f"无法连接 {url}：{exc.reason}") from exc


def service_action(payload: dict[str, Any]) -> dict[str, Any]:
    install_dir = normalize_install_dir(str(payload.get("install_dir", "")))
    action = str(payload.get("action", "status"))
    if action not in {"start", "stop", "restart", "status"}:
        raise ValueError("不支持的服务操作")
    script_path = install_dir / "fpbrowser2api_service.ps1"
    venv_python = install_dir / ".venv" / "Scripts" / "python.exe"
    if not script_path.exists():
        raise ValueError("找不到 fpbrowser2api_service.ps1")
    if not venv_python.exists():
        raise ValueError("找不到虚拟环境 Python，请先安装依赖")
    env = os.environ.copy()
    env["PYTHON_BIN"] = str(venv_python)
    result = subprocess.run(
        ["powershell", "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", str(script_path), action],
        cwd=str(install_dir),
        env=env,
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
        timeout=45,
        creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
    )
    output = (result.stdout + "\n" + result.stderr).strip()
    if result.returncode != 0:
        raise RuntimeError(output or f"服务操作失败，退出代码 {result.returncode}")
    return {"ok": True, "action": action, "output": output}


def detect(payload: dict[str, Any]) -> dict[str, Any]:
    install_dir_raw = str(payload.get("install_dir", "")).strip()
    install_dir = Path(install_dir_raw).expanduser() if install_dir_raw else None
    fpb_url = str(payload.get("fpb_url", "http://127.0.0.1:8000")).rstrip("/")
    vb_url = str(payload.get("vb_url", "http://127.0.0.1:9000")).rstrip("/")

    def url_port(value: str, fallback: int) -> int:
        try:
            parsed = urlparse(value)
            return parsed.port or fallback
        except ValueError:
            return fallback

    return {
        "python": sys.executable if Path(sys.executable).exists() else None,
        "git": shutil.which("git"),
        "project": bool(install_dir and (install_dir / "main.py").exists()),
        "venv": bool(install_dir and (install_dir / ".venv" / "Scripts" / "python.exe").exists()),
        "config": bool(install_dir and (install_dir / "config" / "setting.toml").exists()),
        "fpb_port_open": probe_port("127.0.0.1", url_port(fpb_url, 8000)),
        "vb_port_open": probe_port("127.0.0.1", url_port(vb_url, 9000)),
        "fpb_url": fpb_url,
        "vb_url": vb_url,
    }


class Handler(BaseHTTPRequestHandler):
    server_version = "FPBSetupAssistant/1.0"

    def log_message(self, format: str, *args: Any) -> None:
        print(f"[{now_text()}] {self.address_string()} {format % args}")

    def send_json(self, status: int, value: Any) -> None:
        payload = json_bytes(value)
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(payload)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(payload)

    def send_file(self, path: Path, content_type: str) -> None:
        if not path.exists() or not path.is_file():
            self.send_error(404)
            return
        payload = path.read_bytes()
        if path.name == "index.html":
            payload = payload.replace(b"__CSRF_TOKEN__", CSRF_TOKEN.encode("ascii"))
        self.send_response(200)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(payload)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("X-Frame-Options", "DENY")
        self.end_headers()
        self.wfile.write(payload)

    def read_json(self) -> dict[str, Any]:
        length = int(self.headers.get("Content-Length", "0") or 0)
        if length > 1_000_000:
            raise ValueError("请求内容过大")
        raw = self.rfile.read(length) if length else b"{}"
        parsed = json.loads(raw.decode("utf-8"))
        if not isinstance(parsed, dict):
            raise ValueError("请求必须是 JSON 对象")
        return parsed

    def authorized(self) -> bool:
        return secrets.compare_digest(self.headers.get("X-Setup-Token", ""), CSRF_TOKEN)

    def do_GET(self) -> None:
        parsed = urlparse(self.path)
        if parsed.path == "/":
            self.send_file(WEB_ROOT / "index.html", "text/html; charset=utf-8")
            return
        if parsed.path == "/styles.css":
            self.send_file(WEB_ROOT / "styles.css", "text/css; charset=utf-8")
            return
        if parsed.path == "/app.js":
            self.send_file(WEB_ROOT / "app.js", "application/javascript; charset=utf-8")
            return
        if parsed.path == "/api/health":
            self.send_json(200, {"ok": True, "time": datetime.now().isoformat(timespec="seconds")})
            return
        if parsed.path.startswith("/api/jobs/"):
            job_id = parsed.path.rsplit("/", 1)[-1]
            with JOBS_LOCK:
                job = JOBS.get(job_id)
                snapshot = dict(job) if job else None
            if snapshot:
                self.send_json(200, snapshot)
            else:
                self.send_json(404, {"error": "任务不存在"})
            return
        self.send_error(404)

    def do_POST(self) -> None:
        if not self.authorized():
            self.send_json(403, {"error": "本地会话令牌无效，请刷新页面"})
            return
        try:
            payload = self.read_json()
            path = urlparse(self.path).path
            if path == "/api/detect":
                result = detect(payload)
            elif path == "/api/secrets":
                result = {
                    "admin_password": secrets.token_urlsafe(18),
                    "api_key": secrets.token_urlsafe(32),
                    "bridge_token": secrets.token_urlsafe(32),
                }
            elif path == "/api/install":
                install_dir = normalize_install_dir(str(payload.get("install_dir", "")))
                branch = str(payload.get("branch", "github")).strip()
                job_id = create_job("install")
                threading.Thread(target=install_worker, args=(job_id, install_dir, branch), daemon=True).start()
                result = {"ok": True, "job_id": job_id}
            elif path == "/api/configure":
                result = configure_project(payload)
            elif path == "/api/service":
                result = service_action(payload)
            elif path == "/api/test/virtualbrowser":
                vb_url = str(payload.get("vb_url", "")).rstrip("/")
                vb_key = str(payload.get("vb_key", ""))
                result = request_json(f"{vb_url}/api/getBrowserList", headers={"api-key": vb_key})
            elif path == "/api/test/fpbrowser":
                fpb_url = str(payload.get("fpb_url", "")).rstrip("/")
                api_key = str(payload.get("api_key", ""))
                result = request_json(f"{fpb_url}/v1/models", headers={"Authorization": f"Bearer {api_key}"})
            elif path == "/api/tasks/submit":
                fpb_url = str(payload.get("fpb_url", "")).rstrip("/")
                api_key = str(payload.get("api_key", ""))
                task_body = {
                    "model": str(payload.get("model", "gpt-image2-2k")),
                    "prompt": str(payload.get("prompt", "")),
                    "aspect_ratio": str(payload.get("aspect_ratio", "1:1")),
                }
                if not task_body["prompt"].strip():
                    raise ValueError("请填写图片提示词")
                result = request_json(
                    f"{fpb_url}/v1/videos",
                    method="POST",
                    headers={"Authorization": f"Bearer {api_key}"},
                    body=task_body,
                    timeout=45,
                )
            elif path == "/api/tasks/status":
                fpb_url = str(payload.get("fpb_url", "")).rstrip("/")
                api_key = str(payload.get("api_key", ""))
                task_id = str(payload.get("task_id", "")).strip()
                if not task_id:
                    raise ValueError("请填写任务 ID")
                result = request_json(
                    f"{fpb_url}/v1/videos/{task_id}",
                    headers={"Authorization": f"Bearer {api_key}"},
                    timeout=30,
                )
            else:
                self.send_error(404)
                return
            self.send_json(200, result)
        except Exception as exc:
            print(traceback.format_exc())
            self.send_json(400, {"error": str(exc)})


def main() -> None:
    parser = argparse.ArgumentParser(description="FPBrowser2API 本地搭建助手")
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", default=8765, type=int)
    args = parser.parse_args()
    if args.host not in {"127.0.0.1", "localhost"}:
        raise SystemExit("为安全起见，本工具只允许绑定 127.0.0.1")
    server = ThreadingHTTPServer(("127.0.0.1", args.port), Handler)
    print(f"FPBrowser 搭建助手已启动：http://127.0.0.1:{args.port}")
    print("按 Ctrl+C 停止工具。")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
