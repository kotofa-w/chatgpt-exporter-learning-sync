"""Small black-box check for the local receiver's data contract."""

import json
from pathlib import Path
import shutil
from threading import Thread
import unittest
from uuid import uuid4
from urllib.error import HTTPError
from urllib.request import Request, urlopen

from chatgpt_auto_sync_receiver import make_server

SCRIPT = Path(__file__).with_name("chatgpt_auto_sync_receiver.py")


class ReceiverTest(unittest.TestCase):
    def setUp(self):
        self.root = SCRIPT.parent / f"test-archive-{uuid4().hex}"
        self.root.mkdir()
        self.start_receiver()

    def tearDown(self):
        self.stop_receiver()
        shutil.rmtree(self.root)

    def start_receiver(self):
        self.server = make_server(self.root, port=0)
        self.port = self.server.server_port
        self.thread = Thread(target=self.server.serve_forever)
        self.thread.start()

    def stop_receiver(self):
        self.server.shutdown()
        self.thread.join(timeout=5)
        self.server.server_close()

    def request(self, method, path, data=None, origin=None):
        body = None if data is None else json.dumps(data, ensure_ascii=False).encode("utf-8")
        req = Request(f"http://127.0.0.1:{self.port}{path}", body, method=method)
        if body is not None:
            req.add_header("Content-Type", "application/json")
        if origin is not None:
            req.add_header("Origin", origin)
        try:
            with urlopen(req, timeout=3) as response:
                return response.status, json.load(response)
        except HTTPError as error:
            return error.code, json.load(error)

    def test_archive_status_and_restart(self):
        self.assertEqual(self.request("GET", "/ping")[0], 200)
        self.assertEqual(self.request("GET", "/chatgpt-web/index")[1]["count"], 0)
        raw = '{"id":"abc","title":"原题","create_time":"2026-01-01T00:00:00Z","update_time":"2026-01-02T00:00:00Z","unknown":{"keep":true}}'
        for _ in range(2):
            status, reply = self.request("POST", "/chatgpt-web", {"filename": "same.json", "content": raw})
            self.assertEqual(status, 200)
            self.assertEqual(Path(reply["path"]).read_text(encoding="utf-8"), raw)
        paths = list((self.root / "source" / "chatgpt-web").glob("*.json"))
        self.assertEqual(len(paths), 2)
        index = self.request("GET", "/chatgpt-web/index")[1]
        self.assertEqual(index["records"]["abc"]["title"], "原题")
        self.assertEqual(index["records"]["abc"]["updated_ms"], 1767312000000)
        self.assertEqual(index["records"]["abc"]["raw_index"], 0)
        self.assertEqual(json.loads((self.root / "state" / "conversation-index.json").read_text(encoding="utf-8"))["abc"]["conversation_id"], "abc")

        state = {"last_attempt_at": "2026-01-02T01:00:00Z", "last_success_at": "2026-01-02T01:00:00Z", "coverage_complete": True, "checked": 1, "synced": 1, "skipped": 0, "queued": 0, "session_expired": False, "rate_limited": False, "last_error": None, "exporter_version": "test"}
        self.assertEqual(self.request("POST", "/chatgpt-web/status", state)[0], 200)
        self.assertEqual(self.request("POST", "/chatgpt-web/status", {"coverage_complete": False, "last_success_at": None})[1]["status"]["last_success_at"], state["last_success_at"])
        self.assertEqual(self.request("GET", "/chatgpt-web/status")[1]["status"]["coverage_complete"], False)

        self.stop_receiver()
        (self.root / "state" / "conversation-index.json").unlink()
        self.start_receiver()
        self.assertEqual(self.request("GET", "/chatgpt-web/index")[1]["count"], 1)
        self.assertEqual(self.request("GET", "/chatgpt-web/status")[1]["status"]["last_success_at"], state["last_success_at"])

    def test_bad_input_does_not_write_raw(self):
        self.assertEqual(self.request("POST", "/chatgpt-web", {"conversations": [{"id": "x"}]}, "https://example.com")[0], 401)
        for payload in ({}, {"content": "{broken"}, {"conversations": "wrong"}, {"conversations": [42]}):
            self.assertEqual(self.request("POST", "/chatgpt-web", payload)[0], 400)
        self.assertEqual(self.request("POST", "/chatgpt-web/status", {"checked": -1})[0], 400)
        self.assertEqual(self.request("GET", "/chatgpt-web/index")[1]["count"], 0)
        self.assertEqual(list((self.root / "source" / "chatgpt-web").iterdir()), [])


if __name__ == "__main__":
    unittest.main()
