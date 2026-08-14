# CLAUDE.md — claude-history-viewer

浏览 `~/.claude/projects/` 下 Claude 对话历史的单文件 Web 服务。带登录鉴权，经反代公网访问。

## 硬约束

- **零依赖**：只用 Node 标准库，**不要引入任何 npm 包**（含 better-sqlite3、express 等）。
  需要"数据库"时用 JSON 文件（见「索引」），不要为此破例。
- **无构建步骤**：`server.js` + `app.js` 直接跑，改完 `pm2 restart` 即可。

## 架构

- `server.js` — 后端全部逻辑 + 内嵌整页 HTML/CSS（`HTML` 常量）。HTTP 手写路由。
- `app.js` — 前端 JS，由 `/app.js` 路由原样吐出；含**手写的轻量 Markdown 渲染器**
  （`md()`/`mdBlocks()`/`mdInline()`/表格），不依赖任何前端库。
  URL 带 `?v=<app.js mtime>`，改前端不用清缓存。
- 数据文件（均 gitignore，自动生成，勿入库）：
  - `config.json` — 服务配置（扫描根、排除、端口等）；缺省全走默认值
  - `secret.json` — HMAC 密钥 + 登录密码（chmod 600）
  - `favorites.json` — 收藏与备注
  - `index.json` — 列表/搜索索引（见下）

## 关键约定

- **环境变量始终优先于 config.json**（`PORT`/`HOST`/`COOKIE_PATH`/`SECURE_COOKIE`/
  `VIEWER_PASSWORD`/`CLAUDE_PROJECTS_DIR`/`CODEX_SESSIONS_DIR`/`CONFIG_PATH`/`INDEX_PATH`）。
- **多根扫描**：`roots` 可配多个；同名 项目/会话 在多根并存时**先配置的根优先**。
- **排除**：`exclude` 按项目目录名做 glob（`*` `?`）匹配，命中的项目既不列出、API 也拒绝
  （对 codex 按 cwd 推导出的项目名同样生效）。

## codex 数据源（Claude / Codex 两页独立）

- **数据源适配器 `SOURCES`**：claude / codex 的差异（scan / locate / stamp / parse /
  listable / remove / key）全部收敛在这张表里，`refreshIndex` / `loadSession` /
  `deleteSession` 主流程与源无关；**再接别的 agent CLI = 加一个对象**，主流程不动。
  同理前端工具渲染是注册表 `TOOL_VIEWS`（对象 input）+ `STR_TOOL_VIEWS`（字符串 input），
  加新工具的展示 = 调一次 `reg()`。
- 所有涉及会话的 API 都带 `src` 参数（`claude` 默认 / `codex`）；前端 `SRC` 全局 + 页签切换，
  列表 / 搜索 / 统计 / 收藏互不混。分享 token 里 codex 会话带 `sr` 字段，跨源冒充会被拒。
- `codexRoots`（默认 `~/.codex/sessions`，目录存在即启用，`"codex": false` 可强关）：
  `YYYY/MM/DD/rollout-<时间>-<uuid>.jsonl`，**id 里带日期，可直接推出文件路径**（`codexFile()`）。
- `parseCodexSession()` 的坑：
  - 正文只取 `response_item`（`event_msg` 的 user_message/agent_message 与之**重复**，
    只用其中的 `token_count.last_token_usage` 记用量；`input_tokens` 含缓存读，要拆开）；
  - 思考在 `reasoning.summary[]`（`content` 是加密的）；模型名来自 `turn_context`；
  - `custom_tool_call` 的 `input` 是**字符串**（apply_patch 补丁 / exec 脚本），前端 `toolView`
    对字符串 input 单独处理；
  - 环境包裹（`<environment_context>`、`# AGENTS.md instructions` 等）标 `isMeta` 隐藏，
    见 `CODEX_META_RE`；续接注入的 `The following is the Codex agent history` 整段标
    `compact` 折叠；`thread_source === 'subagent'`（guardian 审批评估等）整个会话不进索引。
- 索引键：claude 仍是 `project/<id>`（老 index.json 有效），codex 用 `codex:<id>`；
  codex 无项目目录，项目名由 cwd 编码（`codexProject()`，与前端 `encCwd` 同款）。
- 会话标题优先取 `~/.codex/session_index.jsonl` 的 thread_name，缺省用首条用户消息。

## tmux 桥接（网页控制台）

- 默认关闭；config.json `"tmux": true` 或 `TMUX_UI=1` 开启（不叫 TMUX：tmux 会注入同名变量）。
- 思路是「翻译层」而非裸终端：`capture-pane` 抓屏 → `paneState()` 解析出交互状态
  （`menu` 编号选项菜单 / `busy` 干活中 / `idle` 空闲 / `unknown`）→ 前端渲染成原生控件
  （选项按钮、聊天输入框）→ UI 操作经 `send-keys` 翻译成按键注回 CLI。裸终端画面是兜底视图。
- 路由：`GET /api/tmux`（窗格列表）、`GET /api/tmux/pane?t=%N[&lite=1]`（抓屏+状态）、
  `POST /api/tmux/send`（注入；文本走 `-l` 字面量，具名键过 `TMUX_KEYS` 白名单）、
  `POST /api/tmux/new`（新建会话：会话名过白名单、cwd 必须是已存在目录；启动命令会
  包一层 `; exec $SHELL`，命令退出后落回 shell 而不是会话消失）、`POST /api/tmux/kill`（关窗格）、
  `POST /api/tmux/resize`（`resize-window -x` 调窗口列宽；手机开裸终端时前端自动按屏宽收窄，
  桌面不自动动、有「适配屏宽」按钮手动触发；本地终端想恢复自适应用 `resize-window -A`）。
- 会话视图底部 `#composer` 控制条：按 cwd / 项目名匹配到 tmux 窗格才显示（优先 claude 进程）。
- 解析的坑（都有测试兜着）：tmux 会把 `-F` 输出里的控制字符转成八进制字面量，
  分隔符用可打印的 `␟`；选项块下方常有提示行/状态栏，不能要求菜单贴底；
  输入提示符可能是 `>` 也可能是 `❯`；菜单必须「序号 1 起连续 + 有 ❯ 光标」才算，防误认正文列表。

## 安全（改动时务必保持）

- 前端所有拼进 innerHTML 的动态文本都过 `esc()`/`hi()` 转义；新增渲染同样处理。
- 后端 `project`/`id` 一律过 `NAME_RE`（`^[A-Za-z0-9._-]+$`）白名单，防路径穿越。
- 密码与 token 用 `crypto.timingSafeEqual` 常数时间比较；登录限速 + 指数退避 + 固定延时。
- 分享 token 带会话作用域（`sp`/`si`），`isAuthed` 拒绝它冒充登录会话。
- tmux 桥接 = 远程命令执行：所有 `/api/tmux*` 路由都在 `if (!authed)` 之后（不接受分享 token）、
  受 `TMUX_UI` 开关控制；pane 目标过 `PANE_RE`（`^%\d+$`），具名键过白名单，文本长度设上限。

## 缓存与索引（按需加载 + 惰性释放）

- `cache`：全量会话（含消息体）LRU，上限 `CACHE_MAX`；只在**打开会话 / 搜索命中候选**时填充。
- `INDEX`（→ `index.json`，version 2）：**摘要**索引（无消息体），常驻内存，列表 / 统计只碰它。
- `BLOBS`（→ `index.blobs.json`）：搜索用的**正文/思考 blob**（大）。**惰性读盘、闲置 `BLOB_TTL_MS` 后释放内存**。
  - 平时只看历史 **不载入 blob**；只有搜索才 `ensureBlobs()` 读盘，之后 `releaseBlobs()` 定时释放。
  - `blobFor()` 自愈：blob 缺失或 stamp 与摘要不符，就解析该会话重建。
  - 失效键 `cacheStamp(mtime，含子代理文件)`；`refreshIndex()` 增量刷新摘要（**不碰 blob**，除非已载入）。
  - 搜索：先用 blob 粗筛（全词命中才算候选），**只有候选才 `loadSession` 全量解析**算精确命中数与片段。
  - 落盘走 3s 防抖 + 退出 flush；改了 `parseSession` / `summary` 结构后删掉这两个文件重建。

## 删除会话

- `deleteSession()`：`fs.unlinkSync` 删 `.jsonl` + `fs.rmSync` 删 `<id>/subagents` 目录，并清 cache/INDEX/BLOBS/FAVS。
- **不可恢复**。`POST /api/delete` 仅登录可用（`if (!authed)` 之后），**不接受分享 token**；前端二次 `confirm`。

## Android 壳子（`android/`）

- 极简 WebView 壳，**独立子项目**：纯 Android SDK + Java，不引第三方库；
  零依赖约束只管 `server.js`/`app.js`，与壳子互不影响。
- 本机没有 Android SDK，**构建只在 GitHub Actions 上做**（`.github/workflows/android.yml`）：
  打 `v*` tag 自动出 APK 挂 Release，或手动 Run workflow 取 artifact。
- 服务器地址存 SharedPreferences，首次启动进 `SetupActivity` 填写；
  长按返回键 / 桌面长按图标快捷方式可再改。壳内拦截 `app://settings`、`app://reload`。
- 签名：secrets 配了 `KEYSTORE_BASE64` 等四项就用固定签名，否则退回 debug 签名。

## 运行 / 调试

```bash
# 生产（pm2 常驻）
COOKIE_PATH=/history/ SECURE_COOKIE=1 pm2 start server.js --name claude-history
pm2 restart claude-history      # 改代码后

# 本地 http 调试（cookie 去掉 Secure、放开 Path）
SECURE_COOKIE=0 COOKIE_PATH=/ PORT=48999 node server.js
```

## 测试

```bash
node --test        # test/ 下的 node:test 用例（纯函数 + parseSession + 索引）
```

`server.js` 被 require 时不启动服务器（`require.main === module` 守卫），可直接测其导出函数。

## 术语（继承 codexDir 全局约定）

- "笔记" / "记录一下" = 创建或更新文件，不是更新 agent 记忆。有歧义先问。
