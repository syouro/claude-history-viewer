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

## 安全（改动时务必保持）

- 前端所有拼进 innerHTML 的动态文本都过 `esc()`/`hi()` 转义；新增渲染同样处理。
- 后端 `project`/`id` 一律过 `NAME_RE`（`^[A-Za-z0-9._-]+$`）白名单，防路径穿越。
- 密码与 token 用 `crypto.timingSafeEqual` 常数时间比较；登录限速 + 指数退避 + 固定延时。
- 分享 token 带会话作用域（`sp`/`si`），`isAuthed` 拒绝它冒充登录会话。

## 缓存与索引（按需加载 + 惰性释放）

- `cache`：全量会话（含消息体）LRU，上限 `CACHE_MAX`；只在**打开会话 / 搜索命中候选**时填充。
- `INDEX`（→ `index.json`，version 2）：**摘要**索引（无消息体），常驻内存，列表 / 统计只碰它。
- `BLOBS`（→ `index.blobs.json`）：搜索用的**正文/思考 blob**（大）。**惰性读盘、闲置 `BLOB_TTL_MS` 后释放内存**。
  - 平时只看历史 **不载入 blob**；只有搜索才 `ensureBlobs()` 读盘，之后 `releaseBlobs()` 定时释放。
  - `blobFor()` 自愈：blob 缺失或 stamp 与摘要不符，就解析该会话重建。
  - 失效键 `cacheStamp(mtime，含子代理文件)`；`refreshIndex()` 增量刷新摘要（**不碰 blob**，除非已载入）。
  - 搜索：先用 blob 粗筛（全词命中才算候选），**只有候选才 `loadSession` 全量解析**算精确命中数与片段。
  - 落盘走 3s 防抖 + 退出 flush；改了 `parseSession` / `summary` 结构后删掉这两个文件重建。

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
