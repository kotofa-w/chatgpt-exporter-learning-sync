#!/usr/bin/env python3
"""Local receiver for ChatGPT Exporter Auto Sync.

The userscript sends official ChatGPT conversation JSON batches to this
localhost server. The receiver saves those source files and exposes a small
index so the userscript can skip conversations that already exist locally.
"""

from __future__ import annotations

import argparse
from datetime import datetime, timedelta, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import os
from pathlib import Path
import re
import secrets
import tempfile
from threading import Lock
from typing import Any, Iterable
from urllib.parse import urlparse
from uuid import uuid4


DEFAULT_ARCHIVE_ROOT = Path.home() / "AI Chat History"
DEFAULT_HOST = "127.0.0.1"
DEFAULT_PORT = 8765
SOURCE = "chatgpt-web"
ALLOWED_ORIGINS = {"https://chatgpt.com", "https://chat.openai.com"}
MAX_REQUEST_BYTES = 100 * 1024 * 1024
STATUS_DEFAULTS: dict[str, Any] = {
    "schema_version": 1,
    "last_attempt_at": None,
    "last_success_at": None,
    "coverage_complete": False,
    "checked": 0,
    "synced": 0,
    "skipped": 0,
    "queued": 0,
    "session_expired": False,
    "rate_limited": False,
    "last_error": None,
    "exporter_version": None,
    "project_inventory": False,
}


def utc_stamp() -> str:
    return datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")


def iso_now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z")


def parse_datetime(value: Any) -> datetime | None:
    if value is None:
        return None
    if isinstance(value, (int, float)):
        try:
            return datetime.fromtimestamp(float(value), tz=timezone.utc)
        except (OSError, OverflowError, ValueError):
            return None
    if not isinstance(value, str):
        return None
    normalized = value.strip()
    if not normalized:
        return None
    if normalized.endswith("Z"):
        normalized = normalized[:-1] + "+00:00"
    try:
        parsed = datetime.fromisoformat(normalized)
    except ValueError:
        return None
    if parsed.tzinfo is None:
        return parsed.replace(tzinfo=timezone.utc)
    return parsed.astimezone(timezone.utc)


def format_datetime(value: Any) -> str | None:
    parsed = parse_datetime(value)
    if not parsed:
        return None
    return parsed.isoformat(timespec="seconds").replace("+00:00", "Z")


def timestamp_ms(value: Any) -> int:
    parsed = parse_datetime(value)
    return int(parsed.timestamp() * 1000) if parsed else 0


def sanitize_filename(filename: str) -> str:
    name = Path(filename or "").name
    name = re.sub(r"[^A-Za-z0-9._ -]+", "-", name).strip(" .-")
    if not name:
        name = f"chatgpt-auto-sync-{utc_stamp()}.json"
    if Path(name).suffix.lower() not in {".json", ".jsonl"}:
        name += ".json"
    return name


def unique_path(path: Path) -> Path:
    if not path.exists():
        return path
    for index in range(2, 10000):
        candidate = path.with_name(f"{path.stem}-{index}{path.suffix}")
        if not candidate.exists():
            return candidate
    raise RuntimeError(f"could not find a free filename near {path}")


def read_json_or_jsonl(path: Path) -> list[Any]:
    raw = path.read_text(encoding="utf-8")
    if not raw.strip():
        return []
    try:
        parsed = json.loads(raw)
    except json.JSONDecodeError:
        rows: list[Any] = []
        for line_number, line in enumerate(raw.splitlines(), start=1):
            stripped = line.strip()
            if not stripped:
                continue
            try:
                rows.append(json.loads(stripped))
            except json.JSONDecodeError as exc:
                raise ValueError(f"{path}:{line_number}: invalid JSONL record: {exc}") from exc
        return rows
    return parsed if isinstance(parsed, list) else [parsed]


def iter_files(root: Path, suffixes: set[str]) -> Iterable[Path]:
    if not root.exists():
        return
    for candidate in sorted(root.rglob("*")):
        if candidate.is_file() and candidate.suffix.lower() in suffixes:
            yield candidate


def ensure_dirs(archive_root: Path) -> None:
    (archive_root / "source" / SOURCE).mkdir(parents=True, exist_ok=True)
    (archive_root / "state").mkdir(parents=True, exist_ok=True)
    (archive_root / "logs").mkdir(parents=True, exist_ok=True)


def record_from_raw(raw: dict[str, Any], raw_path: Path, raw_index: int) -> tuple[str, dict[str, Any]] | None:
    conversation_id = raw.get("id") or raw.get("conversation_id")
    if not isinstance(conversation_id, str) or not conversation_id:
        return None
    updated_at = format_datetime(raw.get("update_time") or raw.get("updated_at") or raw.get("modified_at"))
    created_at = format_datetime(raw.get("create_time") or raw.get("created_at"))
    record = {
        "conversation_id": conversation_id,
        "title": raw.get("title") if isinstance(raw.get("title"), str) else "",
        "created_at": created_at,
        "updated_at": updated_at or created_at,
        "updated_ms": timestamp_ms(updated_at or created_at),
        "raw_path": str(raw_path),
        "raw_index": raw_index,
    }
    project = raw.get("project") or raw.get("project_id")
    if project is not None:
        record["project"] = project
    return conversation_id, record


def build_index(archive_root: Path) -> dict[str, dict[str, Any]]:
    records: dict[str, dict[str, Any]] = {}
    for path in iter_files(archive_root / "source" / SOURCE, {".json", ".jsonl"}):
        try:
            rows = read_json_or_jsonl(path)
        except Exception:
            continue
        for raw_index, row in enumerate(rows):
            if not isinstance(row, dict):
                continue
            record = record_from_raw(row, path, raw_index)
            if not record:
                continue
            conversation_id, raw_record = record
            existing = records.get(conversation_id)
            if not existing or int(raw_record.get("updated_ms") or 0) >= int(existing.get("updated_ms") or 0):
                records[conversation_id] = raw_record
    return records


def atomic_json(path: Path, value: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temp_path: Path | None = None
    try:
        with tempfile.NamedTemporaryFile("w", encoding="utf-8", dir=path.parent, prefix=f".{path.name}.", suffix=".tmp", delete=False) as temp:
            temp_path = Path(temp.name)
            json.dump(value, temp, ensure_ascii=False, indent=2)
            temp.write("\n")
            temp.flush()
            os.fsync(temp.fileno())
        os.replace(temp_path, path)
    finally:
        if temp_path is not None:
            temp_path.unlink(missing_ok=True)


def read_status(path: Path) -> dict[str, Any]:
    if not path.exists():
        return STATUS_DEFAULTS.copy()
    saved = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(saved, dict):
        raise ValueError("sync-status.json must be an object")
    return {**STATUS_DEFAULTS, **{key: saved[key] for key in STATUS_DEFAULTS if key in saved}}


def validate_status(incoming: dict[str, Any]) -> None:
    unknown = set(incoming) - STATUS_DEFAULTS.keys()
    if unknown:
        raise ValueError(f"unknown status fields: {', '.join(sorted(unknown))}")
    for key in ("checked", "synced", "skipped", "queued"):
        if key in incoming and (type(incoming[key]) is not int or incoming[key] < 0):
            raise ValueError(f"{key} must be a non-negative integer")
    for key in ("coverage_complete", "session_expired", "rate_limited", "project_inventory"):
        if key in incoming and type(incoming[key]) is not bool:
            raise ValueError(f"{key} must be a boolean")
    for key in ("last_attempt_at", "last_success_at", "last_error", "exporter_version"):
        if key in incoming and incoming[key] is not None and not isinstance(incoming[key], str):
            raise ValueError(f"{key} must be a string or null")
    if "schema_version" in incoming and (type(incoming["schema_version"]) is not int or incoming["schema_version"] != 1):
        raise ValueError("unsupported schema_version")
def update_status(path: Path, incoming: dict[str, Any]) -> dict[str, Any]:
    validate_status(incoming)
    status = read_status(path)
    status.update({key: value for key, value in incoming.items() if key != "last_success_at" or value is not None})
    atomic_json(path, status)
    return status


def validate_projects(projects: Any) -> dict[str, dict[str, str]]:
    if not isinstance(projects, list) or len(projects) > 10000:
        raise ValueError("projects must be an array of at most 10000 entries")
    records = {}
    for project in projects:
        if not isinstance(project, dict) or set(project) != {"id", "name"}:
            raise ValueError("each project must contain only id and name")
        project_id, name = project["id"], project["name"]
        if not isinstance(project_id, str) or not re.fullmatch(r"g-p-[A-Za-z0-9-]{1,124}", project_id):
            raise ValueError("invalid project id")
        if not isinstance(name, str) or not 1 <= len(name.strip()) <= 500 or len(name) > 500 or any(ord(char) < 32 for char in name):
            raise ValueError("invalid project name")
        if project_id in records:
            raise ValueError("duplicate project id")
        records[project_id] = project
    return records


def save_projects(path: Path, payload: dict[str, Any]) -> int:
    if set(payload) != {"projects"}:
        raise ValueError("project inventory payload must contain only projects")
    incoming = validate_projects(payload["projects"])
    saved = json.loads(path.read_text(encoding="utf-8")) if path.exists() else {"projects": []}
    if not isinstance(saved, dict) or "projects" not in saved:
        raise ValueError("invalid saved project inventory")
    records = validate_projects(saved["projects"])
    for project_id, project in incoming.items():
        records.setdefault(project_id, project)
    atomic_json(path, {"projects": list(records.values()), "updated_at": iso_now()})
    return len(records)


def write_payload(archive_root: Path, payload: dict[str, Any]) -> Path:
    ensure_dirs(archive_root)
    filename = sanitize_filename(str(payload.get("filename") or ""))
    if "content" in payload:
        content = payload["content"]
        text = content if isinstance(content, str) else json.dumps(content, ensure_ascii=False)
        rows = read_json_or_jsonl_text(text)
    elif "conversations" in payload:
        if not isinstance(payload["conversations"], list):
            raise ValueError("conversations must be an array")
        rows = payload["conversations"]
        text = json.dumps(payload["conversations"], ensure_ascii=False)
    else:
        raise ValueError("payload must include content or conversations")
    if not rows or not all(isinstance(row, dict) for row in rows):
        raise ValueError("conversation content must contain JSON objects")
    target = unique_path(archive_root / "source" / SOURCE / filename)
    atomic_text(target, text)
    return target


def read_json_or_jsonl_text(raw: str) -> list[Any]:
    if not raw.strip():
        return []
    try:
        parsed = json.loads(raw)
    except json.JSONDecodeError:
        return [json.loads(line) for line in raw.splitlines() if line.strip()]
    return parsed if isinstance(parsed, list) else [parsed]


def atomic_text(path: Path, text: str) -> None:
    temp_path: Path | None = None
    try:
        with tempfile.NamedTemporaryFile("w", encoding="utf-8", dir=path.parent, prefix=f".{path.name}.", suffix=".tmp", delete=False) as temp:
            temp_path = Path(temp.name)
            temp.write(text)
            temp.flush()
            os.fsync(temp.fileno())
        os.link(temp_path, path)
    finally:
        if temp_path is not None:
            temp_path.unlink(missing_ok=True)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Receive ChatGPT web JSON batches from the auto-sync userscript.")
    parser.add_argument("--archive-root", type=Path, default=DEFAULT_ARCHIVE_ROOT, help="Folder where source/state/logs are stored.")
    parser.add_argument("--host", default=DEFAULT_HOST, help="Host to bind. Keep 127.0.0.1 for local-only use.")
    parser.add_argument("--port", type=int, default=DEFAULT_PORT, help="Port to listen on.")
    parser.add_argument("--token", default="", help="Optional shared secret required in X-Local-Sync-Token.")
    return parser.parse_args()


def make_server(archive_root: Path, host: str = DEFAULT_HOST, port: int = DEFAULT_PORT, token: str = "") -> ThreadingHTTPServer:
    archive_root = archive_root.expanduser().resolve()
    ensure_dirs(archive_root)
    state_dir = archive_root / "state"
    index_path = state_dir / "conversation-index.json"
    status_path = state_dir / "sync-status.json"
    lock = Lock()
    requests_path = state_dir / "sync-requests.json"
    # ponytail: retain request history; prune terminal records if request volume warrants it.
    bridge = json.loads(requests_path.read_text(encoding="utf-8")) if requests_path.exists() else {"requests": {}, "lease": None}

    def expire_requests() -> None:
        now = datetime.now(timezone.utc)
        changed = False
        for request in bridge["requests"].values():
            if request["state"] in {"pending", "running"} and parse_datetime(request["deadline_at"]) <= now:
                request.update(state="expired", completed_at=iso_now(), error="sync request deadline exceeded")
                changed = True
        if bridge["lease"] and parse_datetime(bridge["lease"]["deadline_at"]) <= now:
            bridge["lease"] = None
            changed = True
        if changed:
            atomic_json(requests_path, bridge)

    def deadline(payload: dict[str, Any], default: int = 300) -> str:
        seconds = payload.get("timeout_seconds", default)
        if type(seconds) is not int or not 5 <= seconds <= 1800:
            raise ValueError("timeout_seconds must be an integer from 5 to 1800")
        return (datetime.now(timezone.utc) + timedelta(seconds=seconds)).isoformat(timespec="milliseconds").replace("+00:00", "Z")

    def public_request(request: dict[str, Any]) -> dict[str, Any]:
        return {key: value for key, value in request.items() if key != "claim_token"}
    atomic_json(index_path, build_index(archive_root))
    if not status_path.exists():
        atomic_json(status_path, STATUS_DEFAULTS)
    stats: dict[str, Any] = {
        "started_at": iso_now(),
        "received_files": 0,
        "received_conversations": 0,
        "errors": 0,
        "last_received_at": None,
        "last_path": None,
    }

    class Receiver(BaseHTTPRequestHandler):
        server_version = "ChatGPTAutoSyncReceiver/1.0"

        def end_headers(self) -> None:
            if self.headers.get("Origin") in ALLOWED_ORIGINS:
                self.send_header("Access-Control-Allow-Origin", self.headers["Origin"])
                self.send_header("Vary", "Origin")
                self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
                self.send_header("Access-Control-Allow-Headers", "Content-Type, X-Local-Sync-Token, X-Local-Sync-Claim")
                self.send_header("Access-Control-Allow-Private-Network", "true")
            super().end_headers()

        def authorized(self) -> bool:
            if self.headers.get("Origin") and self.headers["Origin"] not in ALLOWED_ORIGINS:
                return False
            if not token:
                return True
            return secrets.compare_digest(self.headers.get("X-Local-Sync-Token", ""), token)

        def send_json(self, status: int, payload: dict[str, Any]) -> None:
            body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
            self.send_response(status)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def read_payload(self) -> dict[str, Any]:
            try:
                length = int(self.headers.get("Content-Length", ""))
            except ValueError as exc:
                raise ValueError("invalid Content-Length") from exc
            limit = 2 * 1024 * 1024 if urlparse(self.path).path == "/chatgpt-web/projects" else MAX_REQUEST_BYTES
            if length <= 0 or length > limit:
                raise ValueError("invalid Content-Length")
            payload = json.loads(self.rfile.read(length).decode("utf-8"))
            if not isinstance(payload, dict):
                raise ValueError("payload must be a JSON object")
            return payload

        def do_OPTIONS(self) -> None:
            self.send_response(204 if self.authorized() else 403)
            self.end_headers()

        def do_GET(self) -> None:
            if not self.authorized():
                self.send_json(401, {"ok": False, "error": "unauthorized"})
                return
            path = urlparse(self.path).path
            if path == "/ping":
                self.send_json(200, {"ok": True, "archive_root": str(archive_root), "stats": stats, "capabilities": ["sync-requests-v1", "project_inventory"]})
                return
            if path == "/chatgpt-web/index":
                with lock:
                    records = build_index(archive_root)
                    atomic_json(index_path, records)
                self.send_json(200, {
                    "ok": True,
                    "source": SOURCE,
                    "archive_root": str(archive_root),
                    "records": records,
                    "count": len(records),
                })
                return
            if path.startswith("/chatgpt-web/sync-requests/"):
                with lock:
                    expire_requests()
                    request = bridge["requests"].get(path.rsplit("/", 1)[-1])
                    response = {"ok": True, "request": public_request(request)} if request else {"ok": False, "error": "unknown request"}
                self.send_json(200 if request else 404, response)
                return
            if path == "/chatgpt-web/status":
                with lock:
                    status = read_status(status_path)
                self.send_json(200, {"ok": True, "status": status})
                return
            self.send_json(404, {"ok": False, "error": "unknown endpoint"})

        def do_POST(self) -> None:
            if not self.authorized():
                stats["errors"] += 1
                self.send_json(401, {"ok": False, "error": "unauthorized"})
                return
            path = urlparse(self.path).path
            if path not in {"/chatgpt-web", "/chatgpt-web/projects", "/chatgpt-web/status", "/chatgpt-web/sync-requests", "/chatgpt-web/sync-requests/claim", "/chatgpt-web/sync-lease", "/chatgpt-web/sync-lease/release"} and not (path.startswith("/chatgpt-web/sync-requests/") and path.endswith("/result")):
                self.send_json(404, {"ok": False, "error": "unknown endpoint"})
                return
            try:
                payload = self.read_payload()
                with lock:
                    expire_requests()
                    lease = bridge["lease"]
                    if path == "/chatgpt-web/sync-requests":
                        request = {"request_id": str(uuid4()), "state": "pending", "created_at": iso_now(), "deadline_at": deadline(payload), "claimed_at": None, "completed_at": None, "status": None, "error": None}
                        bridge["requests"][request["request_id"]] = request
                        atomic_json(requests_path, bridge)
                        response = {"ok": True, "request": public_request(request)}
                    elif path == "/chatgpt-web/sync-requests/claim":
                        request = None if lease else next((item for item in bridge["requests"].values() if item["state"] == "pending"), None)
                        if request:
                            request.update(state="running", claimed_at=iso_now(), claim_token=secrets.token_hex(24))
                            bridge["lease"] = {"claim_token": request["claim_token"], "deadline_at": request["deadline_at"], "request_id": request["request_id"]}
                            atomic_json(requests_path, bridge)
                        response = {"ok": True, "request": dict(request) if request else None}
                    elif path == "/chatgpt-web/sync-lease":
                        if lease:
                            self.send_json(409, {"ok": False, "error": "another sync is running"})
                            return
                        bridge["lease"] = {"claim_token": secrets.token_hex(24), "deadline_at": deadline(payload, 1800), "request_id": None}
                        atomic_json(requests_path, bridge)
                        response = {"ok": True, "lease": bridge["lease"]}
                    elif path == "/chatgpt-web/sync-lease/release":
                        if not lease or lease["request_id"] is not None or payload.get("claim_token") != lease["claim_token"]:
                            self.send_json(409, {"ok": False, "error": "stale sync lease"})
                            return
                        bridge["lease"] = None
                        atomic_json(requests_path, bridge)
                        response = {"ok": True}
                    elif path.endswith("/result"):
                        request = bridge["requests"].get(path.split("/")[-2])
                        if not request:
                            self.send_json(404, {"ok": False, "error": "unknown request"})
                            return
                        if request["state"] != "running" or not lease or lease["request_id"] != request["request_id"] or payload.get("claim_token") != lease["claim_token"]:
                            self.send_json(409, {"ok": False, "error": "stale sync result"})
                            return
                        status = payload.get("status")
                        error = payload.get("error")
                        if error is not None and not isinstance(error, str):
                            raise ValueError("error must be a string or null")
                        if status is not None:
                            if isinstance(status, dict):
                                status = {"project_inventory": False, **status}
                            if not isinstance(status, dict) or set(status) != set(STATUS_DEFAULTS):
                                raise ValueError("result must contain a complete sync status")
                            validate_status(status)
                            attempt = parse_datetime(status["last_attempt_at"])
                            success = parse_datetime(status["last_success_at"])
                            claimed = parse_datetime(request["claimed_at"])
                            now = datetime.now(timezone.utc) + timedelta(seconds=2)
                            if not attempt or attempt < claimed or attempt > now:
                                raise ValueError("result status predates this claim")
                            if status["coverage_complete"] and (not success or success < attempt or success > now or status["session_expired"] or status["queued"] or status["last_error"]):
                                raise ValueError("inconsistent successful sync status")
                        elif not error:
                            raise ValueError("result requires status or error")
                        succeeded = status is not None and status["coverage_complete"] and not error
                        request.update(state="succeeded" if succeeded else "failed", completed_at=iso_now(), status=status, error=error or (status["last_error"] if status else None))
                        bridge["lease"] = None
                        atomic_json(requests_path, bridge)
                        response = {"ok": True, "request": public_request(request)}
                    elif path in {"/chatgpt-web", "/chatgpt-web/status", "/chatgpt-web/projects"} and ((lease and self.headers.get("X-Local-Sync-Claim") != lease["claim_token"]) or (not lease and (self.headers.get("X-Local-Sync-Claim") or path == "/chatgpt-web/projects"))):
                        self.send_json(409, {"ok": False, "error": "stale or missing sync lease"})
                        return
                    elif path == "/chatgpt-web/projects":
                        response = {"ok": True, "count": save_projects(archive_root / "projects.json", payload)}
                    elif path == "/chatgpt-web/status":
                        status = update_status(status_path, payload)
                        response = {"ok": True, "status": status}
                    else:
                        target = write_payload(archive_root, payload)
                        atomic_json(index_path, build_index(archive_root))
                        conversations = payload.get("conversations") or read_json_or_jsonl(target)
                        stats["received_files"] += 1
                        stats["received_conversations"] += len(conversations) if isinstance(conversations, list) else 0
                        stats["last_received_at"] = iso_now()
                        stats["last_path"] = str(target)
                        response = {"ok": True, "path": str(target)}
                self.send_json(200, response)
            except (ValueError, UnicodeError) as exc:
                stats["errors"] += 1
                self.send_json(400, {"ok": False, "error": str(exc)})
            except OSError as exc:
                stats["errors"] += 1
                self.send_json(500, {"ok": False, "error": str(exc)})

        def log_message(self, fmt: str, *args: Any) -> None:
            print(f"[receiver] {self.address_string()} - {fmt % args}", flush=True)

    return ThreadingHTTPServer((host, port), Receiver)


def main() -> int:
    args = parse_args()
    server = make_server(args.archive_root, args.host, args.port, args.token)
    print(f"Receiving ChatGPT JSON at http://{args.host}:{server.server_port}/chatgpt-web", flush=True)
    print(f"Archive root: {args.archive_root.expanduser().resolve()}", flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("Stopped receiver.", flush=True)
    finally:
        server.server_close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
