# Local receiver

Run with Python 3.10+ (standard library only):

```powershell
python receiver/chatgpt_auto_sync_receiver.py --archive-root "path/to/archive"
```

It listens on `127.0.0.1:8765` by default. `--port` and `--token` are optional. A token, when set, must be sent as `X-Local-Sync-Token`.

| Endpoint | Contract |
| --- | --- |
| `GET /ping` | Returns `{ok, archive_root, stats}`. |
| `GET /chatgpt-web/index` | Returns `{ok, source, archive_root, records, count}`. `records` is keyed by conversation ID. |
| `POST /chatgpt-web` | Accepts `{filename, conversations: [...]}` or `{filename, content: "raw JSON or JSONL"}`; returns `{ok, path}`. |
| `GET /chatgpt-web/status` | Returns `{ok, status}`. |
| `POST /chatgpt-web/status` | Accepts a partial status object; returns `{ok, status}`. |

Raw input is kept in `source/chatgpt-web/`. Repeated filenames get a numeric suffix; the receiver never overwrites an existing raw file. `state/conversation-index.json` is rebuilt from raw files on startup and index requests. Each index record has `conversation_id`, `title`, `created_at`, `updated_at`, `updated_ms`, `raw_path`, and `raw_index`, plus `project` when present. Open `raw_path` and read element `raw_index` to get that conversation from a batch.

`state/sync-status.json` has schema version `1` and these fields: `last_attempt_at`, `last_success_at`, `coverage_complete`, `checked`, `synced`, `skipped`, `queued`, `session_expired`, `rate_limited`, `last_error`, and `exporter_version`. The client supplies coverage and success semantics. Omitted fields retain their previous value, and a `null` `last_success_at` does not erase an earlier success. The receiver writes status and index via atomic replacement.

Test with `python -m unittest discover -s receiver -p 'test_*.py' -v`.

## Project inventory and request leases

`POST /chatgpt-web/projects` accepts only `{projects: [{id, name}]}` and requires the active `X-Local-Sync-Claim` lease token. IDs must match `g-p-[A-Za-z0-9-]{1,124}`; names must contain 1–500 characters without control characters. The limit is 10,000 entries and 2 MiB per request. The receiver validates the full payload before writing `projects.json` inside the archive root. Existing IDs retain their saved names; newly seen IDs are added atomically, including projects with no conversations. Missing projects are retained.

`GET /ping` advertises `project_inventory` and `sync-requests-v1` capabilities. Sync status includes `project_inventory`; this is true only when the current project's directory upload succeeds. Inventory upload failure makes `coverage_complete` false. Older request-result statuses that omit the field are accepted with `project_inventory=false`.

The receiver issues a lease through `POST /chatgpt-web/sync-lease`, or a pending request through `POST /chatgpt-web/sync-requests/claim`. Concurrent runs are rejected. Request results must carry the matching `claim_token` and complete current status; request IDs are queried through `GET /chatgpt-web/sync-requests/{request_id}`. A standalone lease is released through `POST /chatgpt-web/sync-lease/release` with `{claim_token}`. Expired claims cannot write results.
