# ChatGPT Exporter Learning Sync

基于 [ChatGPT Exporter](https://github.com/pionxzh/chatgpt-exporter) 的本地增量归档分支，为学习笔记和会话复盘提供可追溯的完整会话原文。

仓库：[kotofa-w/chatgpt-exporter-learning-sync](https://github.com/kotofa-w/chatgpt-exporter-learning-sync)。

| 分支 | 当前内容 |
| --- | --- |
| `master`（默认分支） | Exporter 的 Text、Markdown、HTML、PNG、JSON 导出；没有本地同步入口和 `receiver/`。 |
| [`feature/learning-os-auto-sync`](https://github.com/kotofa-w/chatgpt-exporter-learning-sync/tree/feature/learning-os-auto-sync) | 在导出功能上增加浏览器增量同步、Python 接收端、项目目录和主动同步请求。 |

**下文快速开始和同步说明均针对 `feature/learning-os-auto-sync`**，执行接收端命令前先切换到该分支。只需手动导出时可使用 `master`。

## 同步分支功能

- 每轮从第一页枚举 ChatGPT 主会话列表与 Projects，按会话 ID 去重，受下述扫描额度限制。
- 项目 ID 和名称写入 `projects.json`，包含空项目；已有同 ID 名称不会被自动覆盖。
- 与本地索引比较更新时间，只下载新增或更新的完整会话 JSON。
- 原始批次文件不覆盖；索引指向每个会话最新归档版本。
- 支持 `Sync Now`、定时同步和失败批次重试；默认自动同步间隔为 60 分钟，需在设置中启用。
- 保存同步状态，供下游检查本轮是否完整；支持通过接收端创建主动同步请求。

本项目负责归档原文，不自动生成 Obsidian 笔记，也不内置 GitHub 云备份；总结、去重写作和备份由下游任务实现。

## 快速开始

### 1. 获取并构建本项目

建议使用 **Node.js 24**（与当前 CI 一致）和 **pnpm 8.14.1**；本地同步另需 Python 3.10+，接收端只使用 Python 标准库。`package.json` 虽声明 Node.js `>=20.0.0`，但当前锁定的 Vitest 5 要求 Node.js `^22.12.0 || ^24.0.0 || >=26.0.0`，lint-staged 17 要求 `>=22.22.1`，不能将任意 Node.js 20 视为完整开发环境。

```powershell
git clone --branch feature/learning-os-auto-sync https://github.com/kotofa-w/chatgpt-exporter-learning-sync.git
cd chatgpt-exporter-learning-sync
pnpm --version # 应为 8.14.1
pnpm install --frozen-lockfile
pnpm build
```

### 2. 安装 userscript

1. 在浏览器安装 [Tampermonkey](https://www.tampermonkey.net/)。按浏览器要求启用 [Allow User Scripts](https://www.tampermonkey.net/faq.php?q=Q209)。
2. 点击 Tampermonkey 图标 → **管理面板 / Dashboard** → **实用工具 / Utilities** → **从文件导入 / Import from file**，选择本项目构建出的 `dist/chatgpt.user.js`，确认安装。
3. 打开并登录 [ChatGPT](https://chatgpt.com/)，刷新页面，确认出现 Exporter / 导出助手。

请安装本仓库构建产物；上游 GreasyFork 安装包不包含这里的本地同步功能。若已有旧版 Exporter，避免同时启用多个版本。

### 3. 启动本地接收端

在项目根目录运行并保持该进程运行：

```powershell
python receiver/chatgpt_auto_sync_receiver.py --archive-root "$HOME\AI Chat History"
```

默认监听 `127.0.0.1:8765`，归档目录可自行指定。另开终端检查：

```powershell
Invoke-RestMethod http://127.0.0.1:8765/ping
```

返回 `ok: true` 表示接收端可用。浏览器默认连接 `http://127.0.0.1:8765/chatgpt-web`，设置界面没有端口或 token 输入项。当前 userscript 不发送 `X-Local-Sync-Token`；使用上述命令保持默认端口且不传 `--token`，仅修改接收端端口或启用 token 会导致默认脚本无法同步。启动命令不会安装开机服务，重启后需重新启动。

### 4. 执行同步

在 ChatGPT 页面打开 **Exporter / 导出助手 → Settings / 设置**，点击 **Sync Now**，等待同步结束。需要周期同步时启用 **Enable Auto Sync** 并调整间隔，设置会随修改保存。

浏览器必须保持已登录的 ChatGPT 标签页打开，接收端也必须运行。下游定时任务应主动触发本轮同步并等待结果，不能只依赖此前的 60 分钟同步状态。

## 归档结构与完整性

```text
AI Chat History/
├── projects.json               # 项目目录，包含空项目；保留已有名称
├── source/chatgpt-web/          # 完整会话 JSON 批次，保留历史版本
└── state/
    ├── conversation-index.json # 按会话 ID 保存最新原文位置
    ├── sync-status.json         # 最近同步结果
    └── sync-requests.json       # 主动同步请求及执行状态
```

索引记录中的 `raw_path` 指向原文文件，`raw_index` 指向批次内的会话；读取后应核对会话 ID。完整字段与接口见 [本地同步说明](https://github.com/kotofa-w/chatgpt-exporter-learning-sync/blob/feature/learning-os-auto-sync/README_LOCAL_SYNC.md) 和 [接收端说明](https://github.com/kotofa-w/chatgpt-exporter-learning-sync/blob/feature/learning-os-auto-sync/receiver/README.md)。

下游读取前至少检查：

- `last_attempt_at` 不早于本轮启动时间，`last_success_at` 不早于该次 attempt。
- `coverage_complete=true`、`project_inventory=true`、`queued=0`、`last_error=null`，对应原文存在且可读。

部分失败也可能已保存原文，不能把“有文件”当成完整同步成功。覆盖标记仅表示本轮主列表与 Projects 枚举及所需原文归档完成，不保证 Archived、Shared 或 Codex/Work 会话全量。当前一轮主列表与 Projects 共享最多 5000 个去重会话的额度，按主列表、各 Project 的顺序扫描；达到上限时会保守标记不完整，即使列表恰好有 5000 条也可能如此。此额度独立于手动导出的 Export All Limit 设置。归档保存 API 返回的会话对象，不保证附件二进制文件已下载。

## 常见问题

- **找不到管理面板**：打开浏览器扩展菜单，点击 Tampermonkey，再选择 Dashboard；导出助手的设置位于 ChatGPT 页面内。
- **页面没有导出助手**：确认安装的是本仓库脚本、脚本已启用、浏览器允许 userscript，随后刷新 ChatGPT。
- **接收端无法连接**：检查进程是否仍运行，以及 `/ping` 是否返回成功。
- **会话未完整同步**：查看 `last_error`、登录状态、限流与待发送队列；修复后再次运行同步。

## 开发与检查

以下完整命令在同步分支执行；`master` 只执行前三条，没有 `receiver/` 测试。

```powershell
pnpm test
pnpm lint
pnpm build
python -m unittest discover -s receiver -p 'test_*.py' -v
```

自动化测试使用合成 API 响应；真实浏览器同步需要已登录的 ChatGPT 页面。

`pnpm test` 包含 TypeScript 类型检查和 Vitest。当前 Check workflow 监听各分支 push 与面向 `master` 的 pull request，在非 `chore: release` 提交上运行 lint/test；它不执行 build 或 Python 接收端测试。Release workflow 仅在 push 提交消息包含 `chore: release` 时执行 lint/test/build。因此开发同步分支时仍需手动执行上面的 build 和 Python 检查。

## 来源与许可证

基于 [pionxzh/chatgpt-exporter](https://github.com/pionxzh/chatgpt-exporter) 与 [mubaiblake/chatgpt-exporter-auto-sync](https://github.com/mubaiblake/chatgpt-exporter-auto-sync)，保留原作者归属与 [MIT License](LICENSE)。上游贡献说明见 [CONTRIBUTING.md](CONTRIBUTING.md)。
