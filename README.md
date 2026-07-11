# Claude 对话历史查看器

零依赖 Node 单文件服务，浏览 `~/.claude/projects/` 下的对话历史。带登录鉴权，可经反代公网访问。

## 访问

- 公网：<https://example.com:8443/history/>（OpenResty 反代 → 本机 48213）
- 本机：`http://127.0.0.1:48213`

登录密码存在 `secret.json`（首次启动随机生成）。查看 / 修改：

```bash
# 查看当前密码
node -e "console.log(require('./secret.json').password)"
# 换密码：编辑 secret.json 的 password 字段后重启，或用环境变量 VIEWER_PASSWORD 覆盖
```

## 运行（已用 pm2 常驻）

```bash
COOKIE_PATH=/history/ SECURE_COOKIE=1 pm2 start server.js --name claude-history
pm2 save            # 已执行，开机自启
pm2 restart claude-history   # 改代码后
```

## 配置（config.json）

服务配置集中在 `config.json`（缺省时全走默认值），环境变量始终优先于配置文件：

```json
{
  "roots": ["~/.claude/projects", "/mnt/backup/claude-projects"],
  "exclude": ["-tmp-*", "-root-codeDir-某项目"],
  "port": 48213,
  "host": "127.0.0.1",
  "cookiePath": "/history/",
  "secureCookie": true
}
```

- `roots` — 扫描根目录，可配多个；同名项目+会话在多个根中出现时，先配置的根优先
- `exclude` — 例外规则：按项目目录名做 glob 匹配（支持 `*` `?`），命中的项目不列出、API 也拒绝访问
- 配置文件路径可用 `CONFIG_PATH` 环境变量指定（默认 `./config.json`）

本地 http 调试（生产 cookie 限定在 `/history/` 且带 Secure，直连时要覆盖）：

```bash
SECURE_COOKIE=0 COOKIE_PATH=/ PORT=48999 node server.js
```

## 环境变量（优先于 config.json）

| 变量 | 默认 | 说明 |
|------|------|------|
| `PORT` | `48213` | 监听端口（复杂端口，配合反代） |
| `HOST` | `127.0.0.1` | 只监听本机，公网一律走反代 |
| `COOKIE_PATH` | `/` | 子路径反代时设为 `/history/`，把 cookie 限定在本应用 |
| `SECURE_COOKIE` | `1` | 带 `Secure`（https）。本地 http 调试设 `0` |
| `VIEWER_PASSWORD` | 无 | 覆盖 secret.json 里的密码 |
| `CLAUDE_PROJECTS_DIR` | `~/.claude/projects` | 整体覆盖 `roots`（只支持单个目录） |
| `CONFIG_PATH` | `./config.json` | 配置文件路径 |

## 文件

- `server.js` — 后端 + 内嵌 HTML/CSS
- `app.js` — 前端逻辑（由 `/app.js` 路由提供，含 Markdown 渲染器）
- `config.json` — 服务配置（扫描根目录、例外、端口等）
- `secret.json` — 密钥与密码（自动生成，勿入库）
- `favorites.json` — 收藏与备注（自动生成，勿入库）

## 功能

- 左栏按项目分组列全部会话，最近的在上；「★ 收藏」组置顶
- **搜索**：即时按标题模糊子序列过滤；停顿 ~0.3s 跨全部会话（含子代理侧链）搜正文，带命中数与片段高亮；打开命中会话后右上出现「N / M ↑↓」逐处跳转（自动展开折叠区）
- **筛选**：项目下拉 + 时间范围（今天 / 7 天 / 30 天）+「含思考」开关（把 thinking 纳入搜索）
- **分页加载**：打开会话默认只取最近 80 条，从底部看起，上滚自动加载更早的
- **实时跟踪**：2 分钟内有写入的会话标「● 进行中」；打开后自动轮询增量追加新消息，在底部时跟随滚动
- **子代理侧链**：`<sessionId>/subagents/agent-*.jsonl` 单独解析，顶部 chips 切换主对话 / 各子代理
- **压缩续接**：`summary` 行、`isCompactSummary` 消息、`compact_boundary` 边界分别渲染为摘要横幅 / 折叠块 / 分隔线
- **工具调用友好渲染**：Bash 显示命令、Read/Write/Edit 显示路径、Edit 渲染红绿 diff、待办清单 / 提问 / 子代理卡片；未知工具回退 JSON
- **Markdown 渲染**：正文与思考按 Markdown 渲染，先转义再渲染防 XSS；搜索高亮用哨兵字符穿透到渲染后的 HTML
- **收藏 + 备注**：顶栏 ☆ 收藏、备注一句话，存 `favorites.json`
- **消息锚点**：`#s=项目/会话[/序号]` 直达定位；消息悬停 🔗 复制链接
- **只读分享**：顶栏「分享」签发 7 天有效的单会话只读链接，访客无侧栏、不能列表/搜索
- **用量统计**：📊 面板显示总量指标卡、近 30 天每日输出 token 柱状图、按项目/模型汇总（含子代理用量）
- **导出 MD**：一键导出 Markdown（含子代理侧链与压缩摘要）
- **深浅色**：右上 ◐ 手动切换（系统 → 深 → 浅循环，记忆到 localStorage）
- **移动端**：≤720px 侧栏折叠成抽屉（☰ 展开）
- <kbd>Esc</kbd> 清空搜索

## 安全

- 登录：HMAC 签名会话 cookie（`HttpOnly` `SameSite=Lax` `Secure`，有效期 7 天）
- 登录限速：单 IP 连错 5 次锁定，指数退避；错误密码固定延时拖慢暴力破解
- 密码常数时间比较；会话/密钥持久化在 `secret.json`（chmod 600）
- 参数白名单校验，防路径穿越
- `secret.json`、`nginx.conf.bak` 勿入库

## 反代（已写入 OpenResty，`example.com` server 块内）

```nginx
location = /history { return 301 /history/; }
location /history/ {
    proxy_pass         http://127.0.0.1:48213/;
    proxy_http_version 1.1;
    proxy_set_header   Host $host;
    proxy_set_header   X-Real-IP $remote_addr;
    proxy_set_header   X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header   X-Forwarded-Proto $scheme;
}
```

改动前的配置已备份为 `nginx.conf.bak`。
