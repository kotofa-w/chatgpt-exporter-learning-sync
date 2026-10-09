# ChatGPT Exporter Learning Sync

基于 [ChatGPT Exporter](https://github.com/pionxzh/chatgpt-exporter) 的本地增量归档分支，为学习笔记和会话复盘提供可追溯的完整会话原文。

仓库：[kotofa-w/chatgpt-exporter-learning-sync](https://github.com/kotofa-w/chatgpt-exporter-learning-sync)。同步功能位于 [`feature/learning-os-auto-sync`](https://github.com/kotofa-w/chatgpt-exporter-learning-sync/tree/feature/learning-os-auto-sync) 分支，默认 `master` 保留上游代码。保留上游的 Text、Markdown、HTML、PNG、JSON 导出功能，并增加浏览器同步与 Python 本地接收端。

## 功能

- 每轮从第一页枚举 ChatGPT 主会话列表与所有 Projects，按会话 ID 去重。
- 与本地索引比较更新时间，只下载新增或更新的完整会话 JSON。
- 原始批次文件不覆盖；索引指向每个会话最新归档版本。
- 支持 `Sync Now`、定时同步和失败批次重试；默认自动同步间隔为 60 分钟，需在设置中启用。
- 保存同步状态，供下游检查本轮是否完整。

本项目负责归档原文，不自动生成 Obsidian 笔记，也不内置 GitHub 云备份；总结、去重写作和备份由下游任务实现。

## 快速开始

### 1. 获取并构建本项目

需要 Node.js 20+、pnpm（项目指定版本为 8.14.1）和 Python 3.10+。接收端只使用 Python 标准库。

```powershell
git clone --branch feature/learning-os-auto-sync https://github.com/kotofa-w/chatgpt-exporter-learning-sync.git
cd chatgpt-exporter-learning-sync
pnpm install
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

返回 `ok: true` 表示接收端可用。默认浏览器同步地址固定为该端口；不要仅修改接收端端口。启动命令不会安装开机服务，重启后需重新启动。

### 4. 执行同步

在 ChatGPT 页面打开 **Exporter / 导出助手 → Settings / 设置**，点击 **Sync Now**，等待同步结束。需要周期同步时启用 **Enable Auto Sync** 并保存间隔。

浏览器必须保持已登录的 ChatGPT 标签页打开，接收端也必须运行。下游定时任务应主动触发本轮同步并等待结果，不能只依赖此前的 60 分钟同步状态。

## 归档结构与完整性

```text
AI Chat History/
├── source/chatgpt-web/          # 完整会话 JSON 批次，保留历史版本
└── state/
    ├── conversation-index.json # 按会话 ID 保存最新原文位置
    └── sync-status.json        # 最近同步结果
```

索引记录中的 `raw_path` 指向原文文件，`raw_index` 指向批次内的会话；读取后应核对会话 ID。完整字段与接口见 [本地同步说明](https://github.com/kotofa-w/chatgpt-exporter-learning-sync/blob/feature/learning-os-auto-sync/README_LOCAL_SYNC.md) 和 [接收端说明](https://github.com/kotofa-w/chatgpt-exporter-learning-sync/blob/feature/learning-os-auto-sync/receiver/README.md)。

下游读取前至少检查：

- `last_attempt_at` 不早于本轮启动时间，`last_success_at` 不早于该次 attempt。
- `coverage_complete=true`、`queued=0`、`last_error=null`，对应原文存在且可读。

部分失败也可能已保存原文，不能把“有文件”当成完整同步成功。覆盖标记仅表示本轮主列表与 Projects 枚举及所需原文归档完成，不保证 Archived、Shared 或 Codex/Work 会话全量。当前每个列表扫描上限为 5000；触及上限且还有下一页时会标记不完整。归档保存 API 返回的会话对象，不保证附件二进制文件已下载。

## 常见问题

- **找不到管理面板**：打开浏览器扩展菜单，点击 Tampermonkey，再选择 Dashboard；导出助手的设置位于 ChatGPT 页面内。
- **页面没有导出助手**：确认安装的是本仓库脚本、脚本已启用、浏览器允许 userscript，随后刷新 ChatGPT。
- **接收端无法连接**：检查进程是否仍运行，以及 `/ping` 是否返回成功。
- **会话未完整同步**：查看 `last_error`、登录状态、限流与待发送队列；修复后再次运行同步。

## 开发与检查

```powershell
pnpm test
pnpm lint
pnpm build
python -m unittest discover -s receiver -p 'test_*.py' -v
```

自动化测试使用合成 API 响应；真实浏览器同步需要已登录的 ChatGPT 页面。

## 来源与许可证

基于 [pionxzh/chatgpt-exporter](https://github.com/pionxzh/chatgpt-exporter) 与 [mubaiblake/chatgpt-exporter-auto-sync](https://github.com/mubaiblake/chatgpt-exporter-auto-sync)，保留原作者归属与 [MIT License](LICENSE)。上游贡献说明见 [CONTRIBUTING.md](CONTRIBUTING.md)。
