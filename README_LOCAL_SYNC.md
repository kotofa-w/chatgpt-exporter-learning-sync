# ChatGPT local auto sync

This branch adds incremental local archiving to the upstream userscript. Build with `pnpm build`, install `dist/chatgpt.user.js` in Tampermonkey, and keep a signed-in ChatGPT tab open. In Exporter Settings, enable Auto Sync, choose the interval, or use Sync Now.

Run the standard-library receiver separately:

```powershell
python receiver/chatgpt_auto_sync_receiver.py --archive-root "path/to/archive"
```

The receiver binds `127.0.0.1:8765` by default. See [receiver/README.md](receiver/README.md) for endpoints and optional arguments. The userscript only connects to this local address. The receiver must be running when queued batches are retried.

## Data contract

- `source/chatgpt-web/*.json`: complete conversation objects returned by ChatGPT, saved without dropping unknown fields. Existing raw files are never overwritten.
- `state/conversation-index.json`: latest archived version by conversation ID. Each record has `conversation_id`, `title`, `created_at`, `updated_at`, `updated_ms`, `raw_path`, and `raw_index`; open `raw_path` and select element `raw_index` to read that conversation from a batch. `project` is present when supplied in the raw conversation. The receiver can rebuild the index from raw files.
- `state/sync-status.json`: schema version 1, `last_attempt_at`, `last_success_at`, `coverage_complete`, `checked`, `synced`, `skipped`, `queued`, `session_expired`, `rate_limited`, `last_error`, and `exporter_version`.

`coverage_complete` is true only when the main and Project inventories finish, no cap or pagination error occurs, all required conversations are archived, and no payload remains queued. `last_success_at` advances only for that result. A partial run can still save raw conversations. Downstream jobs should check `coverage_complete` before treating the local archive as complete.

Sync uses the main list and every Project list, deduplicates by ID, and compares remote update times with the receiver index. Failed receiver deliveries stay in the userscript retry queue and are sent on the next run. A live ChatGPT login is required for the browser-side smoke test; automated tests use synthetic API responses.

## Project inventory and request leases

`POST /chatgpt-web/projects` accepts only `{projects: [{id, name}]}` and requires the active `X-Local-Sync-Claim` lease token. IDs must match `g-p-[A-Za-z0-9-]{1,124}`; names must contain 1–500 characters without control characters. The limit is 10,000 entries and 2 MiB per request. The receiver validates the full payload before writing `projects.json` inside the archive root. Existing IDs retain their saved names; newly seen IDs are added atomically, including projects with no conversations. Missing projects are retained.

`GET /ping` advertises `project_inventory` and `sync-requests-v1` capabilities. Sync status includes `project_inventory`; this is true only when the current project's directory upload succeeds. Inventory upload failure makes `coverage_complete` false. Older request-result statuses that omit the field are accepted with `project_inventory=false`.

The receiver issues a lease through `POST /chatgpt-web/sync-lease`, or a pending request through `POST /chatgpt-web/sync-requests/claim`. Concurrent runs are rejected. Request results must carry the matching `claim_token` and complete current status; request IDs are queried through `GET /chatgpt-web/sync-requests/{request_id}`. A standalone lease is released through `POST /chatgpt-web/sync-lease/release` with `{claim_token}`. Expired claims cannot write results.
