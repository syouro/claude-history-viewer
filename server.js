#!/usr/bin/env node
// Claude 对话历史查看器 —— 零依赖，纯 Node 标准库。
// 扫描 ~/.claude/projects/<项目>/<sessionId>.jsonl；带登录鉴权，可经反代公网访问。
'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { execFile } = require('child_process');

// ---------- 配置文件（config.json，环境变量优先）----------
const CONFIG_PATH = process.env.CONFIG_PATH || path.join(__dirname, 'config.json');
let USER_CFG = {};
try { USER_CFG = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')); }
catch { /* 无配置文件则全部走默认值 */ }
function expandHome(p) {
  return p === '~' || p.startsWith('~/') ? path.join(os.homedir(), p.slice(1)) : p;
}
// 扫描根目录可配多个；CLAUDE_PROJECTS_DIR 仍可整体覆盖
const ROOTS = (process.env.CLAUDE_PROJECTS_DIR
  ? [process.env.CLAUDE_PROJECTS_DIR]
  : (Array.isArray(USER_CFG.roots) && USER_CFG.roots.length
      ? USER_CFG.roots : ['~/.claude/projects']))
  .map((p) => path.resolve(expandHome(String(p))));
// 例外：按项目目录名做 glob 匹配（* ?），命中的项目不列出也不可访问
function globToRe(g) {
  const re = String(g).split(/([*?])/).map((part) =>
    part === '*' ? '.*' : part === '?' ? '.' :
    part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('');
  return new RegExp('^' + re + '$');
}
const EXCLUDE = (Array.isArray(USER_CFG.exclude) ? USER_CFG.exclude : []).map(globToRe);
function isExcluded(project) { return EXCLUDE.some((re) => re.test(project)); }

const HOST = process.env.HOST || USER_CFG.host || '127.0.0.1'; // 默认只监听本机，公网走反代
const PORT = Number(process.env.PORT || USER_CFG.port || 48213); // 复杂端口，配合反代
const COOKIE_PATH = process.env.COOKIE_PATH || USER_CFG.cookiePath || '/'; // 子路径反代时设为 /history/
const SECURE_COOKIE = process.env.SECURE_COOKIE !== undefined
  ? !['0', 'false', 'no'].includes(String(process.env.SECURE_COOKIE).toLowerCase())
  : USER_CFG.secureCookie !== undefined ? !!USER_CFG.secureCookie
  : true; // 默认带 Secure，公网 https
const SESSION_TTL = 1000 * 60 * 60 * 24 * 7; // 会话 7 天
// tmux 桥接（网页控制台，可向会话发送按键）：默认关闭，config.json {"tmux":true} 或 TMUX_UI=1 开启
// （不用 TMUX 这个名字：tmux 自己会往子进程注入同名变量）
const TMUX_UI = process.env.TMUX_UI !== undefined
  ? !['0', 'false', 'no'].includes(String(process.env.TMUX_UI).toLowerCase())
  : !!USER_CFG.tmux;
// codex 会话历史（~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl）：目录存在即启用
const CODEX_ROOTS = (process.env.CODEX_SESSIONS_DIR
  ? [process.env.CODEX_SESSIONS_DIR]
  : (Array.isArray(USER_CFG.codexRoots) && USER_CFG.codexRoots.length
      ? USER_CFG.codexRoots : ['~/.codex/sessions']))
  .map((p) => path.resolve(expandHome(String(p))));
const CODEX_ENABLED = USER_CFG.codex !== undefined ? !!USER_CFG.codex
  : CODEX_ROOTS.some((r) => fs.existsSync(r));
// agy（Antigravity CLI）会话历史（~/.gemini/antigravity-cli）：目录存在即启用，"agy": false 强关
const AGY_ROOTS = (process.env.AGY_DIR
  ? [process.env.AGY_DIR]
  : (Array.isArray(USER_CFG.agyRoots) && USER_CFG.agyRoots.length
      ? USER_CFG.agyRoots : ['~/.gemini/antigravity-cli']))
  .map((p) => path.resolve(expandHome(String(p))));
const AGY_ENABLED = USER_CFG.agy !== undefined ? !!USER_CFG.agy
  : AGY_ROOTS.some((r) => fs.existsSync(r));

// ---------- 配置 / 密钥（persist 到 secret.json）----------
const CFG = path.join(__dirname, 'secret.json');
let SECRET, PASSWORD;
function loadConfig() {
  let cfg = {};
  try { cfg = JSON.parse(fs.readFileSync(CFG, 'utf8')); } catch { /* first run */ }
  SECRET = cfg.secret || crypto.randomBytes(32).toString('hex');
  cfg.secret = SECRET;
  let generated = null;
  PASSWORD = process.env.VIEWER_PASSWORD || cfg.password;
  if (!PASSWORD) {
    PASSWORD = crypto.randomBytes(9).toString('base64url');
    cfg.password = PASSWORD;
    generated = PASSWORD;
  }
  try { fs.writeFileSync(CFG, JSON.stringify(cfg, null, 2)); fs.chmodSync(CFG, 0o600); }
  catch { /* ignore */ }
  return generated;
}

// ---------- 会话令牌（HMAC 签名）----------
function tsafeEqual(a, b) {
  const ba = Buffer.from(a), bb = Buffer.from(b);
  if (ba.length !== bb.length) return false;
  return crypto.timingSafeEqual(ba, bb);
}
function signToken(payload) {
  const data = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const mac = crypto.createHmac('sha256', SECRET).update(data).digest('base64url');
  return data + '.' + mac;
}
function verifyToken(tok) {
  if (!tok || tok.indexOf('.') < 0) return null;
  const [data, mac] = tok.split('.');
  const expect = crypto.createHmac('sha256', SECRET).update(data).digest('base64url');
  if (!tsafeEqual(mac, expect)) return null;
  try {
    const p = JSON.parse(Buffer.from(data, 'base64url').toString('utf8'));
    if (!p.exp || Date.now() > p.exp) return null;
    return p;
  } catch { return null; }
}
function parseCookies(req) {
  const out = {};
  const h = req.headers.cookie;
  if (!h) return out;
  for (const part of h.split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}
function isAuthed(req) {
  const p = verifyToken(parseCookies(req)['chv_sid']);
  return !!p && !p.sp; // 分享 token（带会话作用域）不能冒充登录会话
}

// ---------- 登录限速 ----------
const attempts = new Map(); // ip -> {fails, until}
function clientIp(req) {
  const xff = req.headers['x-forwarded-for'];
  if (xff) return String(xff).split(',')[0].trim();
  return req.socket.remoteAddress || 'unknown';
}
function checkLock(ip) {
  const a = attempts.get(ip);
  if (a && a.until && Date.now() < a.until) return Math.ceil((a.until - Date.now()) / 1000);
  return 0;
}
function recordFail(ip) {
  const a = attempts.get(ip) || { fails: 0, until: 0 };
  a.fails++;
  if (a.fails >= 5) a.until = Date.now() + Math.min(15 * 60e3, 2 ** (a.fails - 5) * 30e3);
  attempts.set(ip, a);
}
function recordOk(ip) { attempts.delete(ip); }

// ---------- 解析 ----------
function extractBlocks(role, content) {
  const out = [];
  if (typeof content === 'string') {
    if (content.trim()) out.push({ kind: 'text', text: content });
    return out;
  }
  if (!Array.isArray(content)) return out;
  for (const b of content) {
    if (!b || typeof b !== 'object') continue;
    switch (b.type) {
      case 'text':
        if (b.text && b.text.trim()) out.push({ kind: 'text', text: b.text });
        break;
      case 'thinking':
        if (b.thinking && b.thinking.trim())
          out.push({ kind: 'thinking', text: b.thinking });
        break;
      case 'tool_use':
        out.push({ kind: 'tool_use', name: b.name || 'tool', input: b.input });
        break;
      case 'tool_result':
        out.push({ kind: 'tool_result', text: toolResultText(b.content), isError: !!b.is_error });
        break;
      default: break;
    }
  }
  return out;
}
function toolResultText(c) {
  if (typeof c === 'string') return c;
  if (Array.isArray(c)) {
    return c.map((x) => {
      if (typeof x === 'string') return x;
      if (x && x.type === 'text') return x.text;
      if (x && x.type === 'image') return '[image]';
      return '';
    }).join('\n');
  }
  return '';
}
function plainText(blocks) {
  return blocks.map((b) => b.text || (b.kind === 'tool_use' ? b.name : ''))
    .filter(Boolean).join(' ');
}
// ---------- 按模型估算美元花费（每百万 token 报价，来自 Anthropic 官方定价）----------
// 缓存写入按 5 分钟 TTL（输入价 ×1.25）估算，缓存读取按 ×0.1 估算；
// 会话记录里不区分 TTL，这是行业常见默认档位，非精确账单。
const PRICING = {
  'claude-fable-5': { in: 10, out: 50 },
  'claude-mythos-5': { in: 10, out: 50 },
  'claude-opus-4-8': { in: 5, out: 25 },
  'claude-opus-4-7': { in: 5, out: 25 },
  'claude-opus-4-6': { in: 5, out: 25 },
  'claude-opus-4-5': { in: 5, out: 25 },
  'claude-opus-4-1': { in: 15, out: 75 },
  'claude-opus-4-0': { in: 15, out: 75 },
  'claude-sonnet-5': { in: 3, out: 15 },
  'claude-sonnet-4-6': { in: 3, out: 15 },
  'claude-sonnet-4-5': { in: 3, out: 15 },
  'claude-sonnet-4-0': { in: 3, out: 15 },
  'claude-haiku-4-5': { in: 1, out: 5 },
};
function priceFor(model) {
  if (!model) return null;
  if (PRICING[model]) return PRICING[model];
  const noDate = model.match(/^(.*)-\d{8}$/); // 去掉形如 -20250929 的日期后缀再查一次
  if (noDate && PRICING[noDate[1]]) return PRICING[noDate[1]];
  return null;
}
function costOf(u, model) {
  const p = priceFor(model);
  if (!p) return null;
  const inRate = p.in / 1e6, outRate = p.out / 1e6;
  return (u.input_tokens || 0) * inRate + (u.output_tokens || 0) * outRate +
    (u.cache_creation_input_tokens || 0) * inRate * 1.25 +
    (u.cache_read_input_tokens || 0) * inRate * 0.1;
}
// 用量累加（parseSession / parseCodexSession 共用）：u 为 API 原始 usage 结构
const zeroU = () => ({ in: 0, out: 0, cw: 0, cr: 0, msgs: 0, cost: 0 });
function addU(t, u, model) {
  t.in += u.input_tokens || 0; t.out += u.output_tokens || 0;
  t.cw += u.cache_creation_input_tokens || 0; t.cr += u.cache_read_input_tokens || 0;
  t.msgs++;
  const c = costOf(u, model);
  if (c != null) t.cost = (t.cost || 0) + c;
}
function parseSession(project, id, filePath) {
  const stat = fs.statSync(filePath);
  const raw = fs.readFileSync(filePath, 'utf8');
  const messages = [];            // 主链消息
  const sidechains = new Map();   // agentId -> 子代理侧链
  const summaries = [];           // 压缩续接产生的历史摘要
  let title = '', firstPrompt = '', cwd = '', gitBranch = '', agentName = '';
  let firstTs = null, lastTs = null, lastModel = '';
  // token 用量统计（含子代理）
  const usage = { in: 0, out: 0, cw: 0, cr: 0, msgs: 0, cost: 0 };
  // usageByDay：日期 -> 模型 -> 用量（按天+按模型的汇总都从这里推，支持任意时间区间）
  // 无时间戳的记录落在 '' 这一档，只计入「全部时间」
  const usageByDay = {}, msgsByDay = {};
  const addUsage = (msg, ts) => {
    const u = msg.usage;
    if (!u) return;
    const model = msg.model && msg.model !== '<synthetic>' ? msg.model : '(unknown)';
    addU(usage, u, model);
    const day = ts ? String(ts).slice(0, 10) : '';
    const byModel = usageByDay[day] = usageByDay[day] || {};
    addU(byModel[model] = byModel[model] || zeroU(), u, model);
  };
  for (const line of raw.split('\n')) {
    const s = line.trim();
    if (!s) continue;
    let o;
    try { o = JSON.parse(s); } catch { continue; }
    if (o.type === 'ai-title' && o.aiTitle) { title = o.aiTitle; continue; }
    if (o.type === 'summary' && o.summary) { summaries.push(o.summary); continue; }
    if (o.type === 'agent-name' && o.agentName) { agentName = o.agentName; continue; }
    if (o.type === 'system' && o.subtype === 'compact_boundary') {
      messages.push({
        role: 'system', ts: o.timestamp || null, isMeta: false,
        blocks: [{ kind: 'compact', text: '—— 上下文已压缩，此处之前的内容被摘要替代 ——' }],
      });
      continue;
    }
    if (o.type !== 'user' && o.type !== 'assistant') continue;
    const msg = o.message || {};
    const role = msg.role || o.type;
    const blocks = extractBlocks(role, msg.content);
    if (!blocks.length) continue;
    const isMeta = !!o.isMeta;
    const ts = o.timestamp || null;
    if (ts) { if (!firstTs) firstTs = ts; lastTs = ts; }
    if (o.cwd) cwd = o.cwd;
    if (o.gitBranch) gitBranch = o.gitBranch;
    if (role === 'assistant') {
      addUsage(msg, ts);
      if (msg.model && msg.model !== '<synthetic>') lastModel = msg.model;
    }
    const m = { role, ts, isMeta, blocks };
    if (o.isCompactSummary) m.compact = true;
    if (o.isSidechain) {
      const aid = o.agentId || 'sidechain';
      let sc = sidechains.get(aid);
      if (!sc) {
        sc = { agentId: aid, firstPrompt: '', firstTs: ts, lastTs: ts, messages: [] };
        sidechains.set(aid, sc);
      }
      if (ts) sc.lastTs = ts;
      if (!sc.firstPrompt && role === 'user') sc.firstPrompt = plainText(blocks).slice(0, 160);
      sc.messages.push(m);
      continue;
    }
    const text = plainText(blocks);
    if (!firstPrompt && role === 'user' && !isMeta &&
        !/^<(local-command|command-|user-)/.test(text)) {
      firstPrompt = text.slice(0, 200);
    }
    const mday = ts ? String(ts).slice(0, 10) : '';
    msgsByDay[mday] = (msgsByDay[mday] || 0) + 1;
    messages.push(m);
  }
  // 子代理侧链单独存放在 <sessionId>/subagents/agent-<agentId>.jsonl
  for (const sf of sidechainFiles(filePath.slice(0, -6))) {
    try {
      const aid = sf.name.slice(6, -6); // agent-xxx.jsonl -> xxx
      const sc = { agentId: aid, firstPrompt: '', firstTs: null, lastTs: null, messages: [] };
      for (const line of fs.readFileSync(sf.path, 'utf8').split('\n')) {
        const t = line.trim();
        if (!t) continue;
        let o;
        try { o = JSON.parse(t); } catch { continue; }
        if (o.type !== 'user' && o.type !== 'assistant') continue;
        const msg = o.message || {};
        const role = msg.role || o.type;
        const blocks = extractBlocks(role, msg.content);
        if (!blocks.length) continue;
        const ts = o.timestamp || null;
        if (ts) { if (!sc.firstTs) sc.firstTs = ts; sc.lastTs = ts; }
        if (!sc.firstPrompt && role === 'user') sc.firstPrompt = plainText(blocks).slice(0, 160);
        if (role === 'assistant') addUsage(msg, ts);
        sc.messages.push({ role, ts, isMeta: !!o.isMeta, blocks });
      }
      if (sc.messages.length) sidechains.set(sc.agentId, sc);
    } catch { /* skip */ }
  }
  const chains = [...sidechains.values()].sort((a, b) =>
    String(a.firstTs || '').localeCompare(String(b.firstTs || '')));
  return {
    project, id, src: 'claude', title: title || firstPrompt || '(无标题)', firstPrompt,
    cwd, gitBranch, agentName, mtime: stat.mtimeMs, firstTs, lastTs, lastModel,
    msgCount: messages.length, summaries,
    usage, usageByDay, msgsByDay,
    sidechains: chains, messages,
  };
}
function sidechainFiles(sessionDir) {
  const dir = path.join(sessionDir, 'subagents');
  try {
    return fs.readdirSync(dir)
      .filter((f) => /^agent-[A-Za-z0-9._-]+\.jsonl$/.test(f))
      .map((f) => ({ name: f, path: path.join(dir, f) }));
  } catch { return []; }
}
// ---------- codex 会话解析 ----------
// codex 的 rollout-*.jsonl：每行 {timestamp, type, payload}。对话正文取 response_item
// （event_msg 的 user_message/agent_message 与之重复，只用 event_msg 拿 token 用量）。
const CODEX_ID_RE = /^rollout-(\d{4})-(\d{2})-(\d{2})T\d{2}-\d{2}-\d{2}-[0-9a-fA-F-]+$/;
// 在各 codex 根中按 id 里的日期定位文件（目录即 YYYY/MM/DD，无需全树扫描）
function codexFile(id) {
  const m = CODEX_ID_RE.exec(id || '');
  if (!m) return null;
  for (const root of CODEX_ROOTS) {
    const fp = path.join(root, m[1], m[2], m[3], id + '.jsonl');
    if (fs.existsSync(fp)) return fp;
  }
  return null;
}
// codex 没有项目目录，用 cwd 按 claude 同款规则编码出项目名（与前端 encCwd 一致）
function codexProject(cwd) {
  return (cwd ? String(cwd).replace(/[^A-Za-z0-9]/g, '-') : '') || 'codex';
}
// 会话标题来自 ~/.codex/session_index.jsonl（uuid -> thread_name），mtime 变了才重读
let codexTitleCache = { stamp: '', map: new Map() };
function codexTitles() {
  let stamp = '';
  const files = CODEX_ROOTS.map((r) => path.join(r, '..', 'session_index.jsonl'));
  for (const fp of files) {
    try { stamp += fp + ':' + fs.statSync(fp).mtimeMs + ';'; } catch { /* 无索引 */ }
  }
  if (stamp === codexTitleCache.stamp) return codexTitleCache.map;
  const map = new Map();
  for (const fp of files) {
    let raw = '';
    try { raw = fs.readFileSync(fp, 'utf8'); } catch { continue; }
    for (const line of raw.split('\n')) {
      const s = line.trim();
      if (!s) continue;
      try {
        const o = JSON.parse(s);
        if (o.id && o.thread_name) map.set(o.id, o.thread_name);
      } catch { /* skip */ }
    }
  }
  codexTitleCache = { stamp, map };
  return map;
}
// user 消息里的环境包裹（<environment_context> 等）按 meta 隐藏
const CODEX_META_RE =
  /^(<(environment_context|permissions|user_instructions|turn_aborted|turn_context|recommended_plugins|user_shell_command|collaboration_mode|AGENTS)|# AGENTS\.md instructions)/;
function parseCodexSession(id, filePath) {
  const stat = fs.statSync(filePath);
  const raw = fs.readFileSync(filePath, 'utf8');
  const messages = [];
  let cwd = '', gitBranch = '', model = '', firstPrompt = '', threadSource = '';
  let firstTs = null, lastTs = null;
  const usage = zeroU(), usageByDay = {}, msgsByDay = {};
  const addTok = (u, ts) => {
    addU(usage, u, model || '(unknown)');
    const day = ts ? String(ts).slice(0, 10) : '';
    const byModel = usageByDay[day] = usageByDay[day] || {};
    addU(byModel[model || '(unknown)'] = byModel[model || '(unknown)'] || zeroU(), u, model);
  };
  const push = (role, ts, isMeta, blocks, extra) => {
    if (!blocks.length) return;
    if (ts) { if (!firstTs) firstTs = ts; lastTs = ts; }
    const day = ts ? String(ts).slice(0, 10) : '';
    msgsByDay[day] = (msgsByDay[day] || 0) + 1;
    messages.push(Object.assign({ role, ts, isMeta, blocks }, extra));
  };
  for (const line of raw.split('\n')) {
    const s = line.trim();
    if (!s) continue;
    let o;
    try { o = JSON.parse(s); } catch { continue; }
    const p = o.payload || {};
    const ts = o.timestamp || null;
    if (o.type === 'session_meta') {
      if (p.cwd) cwd = p.cwd;
      if (p.git && p.git.branch) gitBranch = p.git.branch;
      if (p.timestamp && !firstTs) firstTs = p.timestamp;
      if (p.thread_source) threadSource = String(p.thread_source);
      continue;
    }
    if (o.type === 'turn_context') {
      if (p.cwd) cwd = p.cwd;
      if (p.model) model = p.model;
      continue;
    }
    if (o.type === 'compacted') {
      push('system', ts, false,
        [{ kind: 'compact', text: '—— 上下文已压缩，此处之前的内容被摘要替代 ——' }]);
      continue;
    }
    if (o.type === 'event_msg') {
      // token_count 才是用量的唯一来源；in 里已含缓存读，拆开对齐 claude 的口径
      if (p.type === 'token_count' && p.info && p.info.last_token_usage) {
        const u = p.info.last_token_usage;
        const cr = u.cached_input_tokens || 0;
        addTok({
          input_tokens: Math.max(0, (u.input_tokens || 0) - cr),
          output_tokens: u.output_tokens || 0,
          cache_read_input_tokens: cr,
        }, ts);
      } else if (p.type === 'turn_aborted') {
        push('system', ts, false, [{ kind: 'compact', text: '—— 已被打断 ——' }]);
      } else if (p.type === 'error' && p.message) {
        push('system', ts, false, [{ kind: 'text', text: '⚠ ' + p.message }]);
      }
      continue;
    }
    if (o.type !== 'response_item') continue;
    switch (p.type) {
      case 'message': {
        const role = p.role === 'assistant' ? 'assistant' : 'user';
        const text = (Array.isArray(p.content) ? p.content : [])
          .map((c) => (c && (c.text || '')) || '').join('\n').trim();
        if (!text) break;
        const isMeta = (p.role !== 'user' && p.role !== 'assistant') || CODEX_META_RE.test(text);
        // 续接/子代理线程开头注入的整段历史：折叠成「压缩摘要」而不是展开一大坨
        const isHistory = /^The following is the Codex agent history/.test(text);
        if (!firstPrompt && role === 'user' && !isMeta && !isHistory)
          firstPrompt = text.slice(0, 200);
        push(role, ts, isMeta, [{ kind: 'text', text }], isHistory ? { compact: true } : null);
        break;
      }
      case 'reasoning': {
        // content 是加密的，只有 summary 可读
        const blocks = (Array.isArray(p.summary) ? p.summary : [])
          .map((x) => x && x.text).filter(Boolean)
          .map((t) => ({ kind: 'thinking', text: t }));
        push('assistant', ts, false, blocks);
        break;
      }
      case 'function_call': {
        let input = {};
        try { input = JSON.parse(p.arguments); } catch { input = { arguments: p.arguments }; }
        push('assistant', ts, false, [{ kind: 'tool_use', name: p.name || 'tool', input }]);
        break;
      }
      case 'custom_tool_call':
        push('assistant', ts, false,
          [{ kind: 'tool_use', name: p.name || 'tool', input: p.input }]);
        break;
      case 'web_search_call':
        push('assistant', ts, false,
          [{ kind: 'tool_use', name: 'web_search', input: p.action || {} }]);
        break;
      case 'tool_search_call':
        push('assistant', ts, false,
          [{ kind: 'tool_use', name: 'tool_search', input: p.arguments || {} }]);
        break;
      case 'function_call_output':
      case 'custom_tool_call_output': {
        let text = typeof p.output === 'string' ? p.output : JSON.stringify(p.output);
        let isError = /exited with code [1-9]/.test(text || '');
        // custom_tool_call_output 的 output 常是再包一层的 JSON {output, metadata}
        try {
          const inner = JSON.parse(text);
          if (inner && typeof inner.output === 'string') {
            text = inner.output;
            if (inner.metadata && inner.metadata.exit_code) isError = true;
          }
        } catch { /* 纯文本 */ }
        push('user', ts, false, [{ kind: 'tool_result', text: text || '', isError }]);
        break;
      }
      case 'tool_search_output':
        push('user', ts, false,
          [{ kind: 'tool_result', text: JSON.stringify(p.tools || p, null, 1), isError: false }]);
        break;
      default: break;
    }
  }
  const uuid = id.slice(-36);
  const title = codexTitles().get(uuid) || '';
  return {
    project: codexProject(cwd), id, src: 'codex', threadSource,
    title: title || firstPrompt || '(无标题)', firstPrompt,
    cwd, gitBranch, agentName: '', mtime: stat.mtimeMs, firstTs, lastTs,
    lastModel: model, msgCount: messages.length, summaries: [],
    usage, usageByDay, msgsByDay,
    sidechains: [], messages,
  };
}

// ---------- agy（Antigravity CLI）会话解析 ----------
// 主存储是 conversations/<uuid>.db（SQLite，步骤还是 protobuf blob），零依赖读不动；
// 用 brain/<uuid>/.system_generated/logs/transcript_full.jsonl（CLI 同步导出的 JSONL）。
// 局限：被压缩过的老会话 transcript 可能缺开头（有 CHECKPOINT 标记），个别会话没有 transcript；
// transcript 里没有 token 用量，usage 恒为零。工作区 / 起止时间来自根下 history.jsonl。
const AGY_ID_RE = /^[0-9a-f-]{36}$/i;
function agyFile(id) {
  if (!AGY_ID_RE.test(id || '')) return null;
  for (const root of AGY_ROOTS) {
    const dir = path.join(root, 'brain', id, '.system_generated', 'logs');
    for (const name of ['transcript_full.jsonl', 'transcript.jsonl']) {
      const fp = path.join(dir, name);
      if (fs.existsSync(fp)) return fp;
    }
  }
  return null;
}
function agyProject(cwd) { return cwd ? codexProject(cwd) : 'agy'; }
// history.jsonl：每条用户输入 {display, timestamp, workspace, conversationId}，
// 聚合成 conversationId → {workspace, firstTs, lastTs}；mtime 变了才重读
let agyMetaCache = { stamp: '', map: new Map() };
function agyMeta() {
  let stamp = '';
  const files = AGY_ROOTS.map((r) => path.join(r, 'history.jsonl'));
  for (const fp of files) {
    try { stamp += fp + ':' + fs.statSync(fp).mtimeMs + ';'; } catch { /* 无历史 */ }
  }
  if (stamp === agyMetaCache.stamp) return agyMetaCache.map;
  const map = new Map();
  for (const fp of files) {
    let raw = '';
    try { raw = fs.readFileSync(fp, 'utf8'); } catch { continue; }
    for (const line of raw.split('\n')) {
      const s = line.trim();
      if (!s) continue;
      try {
        const o = JSON.parse(s);
        if (!o.conversationId) continue;
        const m = map.get(o.conversationId) || {};
        if (o.workspace && !m.workspace) m.workspace = o.workspace;
        if (o.timestamp) {
          if (!m.firstTs) m.firstTs = o.timestamp;
          m.lastTs = o.timestamp;
        }
        map.set(o.conversationId, m);
      } catch { /* skip */ }
    }
  }
  agyMetaCache = { stamp, map };
  return map;
}
function parseAgySession(id, filePath) {
  const stat = fs.statSync(filePath);
  const raw = fs.readFileSync(filePath, 'utf8');
  const messages = [];
  let model = '', firstPrompt = '';
  let firstTs = null, lastTs = null;
  const msgsByDay = {};
  const push = (role, ts, isMeta, blocks, extra) => {
    if (!blocks.length) return;
    if (ts) { if (!firstTs) firstTs = ts; lastTs = ts; }
    const day = ts ? String(ts).slice(0, 10) : '';
    msgsByDay[day] = (msgsByDay[day] || 0) + 1;
    messages.push(Object.assign({ role, ts, isMeta, blocks }, extra));
  };
  for (const line of raw.split('\n')) {
    const s = line.trim();
    if (!s) continue;
    let o;
    try { o = JSON.parse(s); } catch { continue; }
    const ts = o.created_at || null;
    switch (o.type) {
      case 'USER_INPUT': {
        const c = String(o.content || '');
        // 正文在 <USER_REQUEST> 里；其余包裹（ADDITIONAL_METADATA / USER_SETTINGS_CHANGE…）
        // 是环境注入。模型名顺带从设置变更记录里挖出来（transcript 没有别的模型字段）
        const m = c.match(/<USER_REQUEST>\s*([\s\S]*?)\s*<\/USER_REQUEST>/);
        // 模型名里有点（Gemini 3.5），到「句号+空白 / 行尾」才截断
        const sm = c.match(/`Model Selection` from [^\n]*? to (.*?)(?:\.\s|\.$|\n|$)/);
        if (sm) model = sm[1].trim();
        const text = (m ? m[1] : c).trim();
        if (!text) break;
        if (!firstPrompt && m) firstPrompt = text.slice(0, 200);
        push('user', ts, !m, [{ kind: 'text', text }]);
        break;
      }
      case 'PLANNER_RESPONSE': {
        const blocks = [];
        if (o.thinking) blocks.push({ kind: 'thinking', text: String(o.thinking) });
        const text = String(o.content || '').trim();
        if (text) blocks.push({ kind: 'text', text });
        for (const tc of Array.isArray(o.tool_calls) ? o.tool_calls : [])
          blocks.push({ kind: 'tool_use', name: (tc && tc.name) || 'tool', input: (tc && tc.args) || {} });
        push('assistant', ts, false, blocks);
        break;
      }
      case 'CHECKPOINT':
        push('system', ts, false,
          [{ kind: 'compact', text: '—— 上下文已压缩，此处之前的内容被摘要替代 ——' }]);
        break;
      case 'CONVERSATION_HISTORY': { // 续接注入的整段历史：多数为空；有内容就折叠收起
        const text = String(o.content || '').trim();
        if (text) push('user', ts, true, [{ kind: 'text', text }], { compact: true });
        break;
      }
      case 'ERROR_MESSAGE':
        push('system', ts, false,
          [{ kind: 'text', text: '⚠ ' + String(o.error || o.content || '').trim() }]);
        break;
      case 'SYSTEM_MESSAGE': { // 系统注入的提示，按 meta 隐藏
        const text = String(o.content || '').trim();
        if (text) push('user', ts, true, [{ kind: 'text', text }]);
        break;
      }
      default: { // 其余都是工具执行步骤（VIEW_FILE / RUN_COMMAND / CODE_ACTION…），content 即结果
        if (!o.type) break;
        let text = String(o.content || '')
          .replace(/^Created At:[^\n]*\n?/, '').replace(/^Completed At:[^\n]*\n?/, '').trim();
        const isError = !!o.error ||
          (o.exit_code !== undefined && o.exit_code !== null && o.exit_code !== 0);
        if (o.error) text = (text ? text + '\n' : '') + '⚠ ' + String(o.error).trim();
        if (text) push('user', ts, false, [{ kind: 'tool_result', text, isError }]);
        break;
      }
    }
  }
  const meta = agyMeta().get(id) || {};
  const cwd = meta.workspace || '';
  if (!firstTs && meta.firstTs) firstTs = new Date(meta.firstTs).toISOString();
  if (!lastTs && meta.lastTs) lastTs = new Date(meta.lastTs).toISOString();
  return {
    project: agyProject(cwd), id, src: 'agy', threadSource: '',
    title: firstPrompt || '(无标题)', firstPrompt,
    cwd, gitBranch: '', agentName: '', mtime: stat.mtimeMs, firstTs, lastTs,
    lastModel: model, msgCount: messages.length, summaries: [],
    usage: zeroU(), usageByDay: {}, msgsByDay,
    sidechains: [], messages,
  };
}

// 子代理文件的变化也要让缓存失效：取全部相关文件 mtime 拼校验戳
function cacheStamp(filePath) {
  let stamp = String(fs.statSync(filePath).mtimeMs);
  for (const sf of sidechainFiles(filePath.slice(0, -6))) {
    try { stamp += ':' + fs.statSync(sf.path).mtimeMs; } catch { /* */ }
  }
  return stamp;
}
// 在各根目录中定位会话文件，先配置的根优先
function sessionFile(project, id) {
  for (const root of ROOTS) {
    const fp = path.join(root, project, id + '.jsonl');
    if (fs.existsSync(fp)) return fp;
  }
  return null;
}

// app.js 带 mtime 版本号，避开 CDN / 浏览器缓存（改完前端不用清缓存）
const APP_JS = path.join(__dirname, 'app.js');
function appVer() {
  try { return String(Math.round(fs.statSync(APP_JS).mtimeMs)); } catch { return '0'; }
}

// ---------- 收藏（persist 到 favorites.json）----------
const FAVS_PATH = path.join(__dirname, 'favorites.json');
let FAVS = {};
try { FAVS = JSON.parse(fs.readFileSync(FAVS_PATH, 'utf8')); } catch { /* 首次 */ }
function saveFavs() {
  try { fs.writeFileSync(FAVS_PATH, JSON.stringify(FAVS, null, 2)); } catch { /* */ }
}

// ---------- 缓存 + 磁盘索引 ----------
// cache：全量会话（含消息体）LRU，按需加载，仅打开会话 / 搜索命中候选时填充。
// INDEX：轻量摘要索引（无消息体），常驻内存 + 持久化 index.json，列表 / 统计只碰它。摘要小，常驻不肉疼。
// BLOBS：搜索用的小写正文/思考 blob，体量大 —— 惰性从 blobs.json 读盘，闲置 BLOB_TTL 后释放内存。
//   搜索先用 blob 粗筛，只有命中候选才回落到全量解析。blob 自带 stamp，与摘要 stamp 不符即按需重建。
const cache = new Map();
const CACHE_MAX = 100;
const NAME_RE = /^[A-Za-z0-9._-]+$/; // 防路径穿越
// ---------- 数据源适配器 ----------
// claude / codex 的差异全部收敛在这张表里，索引 / 加载 / 删除的主流程与源无关；
// 以后再接别的 agent CLI 历史 = 加一个对象。每个源实现：
//   enabled          — 是否启用（refreshIndex 是否扫描）
//   key(project,id)  — 索引 / 缓存 / 收藏键（claude 保持 project/<id>，老 index.json 继续有效）
//   scan(visit)      — 遍历全部会话文件，对每个调 visit(project, id, filePath)；
//                      项目名要解析后才知道的源（codex 按 cwd 推导）传 null
//   locate(project,id)、stamp(filePath)、parse(project,id,filePath)
//   listable(session)— 解析后是否进列表（codex 用来滤 subagent 线程）
//   remove(filePath) — 删除会话文件（连带附属文件），失败回 false
const SOURCES = {
  claude: {
    enabled: true,
    key: (project, id) => project + '/' + id,
    scan(visit) { // roots/<project>/<id>.jsonl：目录名即项目名，排除规则在这里就能挡住
      for (const root of ROOTS) {
        let projects;
        try { projects = fs.readdirSync(root); } catch { continue; }
        for (const project of projects) {
          if (isExcluded(project) || !NAME_RE.test(project)) continue;
          const pdir = path.join(root, project);
          let files;
          try {
            if (!fs.statSync(pdir).isDirectory()) continue;
            files = fs.readdirSync(pdir).filter((f) => f.endsWith('.jsonl'));
          } catch { continue; }
          for (const f of files) {
            const id = f.slice(0, -6);
            if (NAME_RE.test(id)) visit(project, id, path.join(pdir, f));
          }
        }
      }
    },
    locate: sessionFile,
    stamp: cacheStamp,
    parse: parseSession,
    listable: () => true,
    remove(fp) { // 连带 <id>/subagents 子代理目录
      try { fs.unlinkSync(fp); } catch { return false; }
      try { fs.rmSync(fp.slice(0, -6), { recursive: true, force: true }); } catch { /* 无子代理目录 */ }
      return true;
    },
  },
  codex: {
    enabled: CODEX_ENABLED,
    key: (project, id) => 'codex:' + id, // id 全局唯一，项目名（cwd 推导，可变）不进键
    scan(visit) { // sessions/YYYY/MM/DD/rollout-*.jsonl
      for (const root of CODEX_ROOTS) {
        let days;
        try {
          days = fs.readdirSync(root).filter((y) => /^\d{4}$/.test(y)).flatMap((y) =>
            fs.readdirSync(path.join(root, y)).filter((m) => /^\d{2}$/.test(m)).flatMap((m) =>
              fs.readdirSync(path.join(root, y, m)).filter((d) => /^\d{2}$/.test(d))
                .map((d) => path.join(root, y, m, d))));
        } catch { continue; }
        for (const dir of days) {
          let files;
          try { files = fs.readdirSync(dir).filter((f) => f.endsWith('.jsonl')); } catch { continue; }
          for (const f of files) {
            const id = f.slice(0, -6);
            if (NAME_RE.test(id) && CODEX_ID_RE.test(id)) visit(null, id, path.join(dir, f));
          }
        }
      }
    },
    locate: (project, id) => codexFile(id),
    stamp: (fp) => String(fs.statSync(fp).mtimeMs),
    parse: (project, id, fp) => parseCodexSession(id, fp),
    // 子代理线程（guardian 审批评估等）是机器噪音，不进列表；文件保留，直连 id 仍可打开
    listable: (s) => s.threadSource !== 'subagent',
    remove(fp) {
      try { fs.unlinkSync(fp); } catch { return false; }
      return true;
    },
  },
  agy: {
    enabled: AGY_ENABLED,
    key: (project, id) => 'agy:' + id, // uuid 全局唯一，项目名（workspace 推导）不进键
    scan(visit) { // brain/<uuid>/.system_generated/logs/transcript(_full).jsonl
      for (const root of AGY_ROOTS) {
        let ids;
        try { ids = fs.readdirSync(path.join(root, 'brain')); } catch { continue; }
        for (const id of ids) {
          if (!AGY_ID_RE.test(id) || !NAME_RE.test(id)) continue;
          const fp = agyFile(id);
          if (fp) visit(null, id, fp);
        }
      }
    },
    locate: (project, id) => agyFile(id),
    stamp: (fp) => String(fs.statSync(fp).mtimeMs),
    parse: (project, id, fp) => parseAgySession(id, fp),
    listable: () => true,
    remove(fp) { // 删除整个 brain/<id> 目录，连带主存储 conversations/<id>.db|.pb
      const bdir = path.dirname(path.dirname(path.dirname(fp)));
      const id = path.basename(bdir);
      if (!AGY_ID_RE.test(id)) return false;
      try { fs.rmSync(bdir, { recursive: true, force: true }); } catch { return false; }
      for (const root of AGY_ROOTS) {
        for (const ext of ['.db', '.pb']) {
          try { fs.unlinkSync(path.join(root, 'conversations', id + ext)); } catch { /* 不存在 */ }
        }
      }
      return true;
    },
  },
};
function srcOf(q) { return SOURCES[q] ? q : 'claude'; }
function keyOf(src, project, id) { return SOURCES[srcOf(src)].key(project, id); }
const INDEX_PATH = process.env.INDEX_PATH || path.join(__dirname, 'index.json');
const BLOBS_PATH = process.env.INDEX_BLOBS_PATH || INDEX_PATH.replace(/\.json$/, '') + '.blobs.json';
const BLOB_TTL = Number(process.env.BLOB_TTL_MS) || 5 * 60 * 1000; // 闲置多久后释放 blob 内存
const INDEX = new Map(); // key -> { stamp, summary }
(function loadIndex() {
  try {
    const raw = JSON.parse(fs.readFileSync(INDEX_PATH, 'utf8'));
    if (raw && raw.version === 3 && raw.entries)
      for (const [k, v] of Object.entries(raw.entries)) INDEX.set(k, v);
  } catch { /* 无索引或旧版本 → 首次请求时重建 */ }
})();
let saveTimer = null;
function scheduleSave() {
  if (saveTimer) return;
  saveTimer = setTimeout(saveIndex, 3000);
  if (saveTimer.unref) saveTimer.unref();
}
function saveIndex() {
  if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; }
  writeJsonAtomic(INDEX_PATH, { version: 3, entries: Object.fromEntries(INDEX) });
}
function writeJsonAtomic(fp, obj) {
  try {
    const tmp = fp + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(obj));
    fs.renameSync(tmp, fp); // 原子替换，避免读到半截文件
  } catch { /* ignore */ }
}

// ---- blob（惰性载入 / 闲置释放）----
let BLOBS = null;          // key -> { stamp, text, think }；null = 未载入 / 已释放
let blobsDirty = false, blobsAccess = 0, blobsTimer = null;
function armBlobRelease() {
  blobsAccess = Date.now();
  if (blobsTimer) return;
  blobsTimer = setTimeout(releaseBlobs, BLOB_TTL);
  if (blobsTimer.unref) blobsTimer.unref();
}
function releaseBlobs() {
  blobsTimer = null;
  if (Date.now() - blobsAccess < BLOB_TTL - 500) { armBlobRelease(); return; } // 期间又用过，续期
  if (blobsDirty) saveBlobs();
  BLOBS = null;             // 释放大块内存，下次搜索再从盘上读回
}
function ensureBlobs() {
  armBlobRelease();
  if (BLOBS) return BLOBS;
  BLOBS = new Map();
  try {
    const raw = JSON.parse(fs.readFileSync(BLOBS_PATH, 'utf8'));
    if (raw && raw.version === 1 && raw.blobs)
      for (const [k, v] of Object.entries(raw.blobs)) BLOBS.set(k, v);
  } catch { /* 无文件或损坏 → 缺失的 blob 按需重建 */ }
  return BLOBS;
}
function saveBlobs() {
  if (!BLOBS) return;
  writeJsonAtomic(BLOBS_PATH, { version: 1, blobs: Object.fromEntries(BLOBS) });
  blobsDirty = false;
}
// 搜索 blob：正文（含工具名）与思考分开存，粗筛时按「含思考」开关决定是否并入
function searchBlobs(s) {
  let text = '', think = '';
  const add = (m) => {
    if (m.isMeta) return;
    for (const b of m.blocks) {
      const t = b.text || (b.kind === 'tool_use' ? b.name : '');
      if (!t) continue;
      if (b.kind === 'thinking') think += t.toLowerCase() + '\n';
      else text += t.toLowerCase() + '\n';
    }
  };
  for (const m of s.messages) add(m);
  for (const sc of s.sidechains) for (const m of sc.messages) add(m);
  return { text, think };
}
// 取某会话的 blob：blobs.json 里缺失 / stamp 过期就解析该会话重建（自愈）
function blobFor(sum) {
  const key = keyOf(sum.src, sum.project, sum.id);
  const stamp = INDEX.get(key) && INDEX.get(key).stamp;
  const store = ensureBlobs();
  let b = store.get(key);
  if (b && b.stamp === stamp) return b;
  const s = loadSession(sum.project, sum.id, sum.src);
  if (!s) return { stamp, text: '', think: '' };
  b = { stamp, ...searchBlobs(s) };
  store.set(key, b);
  blobsDirty = true; scheduleBlobSave();
  return b;
}
let blobSaveTimer = null;
function scheduleBlobSave() {
  if (blobSaveTimer) return;
  blobSaveTimer = setTimeout(() => { blobSaveTimer = null; if (blobsDirty) saveBlobs(); }, 3000);
  if (blobSaveTimer.unref) blobSaveTimer.unref();
}
function indexEntry(session, stamp) { return { stamp, summary: summary(session) }; }

// 扫描各根目录增量刷新 INDEX（只更新摘要，不碰 blob）；目录遍历有成本，1s 节流
let lastScan = 0;
function refreshIndex(force) {
  const now = Date.now();
  if (!force && now - lastScan < 1000) return;
  lastScan = now;
  const live = new Set();
  let changed = false;
  for (const S of Object.values(SOURCES)) {
    if (!S.enabled) continue;
    S.scan((project, id, fp) => {
      const key = S.key(project, id);
      if (live.has(key)) return; // 同名会话多根并存时先配置的根优先
      live.add(key);
      let stamp;
      try { stamp = S.stamp(fp); } catch { return; }
      const hit = INDEX.get(key);
      if (hit && hit.stamp === stamp) return; // 未变，跳过重解析
      try {
        const s = S.parse(project, id, fp);
        if (!s.msgCount || !S.listable(s)) { if (INDEX.delete(key)) changed = true; return; }
        INDEX.set(key, indexEntry(s, stamp));
        if (BLOBS) { BLOBS.set(key, { stamp, ...searchBlobs(s) }); blobsDirty = true; } // 已载入才顺带更新
        changed = true;
      } catch { /* skip */ }
    });
  }
  for (const key of [...INDEX.keys()]) {          // 清理已删除 / 已排除的会话
    if (!live.has(key)) { INDEX.delete(key); if (BLOBS) BLOBS.delete(key); changed = true; }
  }
  if (changed) { scheduleSave(); if (BLOBS && blobsDirty) scheduleBlobSave(); }
}
function loadSession(project, id, src) {
  const S = SOURCES[srcOf(src)];
  if (!NAME_RE.test(project || '') || !NAME_RE.test(id || '')) return null;
  if (isExcluded(project)) return null;
  const filePath = S.locate(project, id);
  if (!filePath) return null;
  const stamp = S.stamp(filePath);
  const key = S.key(project, id);
  const hit = cache.get(key);
  if (hit && hit.stamp === stamp) {
    cache.delete(key); cache.set(key, hit); // LRU 提前
    return hit.session;
  }
  const session = S.parse(project, id, filePath);
  // 项目名由解析推导的源（codex 按 cwd）：请求的 project 与推导不符（或被排除）就当不存在
  if (session.project !== project || isExcluded(session.project)) return null;
  cache.set(key, { stamp, session });
  const ie = INDEX.get(key);              // 顺带刷新摘要索引，保持索引与打开的会话同步
  if (!ie || ie.stamp !== stamp) { INDEX.set(key, indexEntry(session, stamp)); scheduleSave(); }
  if (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value);
  return session;
}
// 删除会话：删掉会话文件（连带附属文件，见各源 remove），并清掉各级缓存 / 索引 / 收藏
function deleteSession(project, id, src) {
  src = srcOf(src);
  const S = SOURCES[src];
  if (!loadSession(project, id, src)) return false; // 顺带完成白名单 / 排除 / 项目归属校验
  const filePath = S.locate(project, id);
  if (!filePath || !S.remove(filePath)) return false;
  const key = S.key(project, id);
  cache.delete(key); INDEX.delete(key);
  if (BLOBS) BLOBS.delete(key);
  scheduleSave(); if (BLOBS) scheduleBlobSave();
  if (FAVS[key]) { delete FAVS[key]; saveFavs(); }
  return true;
}
function listAll() {
  refreshIndex();
  const out = [];
  for (const e of INDEX.values()) {
    if (isExcluded(e.summary.project)) continue;
    if (e.summary.msgCount) out.push(e.summary);
  }
  out.sort((a, b) => b.mtime - a.mtime);
  return out;
}
function summary(s) {
  return {
    project: s.project, id: s.id, src: s.src || 'claude',
    title: s.title, firstPrompt: s.firstPrompt,
    cwd: s.cwd, gitBranch: s.gitBranch, agentName: s.agentName, mtime: s.mtime,
    firstTs: s.firstTs, lastTs: s.lastTs, lastModel: s.lastModel || '',
    msgCount: s.msgCount,
    sidechainCount: s.sidechains.length, hasSummary: s.summaries.length > 0,
    usage: s.usage, usageByDay: s.usageByDay, msgsByDay: s.msgsByDay,
  };
}
function search(q, includeThinking, src) {
  src = srcOf(src);
  const query = q.toLowerCase().trim();
  if (!query) return [];
  const terms = query.split(/\s+/).filter(Boolean);
  refreshIndex();
  const results = [];
  for (const e of INDEX.values()) {
    const sum = e.summary;
    if ((sum.src || 'claude') !== src) continue;   // claude / codex 两页独立搜索
    if (isExcluded(sum.project)) continue;
    const titleLc = (sum.title + ' ' + (sum.firstPrompt || '')).toLowerCase();
    const titleHit = terms.every((term) => titleLc.includes(term));
    // 粗筛：全部词都在正文（或含思考时并入思考）blob 里，才可能有精确命中
    const blob = blobFor(sum);
    const hay = includeThinking ? blob.text + '\n' + blob.think : blob.text;
    const bodyCand = terms.every((term) => hay.includes(term));
    if (!bodyCand && !titleHit) continue;
    if (!bodyCand) { results.push({ ...sum, hits: 0, titleHit: true, snippet: null }); continue; }
    const s = loadSession(sum.project, sum.id, sum.src); // 命中候选才全量解析，逐块算精确命中数与片段
    if (!s) continue;
    let hits = 0, snippet = null;
    const scan = (m, side) => {
      if (m.isMeta) return;
      for (const b of m.blocks) {
        if (b.kind === 'thinking' && !includeThinking) continue;
        const t = b.text || (b.kind === 'tool_use' ? b.name : '');
        if (!t) continue;
        const lc = t.toLowerCase();
        if (terms.every((term) => lc.includes(term))) {
          hits++;
          if (!snippet) snippet = makeSnippet(t, terms, side ? 'agent' : m.role, b.kind);
        }
      }
    };
    for (const m of s.messages) scan(m, false);
    for (const sc of s.sidechains) for (const m of sc.messages) scan(m, true);
    if (hits || titleHit) results.push({ ...summary(s), hits, titleHit, snippet });
  }
  results.sort((a, b) => (b.hits + (b.titleHit ? 0.5 : 0)) -
                         (a.hits + (a.titleHit ? 0.5 : 0)) || b.mtime - a.mtime);
  return results.slice(0, 100);
}
function makeSnippet(text, terms, role, kind) {
  const lc = text.toLowerCase();
  let idx = -1;
  for (const term of terms) { const i = lc.indexOf(term); if (i >= 0) { idx = i; break; } }
  if (idx < 0) idx = 0;
  const start = Math.max(0, idx - 60);
  let frag = text.slice(start, idx + 140).replace(/\s+/g, ' ');
  if (start > 0) frag = '…' + frag;
  return { role, kind, text: frag };
}

// ---------- Markdown 导出 ----------
function mdMessages(L, messages, aiName) {
  for (const m of messages) {
    if (m.isMeta) continue;
    const who = m.role === 'user' ? '🧑 你' : m.role === 'system' ? '⚙ 系统'
      : '🤖 ' + (aiName || 'Claude');
    const t = m.ts ? '  _' + new Date(m.ts).toISOString() + '_' : '';
    L.push('---', '', '### ' + who + (m.compact ? '（压缩摘要）' : '') + t, '');
    for (const b of m.blocks) {
      if (b.kind === 'text') { L.push(b.text, ''); }
      else if (b.kind === 'compact') { L.push('> 📦 ' + b.text, ''); }
      else if (b.kind === 'thinking') {
        L.push('<details><summary>💭 思考</summary>', '', '```', b.text, '```', '', '</details>', '');
      } else if (b.kind === 'tool_use') {
        L.push('**🔧 ' + b.name + '**', '', '```json',
          JSON.stringify(b.input, null, 2) || '', '```', '');
      } else if (b.kind === 'tool_result') {
        L.push('**' + (b.isError ? '⚠ 工具报错' : '↩ 工具结果') + '**', '', '```',
          (b.text || '').slice(0, 20000), '```', '');
      }
    }
  }
}
function toMarkdown(s) {
  const L = [];
  L.push('# ' + s.title, '');
  const meta = [s.project, s.msgCount + ' 条消息',
    s.gitBranch && ('分支 ' + s.gitBranch), s.cwd && ('cwd `' + s.cwd + '`'),
    s.firstTs && new Date(s.firstTs).toISOString()].filter(Boolean);
  L.push('> ' + meta.join(' · '), '');
  for (const sum of s.summaries) {
    L.push('<details><summary>📦 历史摘要（压缩续接）</summary>', '', sum, '', '</details>', '');
  }
  const aiName = s.src === 'codex' ? 'Codex' : 'Claude';
  mdMessages(L, s.messages, aiName);
  for (const sc of s.sidechains) {
    L.push('', '## 🤖 子代理：' + (sc.firstPrompt || sc.agentId), '');
    mdMessages(L, sc.messages, aiName);
  }
  return L.join('\n');
}

// ---------- tmux 桥接（网页控制台）----------
// 思路：不裸搬终端，而是加一层「翻译」——后端 capture-pane 抓屏并解析出 Claude Code 的
// 交互状态（空闲输入框 / 编号选项菜单 / 忙碌中），前端渲染成原生控件；用户的 UI 操作再由
// send-keys 翻译成按键注回 CLI。裸终端画面只作兜底视图。
// /api/file 允许预览的扩展名（会话里 Write/Edit 产出的文档类文件；代码文件看工具块就够了）
const FILE_EXTS = new Set(['.md', '.markdown', '.html', '.htm', '.svg', '.txt', '.json', '.csv', '.log']);
const PANE_RE = /^%\d+$/; // 只接受 tmux pane id（如 %3），防注入 / 选项注入
// send-keys 允许的具名按键白名单（文本走 -l 字面量通道，不查这个表）
const TMUX_KEYS = new Set(['Enter', 'Escape', 'Tab', 'BTab', 'Up', 'Down', 'Left', 'Right',
  'BSpace', 'DC', 'Home', 'End', 'PPage', 'NPage', 'C-c', 'C-u', 'C-d', 'C-l', 'C-r']);
function tmux(args) {
  return new Promise((resolve, reject) => {
    execFile('tmux', args, { timeout: 5000, maxBuffer: 4 * 1024 * 1024 },
      (err, stdout, stderr) => {
        if (!err) return resolve(stdout);
        // execFile 的 err.message 首行是「Command failed: <整条命令>」，真实原因在 stderr
        reject(new Error(String(stderr || '').trim() || String(err.message || err)));
      });
  });
}
const PANE_FMT = ['#{pane_id}', '#{session_name}', '#{window_index}', '#{window_name}',
  '#{pane_index}', '#{pane_current_command}', '#{pane_current_path}',
  '#{pane_active}', '#{pane_width}', '#{pane_height}',
  '#{pane_pid}'].join('\u241f'); // ␟：可打印的罕见分隔符（tmux 会把真控制字符转成八进制字面量输出，不能用真正的 US）
async function tmuxPanes() {
  let out = '';
  try { out = await tmux(['list-panes', '-a', '-F', PANE_FMT]); }
  catch { return []; } // tmux 未装或无服务 → 空列表
  return out.split('\n').filter(Boolean).map((l) => {
    const [id, session, win, winName, paneIdx, cmd, cwd, active, w, h, pid] = l.split('\u241f');
    return { id, session, win: +win, winName, paneIdx: +paneIdx, cmd, cwd,
      active: active === '1', w: +w, h: +h, pid: +pid || 0,
      claude: /^(claude|codex|agy|gemini|node|bun)$/.test(cmd) }; // agent CLI 的进程名可能是 node/bun
  });
}
// ---------- 服务器状态（内存/负载 + 「还能再开几个 agent」估算）----------
// 全走 /proc（Linux），读不到就退回 os.* 或缺省——只影响状态展示，不影响主功能
const PAGE_SIZE = 4096; // x86_64/aarch64 Linux 默认页大小；Node 没有 getpagesize
function parseMeminfo(text) {
  const o = {};
  for (const m of String(text).matchAll(/^(\w+):\s+(\d+) kB/gm)) o[m[1]] = m[2] * 1024;
  return o;
}
// /proc/<pid>/stat：comm 在括号里可含空格和括号，从最后一个 ')' 之后按空格数字段
// （state 是第 0 段 → ppid 第 1 段、rss 第 21 段，rss 单位是页）
function parseProcStat(line) {
  const cp = String(line).lastIndexOf(')');
  if (cp < 0) return null;
  const f = line.slice(cp + 2).split(' ');
  return { ppid: +f[1] || 0, rss: (+f[21] || 0) * PAGE_SIZE };
}
function readProcs() {
  const procs = new Map(); // pid -> { ppid, rss }
  let dirs = [];
  try { dirs = fs.readdirSync('/proc'); } catch { return procs; }
  for (const d of dirs) {
    if (!/^\d+$/.test(d)) continue;
    try {
      const st = parseProcStat(fs.readFileSync('/proc/' + d + '/stat', 'utf8'));
      if (st) procs.set(+d, st);
    } catch { /* 进程刚退出 */ }
  }
  return procs;
}
// 进程树 RSS：从 pane_pid 起沿子进程求和（CLI 还会 fork node / rg / shell 等）
function subtreeRss(procs, pid) {
  const kids = new Map();
  for (const [p, st] of procs) {
    if (!kids.has(st.ppid)) kids.set(st.ppid, []);
    kids.get(st.ppid).push(p);
  }
  let sum = 0;
  const seen = new Set(), q = [pid];
  while (q.length) {
    const p = q.pop();
    if (seen.has(p) || !procs.has(p)) continue;
    seen.add(p);
    sum += procs.get(p).rss;
    for (const c of kids.get(p) || []) q.push(c);
  }
  return sum;
}
const DEFAULT_AGENT_RSS = 500 * 1024 * 1024; // 没有现成窗格可测时按 500MB/个 估
function sysSnapshot(panes) {
  let mi = {};
  try { mi = parseMeminfo(fs.readFileSync('/proc/meminfo', 'utf8')); } catch { /* 非 Linux */ }
  const memTotal = mi.MemTotal || os.totalmem();
  const memAvail = mi.MemAvailable !== undefined ? mi.MemAvailable : os.freemem();
  const procs = readProcs();
  const paneMem = {};
  for (const pn of panes) if (pn.pid) paneMem[pn.id] = subtreeRss(procs, pn.pid);
  // 每个 agent 会话的开销：现有 agent 窗格进程树 RSS 的中位数（刚启动、还没干活的树
  // 太小，不足 64MB 的不当样本）；一个样本都没有就按默认值
  const samples = panes.filter((p) => p.claude && paneMem[p.id] > 64 * 1024 * 1024)
    .map((p) => paneMem[p.id]).sort((a, b) => a - b);
  const perAgent = samples.length ? samples[Math.floor(samples.length / 2)] : DEFAULT_AGENT_RSS;
  // 给系统留余量（总内存 8% 且至少 256MB），别真把可用内存吃干
  const reserve = Math.max(256 * 1024 * 1024, memTotal * 0.08);
  const canOpen = Math.max(0, Math.floor((memAvail - reserve) / perAgent));
  let disk = null;
  try {
    const st = fs.statfsSync(os.homedir());
    disk = { total: st.blocks * st.bsize, avail: st.bavail * st.bsize };
  } catch { /* */ }
  return {
    mem: { total: memTotal, avail: memAvail },
    swap: mi.SwapTotal ? { total: mi.SwapTotal, free: mi.SwapFree || 0 } : null,
    load: os.loadavg(), cpus: os.cpus().length, disk, paneMem,
    est: { canOpen, perAgent, sampled: samples.length }, // sampled=0 → perAgent 是默认值
  };
}

// 去掉 ANSI 转义（SGR / 光标控制 / OSC 标题等），留纯文本供状态解析
function stripAnsi(s) {
  return String(s)
    .replace(/\u001b\][^\u0007\u001b]*(\u0007|\u001b\\)?/g, '')
    .replace(/\u001b\[[0-9;?:]*[A-Za-z]/g, '')
    .replace(/\u001b[()][0-9A-B]/g, '');
}
// 从终端画面猜 Claude Code 的交互状态：
//   menu — 编号选项菜单（权限确认 / AskUserQuestion / 各类选择器）：question + options
//   busy — 正在干活（esc 可打断）
//   idle — 空闲，输入框等待输入
//   unknown — 识别不了（非 Claude 界面等），前端只给裸终端
function paneState(raw) {
  // 去转义后再剥掉对话框的竖线边框，便于按行匹配
  const lines = stripAnsi(raw).split('\n').map((l) =>
    l.replace(/^\s*[│┃]\s?/, '').replace(/\s*[│┃]\s*$/, '').replace(/\s+$/, ''));
  while (lines.length && !lines[lines.length - 1].trim()) lines.pop();
  const tail = lines.slice(-45);
  const busy = /esc to interrupt/i.test(tail.join('\n'));
  // 状态栏里的权限模式（manual mode / accept edits / plan mode…），供前端显示在 ⇧⇥ 按钮上
  let mode = '';
  for (let k = tail.length - 1; k >= Math.max(0, tail.length - 6); k--) {
    const m = tail[k].match(
      /(manual mode|auto-accept|accept edits|plan mode|bypass(?:ing)? permissions|auto mode)/i);
    if (m) { mode = m[1].toLowerCase(); break; }
  }
  // 找可见区里最后一个「(❯|›|>) 1. xxx」编号选项块（❯ Claude / › codex / > agy 的光标）。
  // 不能要求贴着底部：块下方常有提示行（Esc to cancel · Press enter to confirm…）/ 状态栏。
  const OPT_RE = /^\s*([>❯›]\s*)?(\d+)[.)]\s+(.+)$/;
  const BORDER_RE = /^[─╌╭╮╰╯]+$/;
  let end = -1;
  for (let k = tail.length - 1; k >= 0; k--) {
    if (OPT_RE.test(tail[k])) { end = k; break; }
  }
  if (end >= 0) {
    // 自底向上收集编号行。选项之间允许夹少量非编号行（AskUserQuestion 的选项描述、
    // codex 右列描述换出的续行、分隔线），夹行归属其上方最近的选项当 desc。
    const opts = [];
    let start = end, gap = 0, pend = [];
    for (let k = end; k >= 0; k--) {
      const m = tail[k].match(OPT_RE);
      if (!m) {
        if (++gap > 3) break;
        const t = tail[k].trim();
        if (t && !BORDER_RE.test(t)) pend.unshift(t);
        continue;
      }
      if (opts.length && +m[2] !== opts[0].n - 1) break; // 序号不衔接 → 上面是别的列表
      gap = 0; start = k;
      // codex 把选项描述放同行右侧（空格对齐的右列，列距最窄 2 空格），与下方续行一起归入 desc
      const parts = m[3].trim().split(/\s{2,}/);
      const desc = parts.slice(1).concat(pend).join(' ');
      pend = [];
      opts.unshift({ n: +m[2], label: parts[0], sel: !!m[1], ...(desc ? { desc } : {}) });
      if (+m[2] === 1) break;
    }
    // 序号必须从 1 连续递增、且恰有一行带光标，才认为是菜单
    // （避免把正文里的有序列表、markdown 引用块里的列表当菜单）
    if (opts.length >= 2 && opts[0].n === 1 && opts.filter((o) => o.sel).length === 1) {
      let question = '';
      for (let k = start - 1; k >= 0; k--) { // 往上找最近的非空行当问题（跳过边框线）
        const t = tail[k].trim();
        if (!t || BORDER_RE.test(t)) continue;
        question = t; break;
      }
      // codex 的菜单按数字只移动光标，得再回车确认；从块下方的提示行识别这形态
      const enter =
        /press enter to (confirm|continue|select)/i.test(tail.slice(end + 1).join('\n'));
      return { kind: 'menu', question, options: opts, mode, ...(enter ? { enter: true } : {}) };
    }
  }
  // 无编号的光标菜单（agy 的信任对话框 / 模型选择器等）：只能 ↑/↓ 移动 + 回车确认。
  // 锚点是「↑/↓ …」提示行，从它往上收连续的选项行；点选由前端换算成方向键（nav 标记）。
  const hint = tail.map((l) => /↑\/↓/.test(l)).lastIndexOf(true);
  if (hint > 0 && hint >= tail.length - 12) { // 提示行必须贴近底部，防止正文里的 ↑/↓ 误触发
    const opts = [];
    let start = hint, gap = 0;
    for (let k = hint - 1; k >= 0 && opts.length <= 20; k--) {
      const l = tail[k];
      // 块内的空行 / 滑杆等装饰行 / 深缩进的说明行可跳过（连跳有上限）
      if (!l.trim() || /[━◂▸◉]/.test(l) || /^\s{4,}/.test(l)) {
        if (++gap > 5) break;
        continue;
      }
      const m = l.match(/^(?:([>❯›])\s+|\s{2,3})(\S.*)$/);
      if (!m) break; // 边框 / 顶格标题 → 选项块到头
      gap = 0; start = k;
      const parts = m[2].trim().split(/\s{2,}/); // 右列备注（(current) 等）拆进 desc
      opts.unshift({ label: parts[0], sel: !!m[1],
        ...(parts.length > 1 ? { desc: parts.slice(1).join(' ') } : {}) });
    }
    // 恰有一行光标、至少两个选项才算（防把普通缩进文本认成菜单）
    if (opts.length >= 2 && opts.filter((o) => o.sel).length === 1) {
      opts.forEach((o, k) => { o.i = k; });
      let question = '';
      for (let k = start - 1; k >= 0; k--) {
        const t = tail[k].trim();
        if (!t || /^[─╌╭╮╰╯]+$/.test(t)) continue;
        question = t; break;
      }
      return { kind: 'menu', question, options: opts, mode, nav: true };
    }
  }
  // agy 干活时输入框还挂在屏上，得先靠盲文点阵转轮（⣯ Generating… 之类）认出 busy
  if (busy || tail.some((l) => /^\s*[⠀-⣿]+\s+\S/.test(l))) return { kind: 'busy', mode };
  for (let k = tail.length - 1; k >= Math.max(0, tail.length - 8); k--) {
    if (/^[>❯›]$/.test(tail[k]) || /^[>❯›]\s/.test(tail[k])) return { kind: 'idle', mode }; // 底部的输入提示符
  }
  return { kind: 'unknown', mode };
}

// ---------- HTTP ----------
function sendJSON(res, obj, code = 200) {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(obj));
}
function readBody(req) {
  return new Promise((resolve) => {
    let d = '';
    req.on('data', (c) => { d += c; if (d.length > 1e5) req.destroy(); });
    req.on('end', () => resolve(d));
    req.on('error', () => resolve(''));
  });
}
function setSession(res) {
  const tok = signToken({ exp: Date.now() + SESSION_TTL });
  const parts = ['chv_sid=' + tok, 'HttpOnly', 'SameSite=Lax', 'Path=' + COOKIE_PATH,
    'Max-Age=' + Math.floor(SESSION_TTL / 1000)];
  if (SECURE_COOKIE) parts.push('Secure');
  res.setHeader('Set-Cookie', parts.join('; '));
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  const p = url.pathname;
  try {
    // 页面：始终可取（无数据），前端凭 /api/me 决定显示登录还是内容
    if (p === '/' || p === '/index.html') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache' });
      res.end(HTML.replace('__APPVER__', appVer()));
      return;
    }
    if (p === '/app.js') {
      res.writeHead(200, {
        'Content-Type': 'application/javascript; charset=utf-8',
        'Cache-Control': 'no-cache',
      });
      res.end(fs.readFileSync(APP_JS));
      return;
    }
    if (p === '/api/me') {
      sendJSON(res, { authed: isAuthed(req), codex: CODEX_ENABLED, agy: AGY_ENABLED });
      return;
    }
    if (p === '/api/login' && req.method === 'POST') {
      const ip = clientIp(req);
      const lock = checkLock(ip);
      if (lock) { sendJSON(res, { error: '尝试过多，请 ' + lock + ' 秒后再试' }, 429); return; }
      let body = {};
      try { body = JSON.parse(await readBody(req)); } catch { /* */ }
      if (typeof body.password === 'string' && tsafeEqual(body.password, PASSWORD)) {
        recordOk(ip); setSession(res); sendJSON(res, { ok: true }); return;
      }
      recordFail(ip);
      await new Promise((r) => setTimeout(r, 400)); // 拖慢暴力破解
      sendJSON(res, { error: '密码错误' }, 401); return;
    }
    if (p === '/api/logout') {
      res.setHeader('Set-Cookie', 'chv_sid=; Path=' + COOKIE_PATH + '; Max-Age=0');
      sendJSON(res, { ok: true }); return;
    }

    // 鉴权：登录会话，或限定单个会话的只读分享 token（?share=）
    const authed = isAuthed(req);
    const shareTok = url.searchParams.get('share');
    const share = shareTok ? verifyToken(shareTok) : null; // {sp, si, sr?, exp}
    const src = srcOf(url.searchParams.get('src')); // 数据源：claude（默认）| codex
    const canRead = (project, id) =>
      authed || (!!share && share.sp === project && share.si === id && srcOf(share.sr) === src);

    if (p === '/api/session') {
      const project = url.searchParams.get('project'), id = url.searchParams.get('id');
      if (!canRead(project, id)) { sendJSON(res, { error: 'unauthorized' }, 401); return; }
      const s = loadSession(project, id, src);
      if (!s) { sendJSON(res, { error: 'not found' }, 404); return; }
      // meta=1：只回元信息（供实时轮询比对），不带消息体
      if (url.searchParams.get('meta') === '1') {
        sendJSON(res, { ...summary(s), total: s.msgCount }); return;
      }
      // 分页：limit 条、结束于 before（不含）；limit=0 表示全量
      let limit = url.searchParams.has('limit') ? +url.searchParams.get('limit') : 80;
      if (!Number.isFinite(limit) || limit < 0) limit = 80;
      let before = url.searchParams.has('before') ? +url.searchParams.get('before') : NaN;
      if (!Number.isFinite(before) || before < 0 || before > s.msgCount) before = s.msgCount;
      const start = limit ? Math.max(0, before - limit) : 0;
      sendJSON(res, {
        ...summary(s), summaries: s.summaries,
        sidechains: s.sidechains.map((sc) => ({
          agentId: sc.agentId, firstPrompt: sc.firstPrompt,
          firstTs: sc.firstTs, msgCount: sc.messages.length,
        })),
        total: s.msgCount, offset: start,
        messages: s.messages.slice(start, limit ? before : s.msgCount),
      });
      return;
    }
    if (p === '/api/sidechain') {
      const project = url.searchParams.get('project'), id = url.searchParams.get('id');
      if (!canRead(project, id)) { sendJSON(res, { error: 'unauthorized' }, 401); return; }
      const s = loadSession(project, id, src);
      if (!s) { sendJSON(res, { error: 'not found' }, 404); return; }
      const sc = s.sidechains.find((x) => x.agentId === url.searchParams.get('agent'));
      if (!sc) { sendJSON(res, { error: 'not found' }, 404); return; }
      sendJSON(res, sc); return;
    }
    if (p === '/api/export') {
      const project = url.searchParams.get('project'), id = url.searchParams.get('id');
      if (!canRead(project, id)) { sendJSON(res, { error: 'unauthorized' }, 401); return; }
      const s = loadSession(project, id, src);
      if (!s) { sendJSON(res, { error: 'not found' }, 404); return; }
      const fn = (s.title || 'session').replace(/[^\w一-龥-]+/g, '_').slice(0, 60);
      res.writeHead(200, {
        'Content-Type': 'text/markdown; charset=utf-8',
        'Content-Disposition': "attachment; filename*=UTF-8''" +
          encodeURIComponent(fn + '.md'),
      });
      res.end(toMarkdown(s)); return;
    }

    // 以下均需登录
    if (!authed) { sendJSON(res, { error: 'unauthorized' }, 401); return; }

    if (p === '/api/sessions') { sendJSON(res, listAll()); return; }
    if (p === '/api/file') { // 文件渲染预览：读盘上当前内容（仅登录，不接受分享 token）
      const rawP = String(url.searchParams.get('path') || '');
      const fp = path.resolve(expandHome(rawP));
      const ext = path.extname(fp).toLowerCase();
      if (!rawP.startsWith('/') && !rawP.startsWith('~')) {
        sendJSON(res, { error: '只支持绝对路径' }, 400); return;
      }
      if (!FILE_EXTS.has(ext)) {
        sendJSON(res, { error: '只支持文本类文件预览（md / html / svg / txt / json…）' }, 400); return;
      }
      try {
        const st = fs.statSync(fp);
        if (!st.isFile()) throw new Error('not a file');
        if (st.size > 5 * 1024 * 1024) { sendJSON(res, { error: '文件太大（>5MB）' }, 413); return; }
        sendJSON(res, { path: fp, ext, size: st.size, mtime: st.mtimeMs,
          content: fs.readFileSync(fp, 'utf8') });
      } catch { sendJSON(res, { error: '读不到文件：' + fp }, 404); }
      return;
    }
    if (p === '/api/share' && req.method === 'POST') {
      let body = {};
      try { body = JSON.parse(await readBody(req)); } catch { /* */ }
      if (!NAME_RE.test(body.project || '') || !NAME_RE.test(body.id || '')) {
        sendJSON(res, { error: 'bad request' }, 400); return;
      }
      const days = Math.min(30, Math.max(1, +body.days || 7));
      const exp = Date.now() + days * 86400e3;
      const tok = { sp: body.project, si: body.id, exp };
      const bsrc = srcOf(body.src);
      if (bsrc !== 'claude') tok.sr = bsrc; // 非 claude 源进 token，跨源冒充会被拒
      sendJSON(res, { token: signToken(tok), exp });
      return;
    }
    if (p === '/api/favs') { sendJSON(res, FAVS); return; }
    if (p === '/api/fav' && req.method === 'POST') {
      let body = {};
      try { body = JSON.parse(await readBody(req)); } catch { /* */ }
      if (!NAME_RE.test(body.project || '') || !NAME_RE.test(body.id || '')) {
        sendJSON(res, { error: 'bad request' }, 400); return;
      }
      const key = keyOf(srcOf(body.src), body.project, body.id);
      if (body.fav) FAVS[key] = { note: String(body.note || '').slice(0, 500), ts: Date.now() };
      else delete FAVS[key];
      saveFavs();
      sendJSON(res, { ok: true, favs: FAVS }); return;
    }
    // 删除会话：删掉磁盘上的 .jsonl（含子代理目录），仅登录可用、不接受分享 token
    if (p === '/api/delete' && req.method === 'POST') {
      let body = {};
      try { body = JSON.parse(await readBody(req)); } catch { /* */ }
      if (!NAME_RE.test(body.project || '') || !NAME_RE.test(body.id || '')) {
        sendJSON(res, { error: 'bad request' }, 400); return;
      }
      if (!deleteSession(body.project, body.id, body.src)) {
        sendJSON(res, { error: 'not found' }, 404); return;
      }
      sendJSON(res, { ok: true }); return;
    }
    if (p === '/api/stats') {
      // 时间区间：from/to 为 YYYY-MM-DD（含首含尾，UTC 日期），都不给则统计全部时间
      const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
      const pick = (k) => {
        const v = (url.searchParams.get(k) || '').slice(0, 10);
        return DAY_RE.test(v) ? v : '';
      };
      const from = pick('from'), to = pick('to');
      const ranged = !!(from || to);
      const inRange = (day) => {
        if (!ranged) return true;
        if (!day) return false;               // 无时间戳的记录不计入具体区间
        return (!from || day >= from) && (!to || day <= to);
      };
      const days = {}, byProject = {}, byModel = {};
      const totals = { in: 0, out: 0, cw: 0, cr: 0, msgs: 0, sessions: 0, msgTotal: 0, cost: 0 };
      const zero = () => ({ in: 0, out: 0, cw: 0, cr: 0, msgs: 0, cost: 0 });
      const add = (t, u) => {
        t.in += u.in; t.out += u.out; t.cw += u.cw; t.cr += u.cr; t.msgs += u.msgs;
        t.cost += u.cost || 0;
      };
      let minDay = '', maxDay = '';               // 全库数据的实际边界，给前端做「全部」区间
      const bound = (day) => {
        if (!day) return;
        if (!minDay || day < minDay) minDay = day;
        if (day > maxDay) maxDay = day;
      };
      for (const s of listAll()) {
        if ((s.src || 'claude') !== src) continue; // 两页统计独立
        let hit = false;                          // 该会话在区间内是否有数据
        for (const [day, models] of Object.entries(s.usageByDay || {})) {
          bound(day);
          if (!inRange(day)) continue;
          hit = true;
          const pj = byProject[s.project] = byProject[s.project] || { ...zero(), sessions: 0 };
          for (const [m, u] of Object.entries(models)) {
            add(totals, u);
            add(byModel[m] = byModel[m] || zero(), u);
            add(pj, u);
            if (day) add(days[day] = days[day] || zero(), u);
          }
        }
        for (const [day, n] of Object.entries(s.msgsByDay || {})) {
          bound(day);
          if (!inRange(day)) continue;
          hit = true; totals.msgTotal += n;
        }
        if (hit) {
          totals.sessions++;
          if (byProject[s.project]) byProject[s.project].sessions++;
        }
      }
      sendJSON(res, { totals, days, byProject, byModel, range: { from, to, minDay, maxDay } });
      return;
    }
    if (p === '/api/search') {
      const inc = url.searchParams.get('thinking') === '1';
      sendJSON(res, search(url.searchParams.get('q') || '', inc, src)); return;
    }
    // ---- tmux 桥接（仅登录可用，不接受分享 token；默认关闭需显式开启）----
    if (p === '/api/tmux') { // 窗格列表；未开启时回 enabled:false，前端据此隐藏入口
      if (!TMUX_UI) { sendJSON(res, { enabled: false, panes: [] }); return; }
      sendJSON(res, { enabled: true, panes: await tmuxPanes() }); return;
    }
    if (p === '/api/tmux/sys') { // 服务器状态 + 「还能再开几个 agent」估算（终端页状态条轮询）
      if (!TMUX_UI) { sendJSON(res, { error: 'tmux 桥接未开启' }, 403); return; }
      sendJSON(res, sysSnapshot(await tmuxPanes())); return;
    }
    if (p === '/api/tmux/pane') { // 抓屏 + 状态解析；lite=1 只回状态（会话控制条轮询用）
      if (!TMUX_UI) { sendJSON(res, { error: 'tmux 桥接未开启' }, 403); return; }
      const t = url.searchParams.get('t') || '';
      if (!PANE_RE.test(t)) { sendJSON(res, { error: 'bad target' }, 400); return; }
      let lines = +(url.searchParams.get('lines') || 200);
      if (!Number.isFinite(lines)) lines = 200;
      lines = Math.max(50, Math.min(2000, lines));
      try {
        // 状态解析只看可见屏幕：带滚回历史的话，翻上去的旧菜单（codex 的更新提示等）
        // 会被误认成还挂着；滚回内容只用于裸终端展示
        const vis = await tmux(['capture-pane', '-p', '-e', '-t', t]);
        const state = paneState(vis);
        if (url.searchParams.get('lite') === '1') { sendJSON(res, { state }); return; }
        const text = await tmux(['capture-pane', '-p', '-e', '-t', t, '-S', '-' + lines]);
        sendJSON(res, { text, state });
      } catch (e) {
        sendJSON(res, { error: '抓取失败：' + String(e.message || e).split('\n')[0] }, 404);
      }
      return;
    }
    if (p === '/api/tmux/send' && req.method === 'POST') { // 注入按键：文本走字面量，具名键过白名单
      if (!TMUX_UI) { sendJSON(res, { error: 'tmux 桥接未开启' }, 403); return; }
      let body = {};
      try { body = JSON.parse(await readBody(req)); } catch { /* */ }
      const t = String(body.t || '');
      const text = typeof body.text === 'string' ? body.text : '';
      const keys = Array.isArray(body.keys) ? body.keys.map(String) : [];
      // 键数上限 24：无编号菜单点选要连发一串 ↑/↓ 再回车（见 paneState 的 nav 菜单）
      if (!PANE_RE.test(t) || text.length > 10000 || keys.length > 24 ||
          keys.some((k) => !TMUX_KEYS.has(k)) || (!text && !keys.length)) {
        sendJSON(res, { error: 'bad request' }, 400); return;
      }
      try {
        if (text) await tmux(['send-keys', '-t', t, '-l', '--', text]);
        // codex 等 TUI 按「按键到达间隔」识别粘贴：文本后紧跟的 Enter 会被当成粘贴里的
        // 换行而不提交。隔一拍再发具名键，让 TUI 先把文本当粘贴收完
        if (text && keys.length) await new Promise((r) => setTimeout(r, 150));
        for (const k of keys) await tmux(['send-keys', '-t', t, k]);
        sendJSON(res, { ok: true });
      } catch (e) { sendJSON(res, { error: String(e.message || e).split('\n')[0] }, 500); }
      return;
    }
    if (p === '/api/tmux/new' && req.method === 'POST') { // 新建会话：默认开 shell，可指定目录和启动命令
      if (!TMUX_UI) { sendJSON(res, { error: 'tmux 桥接未开启' }, 403); return; }
      let body = {};
      try { body = JSON.parse(await readBody(req)); } catch { /* */ }
      const name = String(body.name || '').trim();
      const cmd = String(body.cmd || '').trim();
      let cwd = String(body.cwd || '').trim();
      // 会话名不带 . :（tmux target 里是分隔符）、不以 - 开头（防选项注入）
      if (name && !/^[A-Za-z0-9_][A-Za-z0-9_-]{0,49}$/.test(name)) {
        sendJSON(res, { error: '会话名只能用字母数字下划线连字符，且不能以 - 开头' }, 400); return;
      }
      if (cmd.length > 500) { sendJSON(res, { error: 'bad request' }, 400); return; }
      if (cwd) {
        cwd = path.resolve(expandHome(cwd));
        try { if (!fs.statSync(cwd).isDirectory()) throw new Error('not dir'); }
        catch { sendJSON(res, { error: '目录不存在：' + cwd }, 400); return; }
      }
      const args = ['new-session', '-d', '-P', '-F', '#{pane_id}'];
      if (name) args.push('-s', name);
      if (cwd) args.push('-c', cwd);
      // 命令退出后落回 shell 而不是整个会话消失（出门在外拉不起第二次就尴尬了）
      if (cmd) args.push('--', cmd + ' ; exec "${SHELL:-/bin/bash}"');
      try {
        const paneId = (await tmux(args)).trim();
        sendJSON(res, { ok: true, pane: (await tmuxPanes()).find((x) => x.id === paneId) || null });
      } catch (e) {
        const m = String(e.message || e).split('\n')[0];
        sendJSON(res, { error: /^duplicate session/.test(m) ? '会话名已存在：' + name : m }, 500);
      }
      return;
    }
    if (p === '/api/tmux/kill' && req.method === 'POST') { // 关闭窗格（会话的最后一个窗格没了，会话随之结束）
      if (!TMUX_UI) { sendJSON(res, { error: 'tmux 桥接未开启' }, 403); return; }
      let body = {};
      try { body = JSON.parse(await readBody(req)); } catch { /* */ }
      const t = String(body.t || '');
      if (!PANE_RE.test(t)) { sendJSON(res, { error: 'bad target' }, 400); return; }
      try { await tmux(['kill-pane', '-t', t]); sendJSON(res, { ok: true }); }
      catch (e) { sendJSON(res, { error: String(e.message || e).split('\n')[0] }, 500); }
      return;
    }
    if (p === '/api/tmux/resize' && req.method === 'POST') { // 调窗口尺寸：让 TUI 按网页可视区重排
      if (!TMUX_UI) { sendJSON(res, { error: 'tmux 桥接未开启' }, 403); return; }
      let body = {};
      try { body = JSON.parse(await readBody(req)); } catch { /* */ }
      const t = String(body.t || '');
      const hasX = body.x !== undefined, hasY = body.y !== undefined;
      const x = Math.round(+body.x), y = Math.round(+body.y);
      const okX = Number.isFinite(x) && x >= 20 && x <= 500;
      const okY = Number.isFinite(y) && y >= 5 && y <= 300;
      if (!PANE_RE.test(t) || (!hasX && !hasY) || (hasX && !okX) || (hasY && !okY)) {
        sendJSON(res, { error: 'bad request' }, 400); return;
      }
      const args = ['resize-window', '-t', t];
      if (hasX) args.push('-x', String(x));
      if (hasY) args.push('-y', String(y));
      // resize-window 会把窗口设成手动尺寸；本地终端再 attach 想恢复自适应：resize-window -A
      try { await tmux(args); sendJSON(res, { ok: true }); }
      catch (e) { sendJSON(res, { error: String(e.message || e).split('\n')[0] }, 500); }
      return;
    }
    sendJSON(res, { error: 'not found' }, 404);
  } catch (e) {
    sendJSON(res, { error: e.message }, 500);
  }
});

// 供 node:test 复用纯函数（被 require 时不启动服务器）
module.exports = {
  globToRe, isExcluded, extractBlocks, toolResultText, plainText,
  priceFor, costOf, parseSession, parseCodexSession, codexProject, parseAgySession, agyProject,
  searchBlobs, indexEntry,
  refreshIndex, listAll, search, loadSession, deleteSession, summary, INDEX,
  saveIndex, saveBlobs, // 供测试强制落盘（生产走 3s 防抖）
  stripAnsi, paneState, // tmux 桥接的纯函数
  parseMeminfo, parseProcStat, subtreeRss, sysSnapshot, // 服务器状态
};

if (require.main === module) {
  const generated = loadConfig();
  server.listen(PORT, HOST, () => {
    console.log(`Claude 历史查看器：http://${HOST}:${PORT}`);
    console.log('  扫描根目录：' + ROOTS.join('，'));
    if (EXCLUDE.length) console.log('  排除规则：' + (USER_CFG.exclude || []).join('，'));
    console.log('  tmux 桥接：' + (TMUX_UI ? '已开启（网页可向 tmux 会话发送按键）' : '未开启'));
    console.log('  codex 历史：' + (CODEX_ENABLED ? CODEX_ROOTS.join('，') : '未启用'));
    console.log('  agy 历史：' + (AGY_ENABLED ? AGY_ROOTS.join('，') : '未启用'));
    if (generated) {
      console.log('\n  ⚠ 已生成随机登录密码（也写入 secret.json）：');
      console.log('      ' + generated + '\n');
    } else if (process.env.VIEWER_PASSWORD) {
      console.log('  登录密码来自 VIEWER_PASSWORD 环境变量');
    } else {
      console.log('  登录密码来自 secret.json');
    }
    if (!SECURE_COOKIE) console.log('  （SECURE_COOKIE=0：cookie 不带 Secure，仅供本地 http 调试）');
    // 启动后台预热索引（不阻塞 listen 回调），首个请求即可命中缓存
    setTimeout(() => { try { refreshIndex(true); } catch { /* */ } }, 100).unref?.();
  });
  // 退出前把索引与 blob 落盘（pm2 stop / Ctrl-C）
  const flush = () => { try { saveIndex(); if (blobsDirty) saveBlobs(); } finally { process.exit(0); } };
  process.on('SIGINT', flush);
  process.on('SIGTERM', flush);
}

// ---------- 前端（内嵌单页）----------
const HTML = /* html */ `<!doctype html><html lang="zh"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,interactive-widget=resizes-content">
<title>Claude 对话历史</title>
<style>
:root{
  --bg:#f6f7f9;--panel:#fff;--ink:#1c2024;--muted:#7a828c;--line:#e6e8eb;
  --accent:#d97757;--accent-soft:#f7ede8;--user:#eef2ff;--assist:#fff;
  --think:#f3f4f6;--tool:#f0f4f2;--mark:#ffe58a;--field:#f6f7f9;
  --chart:#d97757;
}
@media (prefers-color-scheme:dark){:root:not([data-theme]){
  --bg:#16181c;--panel:#1e2126;--ink:#e6e8eb;--muted:#8b929c;--line:#2b2f36;
  --accent:#e08a6b;--accent-soft:#3a2a23;--user:#232a3d;--assist:#1e2126;
  --think:#23262c;--tool:#1f2723;--mark:#5c4d1a;--field:#16181c;
  --chart:#d3714f;
}}
:root[data-theme=dark]{
  --bg:#16181c;--panel:#1e2126;--ink:#e6e8eb;--muted:#8b929c;--line:#2b2f36;
  --accent:#e08a6b;--accent-soft:#3a2a23;--user:#232a3d;--assist:#1e2126;
  --think:#23262c;--tool:#1f2723;--mark:#5c4d1a;--field:#16181c;
  --chart:#d3714f;
}
*{box-sizing:border-box}
html,body{margin:0;height:100%}
body{font:14px/1.55 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,"PingFang SC","Microsoft YaHei",sans-serif;
  color:var(--ink);background:var(--bg);display:flex;height:100vh;overflow:hidden}
button,select,input{font-family:inherit}
/* 登录 */
#login{position:fixed;inset:0;background:var(--bg);display:none;align-items:center;justify-content:center;z-index:10}
#login .card{background:var(--panel);border:1px solid var(--line);border-radius:16px;
  padding:30px 28px;width:320px;box-shadow:0 12px 40px rgba(0,0,0,.12)}
#login h1{font-size:17px;margin:0 0 4px;display:flex;align-items:center;gap:8px}
#login .dot{width:10px;height:10px;border-radius:50%;background:var(--accent)}
#login p{color:var(--muted);font-size:12.5px;margin:0 0 18px}
#login input{width:100%;padding:11px 12px;border:1px solid var(--line);border-radius:10px;
  background:var(--field);color:var(--ink);font-size:14px;outline:none;margin-bottom:12px}
#login input:focus{border-color:var(--accent)}
#login button{width:100%;padding:11px;border:0;border-radius:10px;background:var(--accent);
  color:#fff;font-size:14px;font-weight:600;cursor:pointer}
#login .err{color:#d64545;font-size:12.5px;min-height:18px;margin-top:8px}
/* 侧栏 */
#side{width:340px;min-width:340px;border-right:1px solid var(--line);background:var(--panel);
  display:flex;flex-direction:column;height:100%}
#side header{padding:12px 14px 10px}
.hrow{display:flex;align-items:center;justify-content:space-between;margin-bottom:10px}
#side h1{font-size:15px;margin:0;display:flex;align-items:center;gap:8px}
#side h1 .dot{width:9px;height:9px;border-radius:50%;background:var(--accent)}
.icons{display:flex;gap:4px}
.iconbtn{border:1px solid var(--line);background:var(--field);color:var(--muted);border-radius:8px;
  width:30px;height:30px;cursor:pointer;font-size:14px;display:flex;align-items:center;justify-content:center}
.iconbtn:hover{color:var(--ink);border-color:var(--accent)}
/* 数据源切换（Claude / Codex 两页独立） */
#srctabs{display:none;margin-bottom:8px;border:1px solid var(--line);border-radius:9px;overflow:hidden}
#srctabs button{flex:1;border:0;background:var(--field);color:var(--muted);padding:6px 0;
  font-size:12.5px;cursor:pointer}
#srctabs button.on{background:var(--accent);color:#fff;font-weight:600}
#q{width:100%;padding:9px 11px;border:1px solid var(--line);border-radius:9px;
  background:var(--field);color:var(--ink);font-size:13px;outline:none}
#q:focus{border-color:var(--accent)}
.filters{display:flex;gap:6px;margin-top:8px;align-items:center;flex-wrap:wrap}
.fdates{display:flex;gap:5px;align-items:center;width:100%;font-size:11px;color:var(--muted)}
.fdates input[type=date]{flex:1;min-width:0;padding:5px 7px;border:1px solid var(--line);
  border-radius:8px;background:var(--field);color:var(--ink);font-size:11.5px;font-family:inherit}
.filters select{flex:1;min-width:0;padding:6px 7px;border:1px solid var(--line);border-radius:8px;
  background:var(--field);color:var(--ink);font-size:12px}
.chk{font-size:11.5px;color:var(--muted);display:flex;align-items:center;gap:4px;cursor:pointer;white-space:nowrap}
#meta{font-size:11px;color:var(--muted);margin-top:8px;display:flex;justify-content:space-between}
#list{flex:1;overflow-y:auto;padding:4px 8px 40px}
.grp{font-size:10.5px;color:var(--muted);text-transform:uppercase;letter-spacing:.05em;
  padding:12px 8px 4px;position:sticky;top:0;background:var(--panel);z-index:1}
.item{padding:8px 10px;border-radius:9px;cursor:pointer;margin-bottom:2px}
.item:hover{background:var(--bg)}
.item.on{background:var(--accent-soft)}
.item .t{font-size:13px;font-weight:560;margin-bottom:2px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.item .r{font-size:10.5px;color:var(--muted);margin-top:3px;display:flex;gap:8px}
.badge{background:var(--accent);color:#fff;border-radius:8px;padding:0 6px;font-size:10px;font-weight:600}
.liveb{color:#3fb950;font-weight:600;white-space:nowrap}
@keyframes lpulse{0%,100%{opacity:1}50%{opacity:.3}}
.liveb::before{content:"● ";animation:lpulse 1.6s ease-in-out infinite}
.snip{font-size:11.5px;color:var(--muted);margin-top:3px;line-height:1.4;
  display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}
mark{background:var(--mark);color:inherit;border-radius:2px;padding:0 1px}
/* 主区 */
#main{flex:1;display:flex;flex-direction:column;height:100%;min-width:0}
#top{padding:12px 22px;border-bottom:1px solid var(--line);background:var(--panel);
  display:none;align-items:flex-start;justify-content:space-between;gap:12px}
#top h2{margin:0;font-size:16px}
#top .sub{font-size:12px;color:var(--muted);margin-top:4px;display:flex;gap:14px;flex-wrap:wrap}
.tbtns{display:flex;gap:8px;align-items:flex-start}
#more{display:none;border:1px solid var(--line);background:var(--field);color:var(--muted);
  border-radius:9px;width:34px;height:30px;font-size:15px;line-height:1;cursor:pointer;flex:none}
#more.on{border-color:var(--accent);color:var(--accent)}
#exp,#fav,#share,#del{border:1px solid var(--line);background:var(--field);color:var(--ink);border-radius:9px;
  padding:7px 12px;font-size:12.5px;cursor:pointer;white-space:nowrap}
#exp:hover,#fav:hover,#share:hover{border-color:var(--accent)}
#del{color:#d64545}
#del:hover{border-color:#d64545;background:rgba(214,69,69,.08)}
.robadge{background:var(--accent-soft);color:var(--accent);border-radius:8px;
  padding:1px 8px;font-size:11px;font-weight:600}
#fav.on{color:var(--accent);border-color:var(--accent);background:var(--accent-soft)}
#favnote{margin-top:8px;width:min(420px,100%);padding:6px 10px;border:1px solid var(--line);
  border-radius:8px;background:var(--field);color:var(--ink);font-size:12px;outline:none}
#favnote:focus{border-color:var(--accent)}
.fnote{font-size:11.5px;color:var(--accent);margin-top:3px;overflow:hidden;
  text-overflow:ellipsis;white-space:nowrap}
#conv{flex:1;overflow-y:auto;padding:22px 22px 80px}
.wrap{max-width:860px;margin:0 auto}
.msg{margin-bottom:16px;display:flex;gap:12px;content-visibility:auto;contain-intrinsic-size:auto 120px}
.who{font-size:10.5px;font-weight:700;text-transform:uppercase;letter-spacing:.04em;
  min-width:70px;padding-top:9px;color:var(--muted)}
.who.user{color:var(--accent)}
.bubble{flex:1;border:1px solid var(--line);border-radius:12px;padding:11px 14px;min-width:0;position:relative}
.alink{position:absolute;top:6px;right:6px;border:1px solid var(--line);background:var(--panel);
  border-radius:7px;font-size:11px;padding:2px 6px;cursor:pointer;display:none;color:var(--muted)}
.msg:hover .alink{display:block}
.alink:hover{border-color:var(--accent);color:var(--ink)}
.msg.flash .bubble{outline:2px solid var(--accent);transition:outline-color 1.5s}
.msg.user .bubble{background:var(--user)}
.msg.assistant .bubble{background:var(--assist)}
.block{white-space:pre-wrap;word-break:break-word;overflow-wrap:anywhere}
.block+.block{margin-top:10px}
details.think,details.tool{border-radius:8px;font-size:12.5px}
details.think{background:var(--think)}
details.tool{background:var(--tool)}
details summary{cursor:pointer;padding:6px 10px;font-size:11.5px;color:var(--muted);user-select:none;list-style:none}
details summary::-webkit-details-marker{display:none}
details summary::before{content:"▸ ";color:var(--muted)}
details[open] summary::before{content:"▾ "}
details .body{padding:2px 12px 10px;white-space:pre-wrap;word-break:break-word;
  font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:12px;color:var(--ink);
  max-height:340px;overflow:auto}
.terr summary{color:#d64545}
details.tool summary{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dim{opacity:.65}
/* Edit 工具的红绿 diff */
.body.diff{padding:8px 12px}
.diff .dl,.diff .al{display:block;white-space:pre-wrap;word-break:break-word;
  border-radius:3px;padding:0 4px;margin:1px 0}
.diff .dl{background:rgba(214,69,69,.13)}
.diff .al{background:rgba(82,196,26,.13)}
/* Markdown 正文 */
.md{white-space:normal;line-height:1.62}
.md>*:first-child{margin-top:0}.md>*:last-child{margin-bottom:0}
.md p{margin:0 0 8px}
.md h4,.md h5,.md h6{margin:12px 0 6px;font-size:13.5px;font-weight:640}
.md ul,.md ol{margin:6px 0;padding-left:22px}
.md li{margin:2px 0}
.md blockquote{margin:6px 0;padding:2px 12px;border-left:3px solid var(--accent);color:var(--muted)}
.md pre.cb{background:var(--think);border:1px solid var(--line);border-radius:8px;
  padding:10px 12px;overflow:auto;margin:8px 0}
.md pre.cb code{background:none;padding:0;white-space:pre}
.md code{background:var(--think);border-radius:4px;padding:1px 5px;
  font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:12.5px}
.md pre.cb code,.md code{font-family:ui-monospace,SFMono-Regular,Menlo,monospace}
.md a{color:var(--accent)}
.md hr{border:0;border-top:1px solid var(--line);margin:10px 0}
.md strong{font-weight:660}
/* Markdown 表格：窄屏时横向滚动，不撑破正文 */
.md .tw{overflow-x:auto;margin:8px 0;-webkit-overflow-scrolling:touch}
.md table.mtbl{border-collapse:collapse;font-size:12.5px;min-width:100%}
.md table.mtbl th,.md table.mtbl td{border:1px solid var(--line);padding:5px 9px;
  text-align:left;vertical-align:top;white-space:normal}
.md table.mtbl th{background:var(--think);font-weight:640;white-space:nowrap}
.md table.mtbl tbody tr:nth-child(even){background:rgba(127,127,127,.045)}
.mdbody{padding:2px 12px 10px;max-height:360px;overflow:auto}
.empty{color:var(--muted);text-align:center;margin-top:80px;font-size:13px}
.mono{font-family:ui-monospace,Menlo,monospace}
/* 移动端：侧栏折叠成抽屉 */
#menuBtn{display:none;position:fixed;top:10px;left:10px;z-index:11;width:38px;height:38px;
  border:1px solid var(--line);background:var(--panel);color:var(--ink);border-radius:10px;
  font-size:17px;cursor:pointer;align-items:center;justify-content:center;
  box-shadow:0 2px 10px rgba(0,0,0,.12)}
#scrim{display:none;position:fixed;inset:0;background:rgba(0,0,0,.38);z-index:9}
@media (max-width:720px){
  #menuBtn{display:flex}
  body.nav-open #scrim{display:block}
  #side{position:fixed;top:0;left:0;bottom:0;z-index:10;width:min(85vw,340px);min-width:0;
    transform:translateX(-105%);transition:transform .22s ease;box-shadow:4px 0 24px rgba(0,0,0,.18)}
  body.nav-open #side{transform:none}
  #side header{padding-top:14px}
  #top{padding:9px 14px 9px 58px;flex-wrap:wrap;align-items:center}
  #top h2{font-size:14.5px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
  /* 手机上默认只留标题一行：路径/花销小字和操作按钮都收进 ⋯ */
  #more{display:block}
  #top .sub{display:none}
  #top.open .sub{display:flex}
  .tbtns{display:none;width:100%;justify-content:flex-end}
  #top.open .tbtns{display:flex}
  #chains{padding:8px 14px}
  #udetail{padding:8px 14px 10px}
  #conv{padding:14px 10px 70px}
  .msg{gap:6px}
  .who{min-width:40px;font-size:9.5px;padding-top:10px}
  .bubble{padding:9px 11px}
  #hitbar{right:12px;top:8px}
  .stats .tiles{grid-template-columns:repeat(2,1fr)}
}
/* 会话用量明细（点顶栏用量小字展开） */
#udetail{display:none;padding:10px 22px 12px;border-bottom:1px solid var(--line);background:var(--panel)}
#udetail.show{display:block}
#top .sub .uchip{cursor:pointer}
#top .sub .uchip:hover{color:var(--ink)}
.mbadge{background:var(--accent-soft);color:var(--accent);padding:0 7px;border-radius:7px;font-weight:600}
/* 子代理侧链切换 */
#chains{display:none;gap:6px;padding:8px 22px;border-bottom:1px solid var(--line);
  background:var(--panel);flex-wrap:wrap;align-items:center}
.chip{border:1px solid var(--line);background:var(--field);color:var(--muted);border-radius:999px;
  padding:4px 12px;font-size:12px;cursor:pointer;max-width:260px;overflow:hidden;
  text-overflow:ellipsis;white-space:nowrap}
.chip:hover{border-color:var(--accent);color:var(--ink)}
.chip.on{background:var(--accent-soft);border-color:var(--accent);color:var(--ink);font-weight:600}
/* 加载更早 */
#older{display:block;margin:0 auto 18px;border:1px solid var(--line);background:var(--panel);
  color:var(--muted);border-radius:999px;padding:6px 16px;font-size:12px;cursor:pointer}
#older:hover{border-color:var(--accent);color:var(--ink)}
/* 命中导航 */
#hitbar{display:none;position:absolute;right:26px;top:12px;z-index:5;align-items:center;gap:6px;
  background:var(--panel);border:1px solid var(--line);border-radius:999px;padding:4px 8px;
  font-size:12px;color:var(--muted);box-shadow:0 4px 16px rgba(0,0,0,.1)}
#hitbar button{border:0;background:none;color:var(--ink);cursor:pointer;font-size:13px;padding:2px 6px;border-radius:6px}
#hitbar button:hover{background:var(--accent-soft)}
mark.cur{outline:2px solid var(--accent);border-radius:3px}
/* 压缩摘要 / 边界 */
.divider{display:flex;align-items:center;gap:10px;color:var(--muted);font-size:11.5px;margin:18px 0}
.divider::before,.divider::after{content:"";flex:1;border-top:1px dashed var(--line)}
/* 用量统计面板 */
.stats h3{font-size:13px;margin:22px 0 10px;color:var(--muted);font-weight:600;
  text-transform:uppercase;letter-spacing:.05em}
/* 统计区间选择 */
.rpick{display:flex;flex-wrap:wrap;align-items:center;gap:6px;margin:0 0 14px}
.rbtn{border:1px solid var(--line);background:var(--panel);color:var(--ink);
  border-radius:8px;padding:5px 11px;font-size:12px;cursor:pointer}
.rbtn:hover{border-color:var(--accent)}
.rbtn.on{background:var(--accent);border-color:var(--accent);color:#fff}
.rcustom{display:inline-flex;align-items:center;gap:5px;font-size:12px;color:var(--muted)}
.rcustom input[type=date]{border:1px solid var(--line);background:var(--field);color:var(--ink);
  border-radius:8px;padding:4px 8px;font-size:12px;font-family:inherit}
.rnote{margin-left:auto;font-size:11px;color:var(--muted);font-variant-numeric:tabular-nums}
.tiles{display:grid;grid-template-columns:repeat(auto-fit,minmax(130px,1fr));gap:10px}
.tile{background:var(--panel);border:1px solid var(--line);border-radius:12px;padding:12px 14px}
.tile .v{font-size:20px;font-weight:660;letter-spacing:-.01em}
.tile .k{font-size:11px;color:var(--muted);margin-top:2px}
.chart{position:relative;background:var(--panel);border:1px solid var(--line);
  border-radius:12px;padding:16px 14px 8px}
.cbars{display:flex;align-items:flex-end;gap:2px;height:150px;
  border-bottom:1px solid var(--line)}
.cbar{flex:1;min-width:3px;position:relative;display:flex;align-items:flex-end;height:100%}
.cbar i{display:block;width:100%;background:var(--chart);border-radius:3px 3px 0 0;min-height:0}
.cbar:hover i{filter:brightness(1.15)}
.cxl{display:flex;gap:2px;margin-top:4px}
.cxl span{flex:1;font-size:9.5px;color:var(--muted);text-align:center;overflow:visible;white-space:nowrap}
.cpeak{position:absolute;font-size:10px;color:var(--muted);transform:translateX(-50%);white-space:nowrap}
.ctip{position:absolute;z-index:6;background:var(--panel);border:1px solid var(--line);
  border-radius:8px;padding:8px 10px;font-size:11.5px;box-shadow:0 6px 20px rgba(0,0,0,.15);
  pointer-events:none;display:none;white-space:nowrap;line-height:1.6}
.stbl{width:100%;border-collapse:collapse;background:var(--panel);border:1px solid var(--line);
  border-radius:12px;overflow:hidden;font-size:12.5px}
.stbl th,.stbl td{padding:7px 12px;text-align:right;border-top:1px solid var(--line)}
.stbl th{color:var(--muted);font-weight:600;font-size:11px;border-top:0;background:var(--field)}
.stbl th:first-child,.stbl td:first-child{text-align:left}
.stbl td{font-variant-numeric:tabular-nums}
.tblwrap{overflow-x:auto;border-radius:12px}
details.pack{background:var(--accent-soft);border-radius:8px;font-size:12.5px}
.msg.agent .who{color:#7c6bd6}
/* tmux 控制条（会话视图底部）与控制台 */
.pv{border:1px solid var(--line);background:var(--field);color:var(--muted);border-radius:7px;
  padding:1px 8px;font-size:11px;cursor:pointer;margin-left:8px;vertical-align:1px}
.pv:hover{border-color:var(--accent);color:var(--ink)}
#pvov{display:none;position:fixed;inset:0;background:var(--bg);z-index:12;flex-direction:column}
#pvov.show{display:flex}
#pvov .pvbar{display:flex;align-items:center;gap:10px;padding:8px 14px;
  border-bottom:1px solid var(--line);background:var(--panel);flex-shrink:0}
#pvov .pvbar b{font-size:13px;white-space:nowrap}
#pvov .pvbar .mono{color:var(--muted);font-size:11px;flex:1;overflow:hidden;
  text-overflow:ellipsis;white-space:nowrap}
#pvov .pvbar button{border:1px solid var(--line);background:var(--field);color:var(--ink);
  border-radius:8px;padding:4px 11px;cursor:pointer;font-size:13px}
#pvov .pvbar button:hover{border-color:var(--accent)}
#pvov .pvbody{flex:1;overflow:auto;padding:16px 22px}
#pvov .pvbody .mdbody{max-height:none;max-width:820px;margin:0 auto}
#pvov .pvbody pre{white-space:pre-wrap;word-break:break-word;
  font:12px/1.55 ui-monospace,Menlo,monospace;max-width:900px;margin:0 auto}
#pvov .pvbody.raw{padding:0;display:flex}
#pvov .pvbody.raw iframe{flex:1;border:0;width:100%;background:#fff}
#composer{display:none;border-top:1px solid var(--line);background:var(--panel);padding:8px 14px 6px}
#composer.show{display:block}
.crow{display:flex;gap:6px;align-items:flex-end;max-width:860px;margin:0 auto}
.crow.ckeys{margin-top:6px;align-items:center;flex-wrap:wrap}
.ckeys #cterm{margin-left:auto}
#cin{flex:1;min-width:0;resize:none;padding:8px 11px;border:1px solid var(--line);border-radius:10px;
  background:var(--field);color:var(--ink);font-size:13px;outline:none;max-height:120px}
#cin:focus{border-color:var(--accent)}
#csend{border:0;background:var(--accent);color:#fff;border-radius:10px;width:40px;height:36px;
  font-size:14px;cursor:pointer;flex:none}
.ckey,#cterm{border:1px solid var(--line);background:var(--field);color:var(--muted);border-radius:9px;
  height:36px;min-width:34px;padding:0 8px;font-size:12px;cursor:pointer;flex:none}
.ckey:hover,#cterm:hover{border-color:var(--accent);color:var(--ink)}
#cstate{max-width:860px;margin:0 auto 6px}
#cstate:empty{display:none}
.cq{font-size:12.5px;color:var(--muted);margin:2px 0 6px}
.copts{display:flex;flex-wrap:wrap;gap:6px}
.copt{border:1px solid var(--line);background:var(--field);color:var(--ink);border-radius:9px;
  padding:6px 12px;font-size:12.5px;cursor:pointer;text-align:left}
.copt:hover{border-color:var(--accent)}
.copt.sel{border-color:var(--accent);background:var(--accent-soft)}
.copt b{color:var(--accent);margin-right:6px}
.copt small{display:block;color:var(--muted);font-size:11px;font-weight:400;margin-top:2px}
.copt:disabled{opacity:.5;cursor:default}
.cbusy{font-size:12.5px;color:var(--muted)}
.ctarget{max-width:860px;margin:4px auto 0;font-size:10.5px;color:var(--muted);
  overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.termwrap{max-width:1100px;margin:0 auto;position:relative}
#tresume{position:absolute;bottom:14px;left:50%;transform:translateX(-50%);z-index:5;
  border:1px solid var(--line);background:var(--panel);color:var(--ink);border-radius:999px;
  padding:6px 14px;font-size:12px;cursor:pointer;box-shadow:0 4px 14px rgba(0,0,0,.25)}
#tresume:hover{border-color:var(--accent)}
.termbar{display:flex;align-items:center;gap:10px;margin-bottom:10px;font-size:12.5px;
  color:var(--muted);flex-wrap:wrap}
.termbar button{border:1px solid var(--line);background:var(--panel);color:var(--ink);
  border-radius:8px;padding:5px 11px;font-size:12px;cursor:pointer}
.termbar button:hover{border-color:var(--accent)}
.tnew{background:var(--panel);border:1px solid var(--line);border-radius:12px;padding:10px 12px}
.tnew input{border:1px solid var(--line);background:var(--field);color:var(--ink);border-radius:8px;
  padding:6px 9px;font-size:12px;min-width:0;outline:none}
.tnew input:focus{border-color:var(--accent)}
.sysbar{background:var(--panel);border:1px solid var(--line);border-radius:12px;
  padding:10px 12px;margin-bottom:10px;font-size:12px;color:var(--muted);
  display:flex;flex-wrap:wrap;gap:6px 18px;align-items:center}
.sysbar b{color:var(--ink);font-weight:600}
.sysbar .est{font-size:12.5px}
.sysbar .est b{font-size:14px}
.sysbar .ok b{color:#3fa55e}.sysbar .tight b{color:#c9862a}.sysbar .full b{color:#d64545}
.membar{display:inline-block;width:72px;height:7px;border-radius:4px;background:var(--field);
  border:1px solid var(--line);overflow:hidden;vertical-align:-1px;margin-right:6px}
.membar i{display:block;height:100%;background:var(--accent);border-radius:4px}
.membar.tight i{background:#c9862a}.membar.full i{background:#d64545}
.pmem{color:var(--muted);font-size:11px}
#tname{width:120px}#tcwd{flex:2;min-width:150px}#tcmd{flex:1.2;min-width:150px}
#tcreate{white-space:nowrap}
#tcreate:disabled{opacity:.6}
.pane-card{position:relative;padding-right:38px}
.pkill{position:absolute;top:9px;right:9px;border:1px solid var(--line);background:var(--field);
  color:var(--muted);border-radius:7px;width:24px;height:24px;cursor:pointer;font-size:11px}
.pkill:hover{border-color:#d64545;color:#d64545}
.termscr{background:#14161b;border:1px solid var(--line);border-radius:12px;padding:10px 12px;
  overflow:auto;max-height:calc(100vh - 230px);max-height:calc(100dvh - 230px);
  -webkit-overflow-scrolling:touch}
.termscr pre{margin:0;font:12px/1.42 ui-monospace,SFMono-Regular,Menlo,monospace;
  color:#cfd3dc;white-space:pre}
/* 终端网格对齐：全角/制表线的字宽修正量由前端 termCellCSS() 实测后写进 --lsw/--lsb */
.termscr pre .tw{letter-spacing:var(--lsw,0px)}
.termscr pre .tb{letter-spacing:var(--lsb,0px)}
@media (max-width:720px){
  #composer{padding:6px 8px 4px}
  .termbar{padding-left:48px} /* 让出左上角 ☰ 汉堡键 */
  .termscr{max-height:calc(100vh - 260px);max-height:calc(100dvh - 260px)}
  .termscr pre{font-size:11px}
}
</style></head><body>

<div id="login">
  <div class="card">
    <h1><span class="dot"></span>Claude 对话历史</h1>
    <p>请输入访问密码</p>
    <input id="pw" type="password" placeholder="密码" autocomplete="current-password">
    <button id="loginBtn">进入</button>
    <div class="err" id="loginErr"></div>
  </div>
</div>

<button id="menuBtn" title="会话列表" style="display:none">☰</button>
<div id="scrim"></div>

<aside id="side" style="display:none">
  <header>
    <div class="hrow">
      <h1><span class="dot"></span>Claude 对话历史</h1>
      <div class="icons">
        <button class="iconbtn" id="termBtn" title="tmux 控制台" style="display:none">▣</button>
        <button class="iconbtn" id="statsBtn" title="用量统计">📊</button>
        <button class="iconbtn" id="theme" title="切换深浅色">◐</button>
        <button class="iconbtn" id="logout" title="退出登录">⏻</button>
      </div>
    </div>
    <div id="srctabs"><button data-s="claude" class="on">Claude</button><button data-s="codex">Codex</button><button data-s="agy">Agy</button></div>
    <input id="q" placeholder="模糊搜索标题 / 内容…" autocomplete="off">
    <div class="filters">
      <select id="fproj"><option value="">全部项目</option></select>
      <select id="ftime">
        <option value="0">任何时间</option><option value="1">今天</option>
        <option value="7">近 7 天</option><option value="30">近 30 天</option>
        <option value="90">近 90 天</option><option value="180">近半年</option>
        <option value="365">近一年</option><option value="custom">自定义…</option>
      </select>
      <label class="chk"><input type="checkbox" id="fthink">含思考</label>
      <div class="fdates" id="fdates" style="display:none">
        <input type="date" id="ffrom"><span>→</span><input type="date" id="fto">
      </div>
    </div>
    <div id="meta"><span id="count"></span><span id="mode"></span></div>
  </header>
  <div id="list"></div>
</aside>

<main id="main" style="display:none;position:relative">
  <div id="top"><div style="min-width:0;flex:1"><h2 id="ttl"></h2><div class="sub" id="sub"></div>
      <input id="favnote" placeholder="收藏备注，回车保存" style="display:none"></div>
    <button id="more" title="更多操作">⋯</button>
    <div class="tbtns"><button id="fav" title="收藏">☆</button>
      <button id="share" title="生成 7 天有效的只读分享链接">分享</button>
      <button id="exp">导出 MD</button>
      <button id="del" title="删除对话文件（不可恢复）">删除</button></div></div>
  <div id="udetail"></div>
  <div id="chains"></div>
  <div id="hitbar"><span id="hitn"></span>
    <button id="hitPrev" title="上一处">↑</button><button id="hitNext" title="下一处">↓</button></div>
  <div id="conv"><div class="empty">← 选择左侧的一段对话开始查看<br><br>
    在搜索框输入关键词可跨全部会话搜正文</div></div>
  <div id="composer">
    <div id="cstate"></div>
    <div class="crow">
      <textarea id="cin" rows="1" placeholder="发给这个会话…（Enter 发送，Shift+Enter 换行）"></textarea>
      <button id="csend" title="发送并回车">➤</button>
    </div>
    <div class="crow ckeys">
      <button class="ckey" data-k="Escape" title="Esc：打断 / 取消">Esc</button>
      <button class="ckey" data-k="C-c" title="Ctrl+C：退出程序（Claude Code 要连按两下）">^C</button>
      <button class="ckey" data-k="Tab" title="Tab：接受输入框里的灰色补全提示 / 补全命令">⇥</button>
      <button class="ckey" data-k="BTab" title="Shift+Tab：切换权限模式">⇧⇥</button>
      <button class="ckey" data-k="Up" title="↑">↑</button>
      <button class="ckey" data-k="Down" title="↓">↓</button>
      <button class="ckey" data-k="Left" title="←">←</button>
      <button class="ckey" data-k="Right" title="→">→</button>
      <button class="ckey" data-k="Enter" title="回车确认">⏎</button>
      <button id="cterm" title="打开终端画面">▣</button>
    </div>
    <div class="ctarget" id="ctarget"></div>
  </div>
  <div id="pvov">
    <div class="pvbar"><b id="pvname"></b><span class="mono" id="pvpath"></span>
      <button id="pvre" title="重新从磁盘读取">↻</button><button id="pvx" title="关闭（Esc）">✕</button></div>
    <div class="pvbody" id="pvbody"></div>
  </div>
</main>

<script src="app.js?v=__APPVER__"></script></body></html>`;
