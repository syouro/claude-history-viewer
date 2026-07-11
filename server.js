#!/usr/bin/env node
// Claude 对话历史查看器 —— 零依赖，纯 Node 标准库。
// 扫描 ~/.claude/projects/<项目>/<sessionId>.jsonl；带登录鉴权，可经反代公网访问。
'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');

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
  return !!verifyToken(parseCookies(req)['chv_sid']);
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
function parseSession(project, id, filePath) {
  const stat = fs.statSync(filePath);
  const raw = fs.readFileSync(filePath, 'utf8');
  const messages = [];            // 主链消息
  const sidechains = new Map();   // agentId -> 子代理侧链
  const summaries = [];           // 压缩续接产生的历史摘要
  let title = '', firstPrompt = '', cwd = '', gitBranch = '', agentName = '';
  let firstTs = null, lastTs = null;
  // token 用量统计（含子代理）
  const usage = { in: 0, out: 0, cw: 0, cr: 0, msgs: 0 };
  const usageByDay = {}, usageByModel = {};
  const addU = (t, u) => {
    t.in += u.input_tokens || 0; t.out += u.output_tokens || 0;
    t.cw += u.cache_creation_input_tokens || 0; t.cr += u.cache_read_input_tokens || 0;
    t.msgs++;
  };
  const addUsage = (msg, ts) => {
    const u = msg.usage;
    if (!u) return;
    addU(usage, u);
    const day = ts ? String(ts).slice(0, 10) : '';
    if (day) addU(usageByDay[day] = usageByDay[day] ||
      { in: 0, out: 0, cw: 0, cr: 0, msgs: 0 }, u);
    const model = msg.model && msg.model !== '<synthetic>' ? msg.model : '(unknown)';
    addU(usageByModel[model] = usageByModel[model] ||
      { in: 0, out: 0, cw: 0, cr: 0, msgs: 0 }, u);
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
    if (role === 'assistant') addUsage(msg, ts);
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
    project, id, title: title || firstPrompt || '(无标题)', firstPrompt,
    cwd, gitBranch, agentName, mtime: stat.mtimeMs, firstTs, lastTs,
    msgCount: messages.length, summaries,
    usage, usageByDay, usageByModel,
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

// ---------- 缓存 ----------
// 全量会话缓存带 LRU 上限（消息占内存）；摘要缓存无消息、常驻，列表接口只碰它。
const cache = new Map();
const CACHE_MAX = 100;
const sumCache = new Map(); // key -> {mtime, summary}
const NAME_RE = /^[A-Za-z0-9._-]+$/; // 防路径穿越
function loadSession(project, id) {
  if (!NAME_RE.test(project || '') || !NAME_RE.test(id || '')) return null;
  if (isExcluded(project)) return null;
  const filePath = sessionFile(project, id);
  if (!filePath) return null;
  const stamp = cacheStamp(filePath);
  const key = project + '/' + id;
  const hit = cache.get(key);
  if (hit && hit.stamp === stamp) {
    cache.delete(key); cache.set(key, hit); // LRU 提前
    return hit.session;
  }
  const session = parseSession(project, id, filePath);
  cache.set(key, { stamp, session });
  sumCache.set(key, { stamp, summary: summary(session) });
  if (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value);
  return session;
}
function loadSummary(project, id, stamp) {
  const key = project + '/' + id;
  const hit = sumCache.get(key);
  if (hit && hit.stamp === stamp) return hit.summary;
  const s = loadSession(project, id);
  return s ? summary(s) : null;
}
function listAll() {
  const out = [];
  const seen = new Set(); // 同名项目+会话在多个根里出现时，先配置的根优先
  for (const root of ROOTS) {
    let projects;
    try { projects = fs.readdirSync(root); } catch { continue; }
    for (const project of projects) {
      if (isExcluded(project)) continue;
      const pdir = path.join(root, project);
      let files;
      try {
        if (!fs.statSync(pdir).isDirectory()) continue;
        files = fs.readdirSync(pdir).filter((f) => f.endsWith('.jsonl'));
      } catch { continue; }
      for (const f of files) {
        const id = f.slice(0, -6);
        const key = project + '/' + id;
        if (seen.has(key)) continue;
        seen.add(key);
        try {
          const s = loadSummary(project, id, cacheStamp(path.join(pdir, f)));
          if (s && s.msgCount) out.push(s);
        } catch { /* skip */ }
      }
    }
  }
  out.sort((a, b) => b.mtime - a.mtime);
  return out;
}
function summary(s) {
  return {
    project: s.project, id: s.id, title: s.title, firstPrompt: s.firstPrompt,
    cwd: s.cwd, gitBranch: s.gitBranch, agentName: s.agentName, mtime: s.mtime,
    firstTs: s.firstTs, lastTs: s.lastTs, msgCount: s.msgCount,
    sidechainCount: s.sidechains.length, hasSummary: s.summaries.length > 0,
    usage: s.usage, usageByDay: s.usageByDay, usageByModel: s.usageByModel,
  };
}
function search(q, includeThinking) {
  const query = q.toLowerCase().trim();
  if (!query) return [];
  const terms = query.split(/\s+/).filter(Boolean);
  const results = [];
  for (const sum of listAll()) {
    const s = loadSession(sum.project, sum.id);
    if (!s) continue;
    let hits = 0, snippet = null;
    const titleLc = (s.title + ' ' + s.firstPrompt).toLowerCase();
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
    const titleHit = terms.every((term) => titleLc.includes(term));
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
function mdMessages(L, messages) {
  for (const m of messages) {
    if (m.isMeta) continue;
    const who = m.role === 'user' ? '🧑 你' : m.role === 'system' ? '⚙ 系统' : '🤖 Claude';
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
  mdMessages(L, s.messages);
  for (const sc of s.sidechains) {
    L.push('', '## 🤖 子代理：' + (sc.firstPrompt || sc.agentId), '');
    mdMessages(L, sc.messages);
  }
  return L.join('\n');
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
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(HTML);
      return;
    }
    if (p === '/app.js') {
      res.writeHead(200, { 'Content-Type': 'application/javascript; charset=utf-8' });
      res.end(fs.readFileSync(path.join(__dirname, 'app.js')));
      return;
    }
    if (p === '/api/me') { sendJSON(res, { authed: isAuthed(req) }); return; }
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

    // 以下均需鉴权
    if (!isAuthed(req)) { sendJSON(res, { error: 'unauthorized' }, 401); return; }

    if (p === '/api/sessions') { sendJSON(res, listAll()); return; }
    if (p === '/api/session') {
      const s = loadSession(url.searchParams.get('project'), url.searchParams.get('id'));
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
      const s = loadSession(url.searchParams.get('project'), url.searchParams.get('id'));
      if (!s) { sendJSON(res, { error: 'not found' }, 404); return; }
      const sc = s.sidechains.find((x) => x.agentId === url.searchParams.get('agent'));
      if (!sc) { sendJSON(res, { error: 'not found' }, 404); return; }
      sendJSON(res, sc); return;
    }
    if (p === '/api/stats') {
      const days = {}, byProject = {}, byModel = {};
      const totals = { in: 0, out: 0, cw: 0, cr: 0, msgs: 0, sessions: 0, msgTotal: 0 };
      const zero = () => ({ in: 0, out: 0, cw: 0, cr: 0, msgs: 0 });
      const add = (t, u) => {
        t.in += u.in; t.out += u.out; t.cw += u.cw; t.cr += u.cr; t.msgs += u.msgs;
      };
      for (const s of listAll()) {
        totals.sessions++; totals.msgTotal += s.msgCount;
        if (s.usage) add(totals, s.usage);
        for (const [day, u] of Object.entries(s.usageByDay || {}))
          add(days[day] = days[day] || zero(), u);
        if (s.usage && s.usage.msgs) {
          const pj = byProject[s.project] = byProject[s.project] ||
            { ...zero(), sessions: 0 };
          add(pj, s.usage); pj.sessions++;
        }
        for (const [m, u] of Object.entries(s.usageByModel || {}))
          add(byModel[m] = byModel[m] || zero(), u);
      }
      sendJSON(res, { totals, days, byProject, byModel }); return;
    }
    if (p === '/api/search') {
      const inc = url.searchParams.get('thinking') === '1';
      sendJSON(res, search(url.searchParams.get('q') || '', inc)); return;
    }
    if (p === '/api/export') {
      const s = loadSession(url.searchParams.get('project'), url.searchParams.get('id'));
      if (!s) { sendJSON(res, { error: 'not found' }, 404); return; }
      const fn = (s.title || 'session').replace(/[^\w一-龥-]+/g, '_').slice(0, 60);
      res.writeHead(200, {
        'Content-Type': 'text/markdown; charset=utf-8',
        'Content-Disposition': "attachment; filename*=UTF-8''" +
          encodeURIComponent(fn + '.md'),
      });
      res.end(toMarkdown(s)); return;
    }
    sendJSON(res, { error: 'not found' }, 404);
  } catch (e) {
    sendJSON(res, { error: e.message }, 500);
  }
});

const generated = loadConfig();
server.listen(PORT, HOST, () => {
  console.log(`Claude 历史查看器：http://${HOST}:${PORT}`);
  console.log('  扫描根目录：' + ROOTS.join('，'));
  if (EXCLUDE.length) console.log('  排除规则：' + (USER_CFG.exclude || []).join('，'));
  if (generated) {
    console.log('\n  ⚠ 已生成随机登录密码（也写入 secret.json）：');
    console.log('      ' + generated + '\n');
  } else if (process.env.VIEWER_PASSWORD) {
    console.log('  登录密码来自 VIEWER_PASSWORD 环境变量');
  } else {
    console.log('  登录密码来自 secret.json');
  }
  if (!SECURE_COOKIE) console.log('  （SECURE_COOKIE=0：cookie 不带 Secure，仅供本地 http 调试）');
});

// ---------- 前端（内嵌单页）----------
const HTML = /* html */ `<!doctype html><html lang="zh"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
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
#q{width:100%;padding:9px 11px;border:1px solid var(--line);border-radius:9px;
  background:var(--field);color:var(--ink);font-size:13px;outline:none}
#q:focus{border-color:var(--accent)}
.filters{display:flex;gap:6px;margin-top:8px;align-items:center;flex-wrap:wrap}
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
#exp{border:1px solid var(--line);background:var(--field);color:var(--ink);border-radius:9px;
  padding:7px 12px;font-size:12.5px;cursor:pointer;white-space:nowrap}
#exp:hover{border-color:var(--accent)}
#conv{flex:1;overflow-y:auto;padding:22px 22px 80px}
.wrap{max-width:860px;margin:0 auto}
.msg{margin-bottom:16px;display:flex;gap:12px;content-visibility:auto;contain-intrinsic-size:auto 120px}
.who{font-size:10.5px;font-weight:700;text-transform:uppercase;letter-spacing:.04em;
  min-width:70px;padding-top:9px;color:var(--muted)}
.who.user{color:var(--accent)}
.bubble{flex:1;border:1px solid var(--line);border-radius:12px;padding:11px 14px;min-width:0}
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
.mdbody{padding:2px 12px 10px;max-height:360px;overflow:auto}
.empty{color:var(--muted);text-align:center;margin-top:80px;font-size:13px}
.mono{font-family:ui-monospace,Menlo,monospace}
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

<aside id="side" style="display:none">
  <header>
    <div class="hrow">
      <h1><span class="dot"></span>Claude 对话历史</h1>
      <div class="icons">
        <button class="iconbtn" id="statsBtn" title="用量统计">📊</button>
        <button class="iconbtn" id="theme" title="切换深浅色">◐</button>
        <button class="iconbtn" id="logout" title="退出登录">⏻</button>
      </div>
    </div>
    <input id="q" placeholder="模糊搜索标题 / 内容…" autocomplete="off">
    <div class="filters">
      <select id="fproj"><option value="">全部项目</option></select>
      <select id="ftime">
        <option value="0">任何时间</option><option value="1">今天</option>
        <option value="7">近 7 天</option><option value="30">近 30 天</option>
      </select>
      <label class="chk"><input type="checkbox" id="fthink">含思考</label>
    </div>
    <div id="meta"><span id="count"></span><span id="mode"></span></div>
  </header>
  <div id="list"></div>
</aside>

<main id="main" style="display:none;position:relative">
  <div id="top"><div><h2 id="ttl"></h2><div class="sub" id="sub"></div></div>
    <button id="exp">导出 MD</button></div>
  <div id="chains"></div>
  <div id="hitbar"><span id="hitn"></span>
    <button id="hitPrev" title="上一处">↑</button><button id="hitNext" title="下一处">↓</button></div>
  <div id="conv"><div class="empty">← 选择左侧的一段对话开始查看<br><br>
    在搜索框输入关键词可跨全部会话搜正文</div></div>
</main>

<script src="app.js"></script></body></html>`;
