# Claude 对话历史查看器

[English](README.en.md) | 中文

零依赖 Node 单文件服务，浏览 `~/.claude/projects/` 下的对话历史。带登录鉴权，可经反代公网访问。

## 访问

- 公网：`https://你的域名/history/`（反代 → 本机 48213）
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
  "secureCookie": true,
  "tmux": true
}
```

- `roots` — 扫描根目录，可配多个；同名项目+会话在多个根中出现时，先配置的根优先
- `exclude` — 例外规则：按项目目录名做 glob 匹配（支持 `*` `?`），命中的项目不列出、API 也拒绝访问
- `tmux` — 开启 tmux 桥接（默认关闭，见下）
- 配置文件路径可用 `CONFIG_PATH` 环境变量指定（默认 `./config.json`）

## tmux 桥接（手机上远程操控 Claude Code）

开启后（`"tmux": true` 或环境变量 `TMUX_UI=1`），登录用户可以：

- **会话视图底部出现控制条**：当这段对话的 cwd 匹配到某个 tmux 窗格（优先 claude 进程）时，
  可以直接给正在跑的 Claude Code 发消息；出现权限确认 / 选择菜单时，
  自动解析成**原生按钮**，点一下即选择；忙碌时显示状态，Esc 一键打断。
  配合已有的实时跟踪（live），在手机上就是一个完整的远程 Claude 客户端。
- **▣ tmux 控制台**（侧栏图标）：列出所有 tmux 窗格，可打开任意窗格的裸终端画面
  （带 ANSI 颜色，1.5s 轮询），下方同一条控制条可发文本和常用按键。
- **网页新建 / 关闭会话**：控制台里可直接拉起新 tmux 会话——选目录（带历史会话目录联想）、
  可选启动命令（填 `claude` 就直接开一个新的 Claude Code），建好即进画面；
  窗格卡片上的 ✕ 可关闭窗格（二次确认）。启动命令退出后会落回 shell，不会把会话带没。

安全：三条 `/api/tmux*` 路由仅登录会话可用（分享 token 不行），具名按键过白名单，
默认关闭需显式开启。本质上等于给登录用户开了远程命令执行，请确保登录密码足够强、走 https。

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
| `INDEX_PATH` | `./index.json` | 会话摘要索引文件路径 |
| `INDEX_BLOBS_PATH` | `./index.blobs.json` | 搜索 blob 文件路径 |
| `BLOB_TTL_MS` | `300000` | 搜索 blob 闲置多久后释放内存（毫秒） |
| `TMUX_UI` | `0` | 开启 tmux 桥接（不叫 `TMUX`：tmux 会给子进程注入同名变量） |

## 索引

列表 / 统计 / 搜索走一层持久化索引，并把「常驻」与「大块」分开，让平时只看历史时内存占用很小：

- `index.json`：会话**摘要**索引（无消息体），常驻内存，列表 / 统计只碰它。摘要小，常驻不肉疼。
- `index.blobs.json`：搜索用的**正文/思考 blob**（体量大）。**惰性从盘上读入**，闲置 `BLOB_TTL_MS`
  后**释放内存**；只在搜索时才载入。搜索先用 blob 粗筛，**只有命中候选才全量解析** jsonl 算精确
  命中数与片段——会话再多也不会每次搜索都把全部文件重解析一遍。

两个索引都以文件 mtime（含子代理文件）为失效键增量刷新；blob 自带 stamp，与摘要不符即按需重建（自愈）。
结构随时可删，下次请求自动重建。改了 `parseSession` / `summary` 的输出结构后，删掉这两个文件让它重建。

## 删除

会话顶栏「删除」会**删掉磁盘上的 `.jsonl` 文件**（含其 `<id>/subagents/` 子代理目录），**不可恢复**，
前端有二次确认。仅登录用户可用；只读分享访客看不到该按钮，API 也拒绝分享 token。

## 测试

```bash
node --test        # test/ 下的 node:test 用例，零依赖
```

## 文件

- `server.js` — 后端 + 内嵌 HTML/CSS
- `app.js` — 前端逻辑（由 `/app.js` 路由提供，含 Markdown 渲染器）
- `test/` — `node:test` 用例（纯函数 + `parseSession` + 索引）
- `config.json` — 服务配置（扫描根目录、例外、端口等）
- `secret.json` — 密钥与密码（自动生成，勿入库）
- `favorites.json` — 收藏与备注（自动生成，勿入库）
- `index.json` — 会话摘要索引（自动生成、可安全删除重建，勿入库）
- `index.blobs.json` — 搜索用正文/思考 blob（惰性读盘、闲置释放，勿入库）
- `android/` — Android 壳子 App（WebView，见下方专节）
- `.github/workflows/android.yml` — 打 tag 自动出 APK 的 GitHub Actions

## 功能

- 左栏按项目分组列全部会话，最近的在上；「★ 收藏」组置顶
- **搜索**：即时按标题模糊子序列过滤；停顿 ~0.3s 跨全部会话（含子代理侧链）搜正文，带命中数与片段高亮；打开命中会话后右上出现「N / M ↑↓」逐处跳转（自动展开折叠区）
- **筛选**：项目下拉 + 时间范围（今天 / 7 / 30 / 90 天 / 半年 / 一年 / 自定义起止日期）+「含思考」开关（把 thinking 纳入搜索）
- **分页加载**：打开会话默认只取最近 80 条，从底部看起，上滚自动加载更早的
- **实时跟踪**：2 分钟内有写入的会话标「● 进行中」；打开后自动轮询增量追加新消息，在底部时跟随滚动
- **tmux 桥接**（可选，默认关闭）：手机上远程操控正在跑的 Claude Code——后端抓终端画面并解析成交互状态，前端渲染成原生控件：发消息、权限确认一键点选、<kbd>Esc</kbd> 打断、<kbd>⇧⇥</kbd> 切权限模式（按钮实时显示当前档位）；▣ 控制台可列窗格、看 ANSI 裸终端兜底、网页新建 / 关闭会话。详见下方专节
- **子代理侧链**：`<sessionId>/subagents/agent-*.jsonl` 单独解析，顶部 chips 切换主对话 / 各子代理
- **压缩续接**：`summary` 行、`isCompactSummary` 消息、`compact_boundary` 边界分别渲染为摘要横幅 / 折叠块 / 分隔线
- **工具调用友好渲染**：Bash 显示命令、Read/Write/Edit 显示路径、Edit 渲染红绿 diff、待办清单 / 提问 / 子代理卡片；未知工具回退 JSON
- **Markdown 渲染**：正文与思考按 Markdown 渲染（含 GFM 表格，支持对齐、`\|` 转义、窄屏横向滚动），先转义再渲染防 XSS；搜索高亮用哨兵字符穿透到渲染后的 HTML
- **收藏 + 备注**：顶栏 ☆ 收藏、备注一句话，存 `favorites.json`
- **消息锚点**：`#s=项目/会话[/序号]` 直达定位；消息悬停 🔗 复制链接
- **只读分享**：顶栏「分享」签发 7 天有效的单会话只读链接，访客无侧栏、不能列表/搜索
- **用量统计**：📊 面板可选时间区间（7 / 30 / 90 天、近一年、今年、全部、自定义起止），指标卡、柱状图、按项目/模型汇总都跟着区间走（含子代理用量）；区间越长柱子自动按日 → 周 → 月并柱
- **导出 MD**：一键导出 Markdown（含子代理侧链与压缩摘要）
- **删除**：顶栏「删除」删掉磁盘上的对话文件（含子代理目录），二次确认、不可恢复，仅登录可用
- **深浅色**：右上 ◐ 手动切换（系统 → 深 → 浅循环，记忆到 localStorage）
- **移动端**：≤720px 侧栏折叠成抽屉（☰ 展开）
- <kbd>Esc</kbd> 清空搜索

## 安全

- 登录：HMAC 签名会话 cookie（`HttpOnly` `SameSite=Lax` `Secure`，有效期 7 天）
- 登录限速：单 IP 连错 5 次锁定，指数退避；错误密码固定延时拖慢暴力破解
- 密码常数时间比较；会话/密钥持久化在 `secret.json`（chmod 600）
- 参数白名单校验，防路径穿越
- `secret.json`、`nginx.conf.bak` 勿入库

## 反代（nginx / OpenResty 示例）

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

## Android 壳子 App

`android/` 下是一个极简 WebView 壳子（纯 Android SDK，无第三方依赖），把查看器包成手机 App：

- **拿 APK**：打 tag（`git tag v1.0 && git push --tags`）后 GitHub Actions 自动构建并挂到
  Release；也可在 Actions 页手动 Run workflow，从 artifact 下载。
- **首次启动**填服务器地址（如 `https://你的域名/history/`），登录 cookie 持久化，之后打开即用。
- **改地址**：长按返回键，或桌面长按 App 图标 →「服务器设置」。
- **行为**：同域链接留在壳内，外链/下载交给系统浏览器；断网时显示重试页。
- **反代 Basic Auth**：nginx 加了 `auth_basic` 也没关系——首次弹原生对话框输一次，之后记住自动带上。
- **签名**：默认用 debug 签名（换签名的新版本要先卸载旧版）。想固定签名以便覆盖升级，
  在仓库 Settings → Secrets 配 `KEYSTORE_BASE64`（keystore 文件 base64）、
  `KEYSTORE_PASSWORD`、`KEY_ALIAS`、`KEY_PASSWORD`：

  ```bash
  keytool -genkeypair -keystore release.keystore -alias viewer -keyalg RSA -validity 9999
  base64 -w0 release.keystore   # 结果填进 KEYSTORE_BASE64
  ```

服务本体照旧零依赖；壳子是独立子项目，不影响 `server.js`/`app.js`。

## 许可证

[MIT](LICENSE) © syouro
