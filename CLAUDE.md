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
  `VIEWER_PASSWORD`/`CLAUDE_PROJECTS_DIR`/`CONFIG_PATH`/`INDEX_PATH`）。
- **多根扫描**：`roots` 可配多个；同名 项目/会话 在多根并存时**先配置的根优先**。
- **排除**：`exclude` 按项目目录名做 glob（`*` `?`）匹配，命中的项目既不列出、API 也拒绝。

## tmux 桥接（网页控制台）

- 默认关闭；config.json `"tmux": true` 或 `TMUX_UI=1` 开启（不叫 TMUX：tmux 会注入同名变量）。
- 思路是「翻译层」而非裸终端：`capture-pane` 抓屏 → `paneState()` 解析出交互状态
  （`menu` 编号选项菜单 / `busy` 干活中 / `idle` 空闲 / `unknown`）→ 前端渲染成原生控件
  （选项按钮、聊天输入框）→ UI 操作经 `send-keys` 翻译成按键注回 CLI。裸终端画面是兜底视图。
- 路由：`GET /api/tmux`（窗格列表）、`GET /api/tmux/pane?t=%N[&lite=1]`（抓屏+状态）、
  `POST /api/tmux/send`（注入；文本走 `-l` 字面量，具名键过 `TMUX_KEYS` 白名单）、
  `POST /api/tmux/new`（新建会话：会话名过白名单、cwd 必须是已存在目录；启动命令会
  包一层 `; exec $SHELL`，命令退出后落回 shell 而不是会话消失）、`POST /api/tmux/kill`（关窗格）。
- 会话视图底部 `#composer` 控制条：按 cwd / 项目名匹配到 tmux 窗格才显示（优先 claude 进程）。
- 解析的坑（都有测试兜着）：tmux 会把 `-F` 输出里的控制字符转成八进制字面量，
  分隔符用可打印的 `␟`；选项块下方常有提示行/状态栏，不能要求菜单贴底；
  输入提示符可能是 `>` 也可能是 `❯`；菜单必须「序号 1 起连续 + 有 ❯ 光标」才算，防误认正文列表。

## 安全（改动时务必保持）

- 前端所有拼进 innerHTML 的动态文本都过 `esc()`/`hi()` 转义；新增渲染同样处理。
- 后端 `project`/`id` 一律过 `NAME_RE`（`^[A-Za-z0-9._-]+$`）白名单，防路径穿越。
- 密码与 token 用 `crypto.timingSafeEqual` 常数时间比较；登录限速 + 指数退避 + 固定延时。
- 分享 token 带会话作用域（`sp`/`si`），`isAuthed` 拒绝它冒充登录会话。
- tmux 桥接 = 远程命令执行：三条 `/api/tmux*` 路由都在 `if (!authed)` 之后（不接受分享 token）、
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
