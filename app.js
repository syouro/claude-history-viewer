'use strict';
var $ = function (s) { return document.querySelector(s); };
var sessions = [], current = null, searchMode = false, lastTerms = [];
var PAGE = 80; // 每次加载的消息条数

function esc(s) {
  return (s || '').replace(/[&<>]/g, function (c) {
    return { '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c];
  });
}
function escapeRe(t) { return t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }
function hi(s, terms) {
  var h = esc(s);
  (terms || []).forEach(function (t) {
    if (!t) return;
    h = h.replace(new RegExp('(' + escapeRe(t) + ')', 'ig'), '<mark>$1</mark>');
  });
  return h;
}
function rel(ts) {
  if (!ts) return '';
  var d = (Date.now() - new Date(ts)) / 1000;
  if (d < 60) return '刚刚';
  if (d < 3600) return Math.floor(d / 60) + '分钟前';
  if (d < 86400) return Math.floor(d / 3600) + '小时前';
  if (d < 86400 * 30) return Math.floor(d / 86400) + '天前';
  return new Date(ts).toLocaleDateString('zh-CN');
}
function projName(p) { return p.replace(/^-/, '/').replace(/-/g, '/').replace(/\/\//g, '-') || p; }
function tsOf(s) { return s.lastTs ? new Date(s.lastTs).getTime() : s.mtime; }
function fuzzy(text, q) {
  text = text.toLowerCase(); q = q.toLowerCase();
  var i = 0;
  for (var k = 0; k < q.length; k++) { i = text.indexOf(q[k], i); if (i < 0) return false; i++; }
  return true;
}

// ---------- 轻量 Markdown 渲染（先埋高亮哨兵，渲染后还原为 <mark>）----------
var BT = String.fromCharCode(96), MA = String.fromCharCode(1),
    MB = String.fromCharCode(2), CP = String.fromCharCode(3);
function sentinelize(text, terms) {
  if (!terms || !terms.length) return text;
  var out = text;
  terms.forEach(function (t) {
    if (!t) return;
    out = out.replace(new RegExp(escapeRe(t), 'ig'), function (m) { return MA + m + MB; });
  });
  return out;
}
function mdInline(s) {
  var codes = [];
  var h = s.replace(new RegExp(BT + '([^' + BT + ']+)' + BT, 'g'), function (m, p1) {
    codes.push(p1); return CP + (codes.length - 1) + CP;
  });
  h = esc(h);
  h = h.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  h = h.replace(/(^|[^*])\*([^*\s][^*]*)\*/g, '$1<em>$2</em>');
  h = h.replace(/(^|[\s(])_([^_]+)_(?=$|[\s).,!?])/g, '$1<em>$2</em>');
  h = h.replace(/~~([^~]+)~~/g, '<del>$1</del>');
  h = h.replace(/\[([^\]]+)\]\((https?:[^)\s]+)\)/g,
    '<a href="$2" target="_blank" rel="noopener">$1</a>');
  h = h.replace(new RegExp(CP + '(\\d+)' + CP, 'g'), function (m, idx) {
    return '<code>' + esc(codes[+idx]) + '</code>';
  });
  return h;
}
function mdBlocks(text) {
  var lines = text.split('\n'), html = [], i = 0, fence = BT + BT + BT;
  var isList = function (l) { return /^\s*([-*+]|\d+[.)])\s+/.test(l); };
  var isBlock = function (l) {
    return l.slice(0, 3) === fence || /^#{1,6}\s+/.test(l) || /^\s*>/.test(l) ||
      isList(l) || /^\s*([-*_])\1\1+\s*$/.test(l);
  };
  while (i < lines.length) {
    var line = lines[i];
    if (line.slice(0, 3) === fence) {
      var buf = []; i++;
      while (i < lines.length && lines[i].slice(0, 3) !== fence) { buf.push(lines[i]); i++; }
      i++;
      html.push('<pre class="cb"><code>' + esc(buf.join('\n')) + '</code></pre>');
      continue;
    }
    var hm = line.match(/^(#{1,6})\s+(.*)$/);
    if (hm) {
      var lv = Math.min(6, hm[1].length + 2);
      html.push('<h' + lv + ' class="mh">' + mdInline(hm[2]) + '</h' + lv + '>'); i++; continue;
    }
    if (/^\s*([-*_])\1\1+\s*$/.test(line)) { html.push('<hr>'); i++; continue; }
    if (/^\s*>/.test(line)) {
      var q = [];
      while (i < lines.length && /^\s*>/.test(lines[i])) { q.push(lines[i].replace(/^\s*>\s?/, '')); i++; }
      html.push('<blockquote>' + mdBlocks(q.join('\n')) + '</blockquote>'); continue;
    }
    if (isList(line)) {
      var ordered = /^\s*\d+[.)]\s+/.test(line), items = [];
      while (i < lines.length && isList(lines[i])) {
        items.push(lines[i].replace(/^\s*([-*+]|\d+[.)])\s+/, '')); i++;
      }
      html.push((ordered ? '<ol>' : '<ul>') +
        items.map(function (it) { return '<li>' + mdInline(it) + '</li>'; }).join('') +
        (ordered ? '</ol>' : '</ul>'));
      continue;
    }
    if (/^\s*$/.test(line)) { i++; continue; }
    var para = [];
    while (i < lines.length && !/^\s*$/.test(lines[i]) && !isBlock(lines[i])) { para.push(lines[i]); i++; }
    html.push('<p>' + para.map(mdInline).join('<br>') + '</p>');
  }
  return html.join('');
}
function md(text, terms) {
  var out = mdBlocks(sentinelize(text, terms || []));
  return out.split(MA).join('<mark>').split(MB).join('</mark>');
}

// ---------- 筛选 ----------
function applyFilters(arr) {
  var proj = $('#fproj').value, days = +$('#ftime').value;
  var cut = days ? Date.now() - days * 86400e3 : 0;
  return arr.filter(function (s) {
    if (proj && s.project !== proj) return false;
    if (cut && tsOf(s) < cut) return false;
    return true;
  });
}
function fillProjects() {
  var sel = $('#fproj'), cur = sel.value, ps = {};
  sessions.forEach(function (s) { ps[s.project] = 1; });
  sel.innerHTML = '<option value="">全部项目</option>' +
    Object.keys(ps).sort().map(function (p) {
      return '<option value="' + esc(p) + '">' + esc(projName(p)) + '</option>';
    }).join('');
  sel.value = cur;
}

// ---------- 列表 / 搜索 ----------
async function loadList() {
  var r = await fetch('api/sessions');
  if (r.status === 401) { showLogin(); return; }
  sessions = await r.json(); fillProjects(); render('');
}
function render(filter) {
  var list = $('#list'); list.innerHTML = '';
  var items = applyFilters(sessions);
  if (filter) items = items.filter(function (s) {
    return fuzzy(s.title + ' ' + (s.firstPrompt || '') + ' ' + s.project, filter);
  });
  $('#count').textContent = items.length + ' 段对话';
  $('#mode').textContent = filter ? '标题过滤' : '';
  var byProj = {};
  items.forEach(function (s) { (byProj[s.project] = byProj[s.project] || []).push(s); });
  var projs = Object.keys(byProj).sort(function (a, b) {
    return Math.max.apply(0, byProj[b].map(tsOf)) - Math.max.apply(0, byProj[a].map(tsOf));
  });
  projs.forEach(function (proj) {
    var g = document.createElement('div'); g.className = 'grp'; g.textContent = projName(proj);
    list.appendChild(g);
    byProj[proj].forEach(function (s) { list.appendChild(itemEl(s, filter)); });
  });
  if (!items.length) emptyMsg(list, '无匹配');
}
function emptyMsg(list, t) {
  var e = document.createElement('div'); e.className = 'empty';
  e.style.marginTop = '40px'; e.textContent = t; list.appendChild(e);
}
function extras(s) {
  var out = '';
  if (s.agentName) out += '<span>⚙ ' + esc(s.agentName) + '</span>';
  if (s.sidechainCount) out += '<span>🤖 ' + s.sidechainCount + ' 子代理</span>';
  if (s.hasSummary) out += '<span>📦 续接</span>';
  return out;
}
function itemEl(s, filter) {
  var el = document.createElement('div');
  el.className = 'item' + (current && current.id === s.id ? ' on' : '');
  el.innerHTML = '<div class="t">' + (filter ? hi(s.title, [filter]) : esc(s.title)) + '</div>' +
    '<div class="r"><span>' + rel(s.lastTs) + '</span><span>' + s.msgCount + ' 条</span>' +
    extras(s) + '</div>';
  el.onclick = function () { open(s); };
  return el;
}
function searchItemEl(s) {
  var el = document.createElement('div');
  el.className = 'item' + (current && current.id === s.id ? ' on' : '');
  var html = '<div class="t">' + hi(s.title, lastTerms) + '</div>';
  if (s.hits) html += '<div class="r"><span class="badge">' + s.hits +
    ' 处命中</span><span>' + rel(s.lastTs) + '</span>' + extras(s) + '</div>';
  if (s.snippet) html += '<div class="snip"><b>' + (s.snippet.kind === 'thinking' ? '💭 ' : '') +
    (s.snippet.role === 'user' ? '你' : s.snippet.role === 'agent' ? '子代理' : 'Claude') +
    '：</b>' + hi(s.snippet.text, lastTerms) + '</div>';
  el.innerHTML = html;
  el.onclick = function () { open(s); };
  return el;
}
async function doSearch(q) {
  var inc = $('#fthink').checked ? '&thinking=1' : '';
  var res = await (await fetch('api/search?q=' + encodeURIComponent(q) + inc)).json();
  lastTerms = q.toLowerCase().split(/\s+/).filter(Boolean);
  res = applyFilters(res);
  var list = $('#list'); list.innerHTML = '';
  $('#count').textContent = res.length + ' 段命中'; $('#mode').textContent = '内容搜索';
  if (!res.length) { emptyMsg(list, '无匹配'); return; }
  res.forEach(function (s) { list.appendChild(searchItemEl(s)); });
}

// ---------- 会话渲染 ----------
// view：当前会话的加载状态。offset 是已加载区间的起点，上滚时继续往前取。
var view = { offset: 0, total: 0, terms: [], mode: 'main', loading: false, wrap: null, older: null };

function apiSession(s, params) {
  return fetch('api/session?project=' + encodeURIComponent(s.project) +
    '&id=' + encodeURIComponent(s.id) + (params || '')).then(function (r) { return r.json(); });
}
async function open(s) {
  // 搜索模式下全量加载，保证命中定位覆盖整段会话；平时只取最近 PAGE 条
  var full = searchMode && lastTerms.length;
  var data = await apiSession(s, full ? '&limit=0' : '&limit=' + PAGE);
  current = data;
  view = { offset: data.offset, total: data.total, terms: full ? lastTerms : [],
    mode: 'main', loading: false, wrap: null, older: null };
  $('#top').style.display = 'flex'; $('#ttl').textContent = data.title;
  var bits = [projName(data.project), data.msgCount + ' 条消息',
    data.agentName ? ('⚙ ' + esc(data.agentName)) : '',
    data.gitBranch ? ('⎇ ' + data.gitBranch) : '',
    data.cwd ? ('<span class="mono">' + esc(data.cwd) + '</span>') : '',
    data.firstTs ? new Date(data.firstTs).toLocaleString('zh-CN') : ''].filter(Boolean);
  $('#sub').innerHTML = bits.map(function (b) { return '<span>' + b + '</span>'; }).join('');
  $('#exp').onclick = function () {
    var a = document.createElement('a');
    a.href = 'api/export?project=' + encodeURIComponent(data.project) +
      '&id=' + encodeURIComponent(data.id);
    a.download = ''; document.body.appendChild(a); a.click(); a.remove();
  };
  renderChains(data);
  renderMain(data.messages);
  if (searchMode) doSearch($('#q').value.trim()); else render($('#q').value.trim());
}
function renderMain(msgs) {
  var conv = $('#conv'); conv.innerHTML = '';
  var wrap = document.createElement('div'); wrap.className = 'wrap';
  // 顺序：历史摘要横幅 → 「加载更早」按钮 → 消息
  (current.summaries || []).forEach(function (t) {
    var d = document.createElement('details'); d.className = 'pack block';
    d.innerHTML = '<summary>📦 历史摘要（此会话由压缩续接而来）</summary>' +
      '<div class="mdbody md">' + md(t, view.terms) + '</div>';
    d.style.marginBottom = '14px';
    wrap.appendChild(d);
  });
  var older = document.createElement('button'); older.id = 'older';
  older.onclick = loadOlder;
  wrap.appendChild(older);
  view.wrap = wrap; view.older = older;
  msgs.forEach(function (m) { if (!m.isMeta) wrap.appendChild(msgEl(m, view.terms)); });
  conv.appendChild(wrap);
  updateOlder();
  if (view.terms.length) { conv.scrollTop = 0; setupHits(); }
  else { hideHits(); conv.scrollTop = conv.scrollHeight; } // 平时从最新处看起
}
function updateOlder() {
  var b = view.older; if (!b) return;
  if (view.mode !== 'main' || view.offset <= 0) { b.style.display = 'none'; return; }
  b.style.display = 'block';
  b.textContent = '↑ 还有 ' + view.offset + ' 条更早消息（上滚或点击加载）';
}
async function loadOlder() {
  if (view.loading || view.offset <= 0 || view.mode !== 'main') return;
  view.loading = true;
  view.older.textContent = '加载中…';
  var data = await apiSession(current, '&limit=' + PAGE + '&before=' + view.offset);
  var conv = $('#conv'), prevH = conv.scrollHeight;
  var frag = document.createDocumentFragment();
  data.messages.forEach(function (m) { if (!m.isMeta) frag.appendChild(msgEl(m, view.terms)); });
  view.wrap.insertBefore(frag, view.older.nextSibling);
  view.offset = data.offset;
  conv.scrollTop += conv.scrollHeight - prevH; // 保持视口不跳
  updateOlder();
  view.loading = false;
}
$('#conv').addEventListener('scroll', function () {
  if (view.mode === 'main' && !view.loading && view.offset > 0 &&
      $('#conv').scrollTop < 300) loadOlder();
});

// ---------- 子代理侧链 ----------
function renderChains(data) {
  var box = $('#chains'); box.innerHTML = '';
  var scs = data.sidechains || [];
  if (!scs.length) { box.style.display = 'none'; return; }
  box.style.display = 'flex';
  var mainChip = document.createElement('button');
  mainChip.className = 'chip on'; mainChip.textContent = '主对话';
  mainChip.onclick = function () { switchChain(null); };
  box.appendChild(mainChip);
  scs.forEach(function (sc) {
    var c = document.createElement('button'); c.className = 'chip';
    c.title = sc.firstPrompt || sc.agentId;
    c.textContent = '🤖 ' + (sc.firstPrompt || sc.agentId).slice(0, 40) +
      ' · ' + sc.msgCount + '条';
    c.onclick = function () { switchChain(sc.agentId, c); };
    box.appendChild(c);
  });
}
async function switchChain(agentId, chipEl) {
  document.querySelectorAll('#chains .chip').forEach(function (c) { c.classList.remove('on'); });
  if (!agentId) {
    // 回主对话：重取最近一页（或搜索模式全量）
    view.mode = 'main';
    document.querySelector('#chains .chip').classList.add('on');
    var data = await apiSession(current, view.terms.length ? '&limit=0' : '&limit=' + PAGE);
    view.offset = data.offset; view.total = data.total;
    renderMain(data.messages);
    return;
  }
  chipEl.classList.add('on');
  view.mode = agentId;
  var sc = await (await fetch('api/sidechain?project=' + encodeURIComponent(current.project) +
    '&id=' + encodeURIComponent(current.id) + '&agent=' + encodeURIComponent(agentId))).json();
  var conv = $('#conv'); conv.innerHTML = '';
  var wrap = document.createElement('div'); wrap.className = 'wrap';
  var head = document.createElement('div'); head.className = 'divider';
  head.textContent = '子代理侧链 · ' + sc.messages.length + ' 条';
  wrap.appendChild(head);
  sc.messages.forEach(function (m) {
    if (!m.isMeta) wrap.appendChild(msgEl(m, view.terms, true));
  });
  conv.appendChild(wrap); conv.scrollTop = 0;
  if (view.terms.length) setupHits(); else hideHits();
}

// ---------- 工具调用友好渲染 ----------
function shortPath(p) { return String(p || '').replace(/^\/(root|home\/[^/]+)\//, '~/'); }
function clip(s, n) {
  s = String(s || '').replace(/\s+/g, ' ').trim();
  return s.length > n ? s.slice(0, n) + '…' : s;
}
function bodyDiv(html) { return '<div class="body">' + html + '</div>'; }
function diffBody(oldS, newS, terms) {
  var h = '';
  if (oldS) String(oldS).split('\n').forEach(function (l) {
    h += '<span class="dl">- ' + hi(l, terms) + '</span>';
  });
  if (newS) String(newS).split('\n').forEach(function (l) {
    h += '<span class="al">+ ' + hi(l, terms) + '</span>';
  });
  return '<div class="body diff">' + h + '</div>';
}
function toolView(name, inp, terms) {
  var sum = '🔧 ' + esc(name);
  var body = bodyDiv(hi(JSON.stringify(inp, null, 2) || '', terms));
  if (name === 'Bash' && inp.command) {
    sum = '🖥 ' + esc(clip(inp.command, 90));
    body = bodyDiv('$ ' + hi(inp.command, terms) +
      (inp.description ? '\n\n# ' + hi(inp.description, terms) : ''));
  } else if (name === 'Read' && inp.file_path) {
    sum = '📖 Read · ' + esc(shortPath(inp.file_path)) +
      (inp.offset ? esc(' :' + inp.offset + (inp.limit ? '+' + inp.limit : '')) : '');
  } else if (name === 'Write' && inp.file_path) {
    sum = '📝 Write · ' + esc(shortPath(inp.file_path));
    body = bodyDiv(hi(String(inp.content || '').slice(0, 20000), terms));
  } else if (name === 'Edit' && inp.file_path) {
    sum = '✏️ Edit · ' + esc(shortPath(inp.file_path)) + (inp.replace_all ? ' · 全部替换' : '');
    body = diffBody(inp.old_string, inp.new_string, terms);
  } else if (name === 'NotebookEdit' && inp.notebook_path) {
    sum = '✏️ NotebookEdit · ' + esc(shortPath(inp.notebook_path));
  } else if ((name === 'TodoWrite' || name === 'update_todos') && Array.isArray(inp.todos)) {
    var done = inp.todos.filter(function (t) { return t.status === 'completed'; }).length;
    sum = '📋 待办 ' + done + '/' + inp.todos.length;
    body = bodyDiv(inp.todos.map(function (t) {
      var ic = t.status === 'completed' ? '☑' : t.status === 'in_progress' ? '▶' : '☐';
      return ic + ' ' + hi(t.content || t.subject || '', terms);
    }).join('\n'));
  } else if ((name === 'Task' || name === 'Agent') && (inp.prompt || inp.description)) {
    sum = '🤖 ' + esc(name) + (inp.subagent_type ? ' · ' + esc(inp.subagent_type) : '') +
      ' · ' + esc(clip(inp.description || '', 50));
    body = bodyDiv(hi(inp.prompt || '', terms));
  } else if (name === 'TaskCreate' && inp.subject) {
    sum = '📋 建任务 · ' + esc(clip(inp.subject, 70));
    body = bodyDiv(hi(inp.subject + (inp.description ? '\n\n' + inp.description : ''), terms));
  } else if (name === 'TaskUpdate' && inp.taskId) {
    sum = '📋 任务 #' + esc(String(inp.taskId)) +
      (inp.status ? ' → ' + esc(inp.status) : ' 更新');
  } else if ((name === 'Grep' || name === 'Glob') && inp.pattern) {
    sum = '🔍 ' + esc(name) + ' · ' + esc(clip(inp.pattern, 60)) +
      (inp.path ? ' <span class="dim">' + esc(shortPath(inp.path)) + '</span>' : '');
  } else if ((name === 'WebFetch' || name === 'WebSearch') && (inp.url || inp.query)) {
    sum = '🌐 ' + esc(name) + ' · ' + esc(clip(inp.url || inp.query, 70));
  } else if (name === 'AskUserQuestion' && Array.isArray(inp.questions)) {
    sum = '❓ 提问 · ' + esc(clip((inp.questions[0] || {}).question || '', 60));
    body = bodyDiv(inp.questions.map(function (q) {
      return hi(q.question || '', terms) + '\n' + (q.options || []).map(function (o) {
        return '  ○ ' + hi(o.label || '', terms);
      }).join('\n');
    }).join('\n\n'));
  } else if (name === 'Skill' && inp.skill) {
    sum = '⚡ /' + esc(inp.skill) + (inp.args ? ' ' + esc(clip(inp.args, 50)) : '');
  } else if (name === 'ExitPlanMode' || name === 'EnterPlanMode') {
    sum = '🗺 ' + esc(name === 'EnterPlanMode' ? '进入规划模式' : '退出规划模式');
  }
  return { sum: sum, body: body };
}

// ---------- 消息 ----------
function msgEl(m, terms, side) {
  if (m.blocks.length === 1 && m.blocks[0].kind === 'compact') {
    var dv = document.createElement('div'); dv.className = 'divider';
    dv.textContent = m.blocks[0].text; return dv;
  }
  var el = document.createElement('div');
  el.className = 'msg ' + m.role + (side && m.role === 'assistant' ? ' agent' : '');
  var who = m.role === 'user' ? (side ? '任务' : '你') :
            m.role === 'system' ? '系统' : (side ? '子代理' : 'Claude');
  var inner = '';
  m.blocks.forEach(function (b) {
    if (b.kind === 'text')
      inner += '<div class="block md">' + md(b.text, terms) + '</div>';
    else if (b.kind === 'compact')
      inner += '<div class="divider">' + esc(b.text) + '</div>';
    else if (b.kind === 'thinking')
      inner += '<details class="think block"><summary>思考 · ' + b.text.length +
        ' 字</summary><div class="mdbody md">' + md(b.text, terms) + '</div></details>';
    else if (b.kind === 'tool_use') {
      var tv = toolView(b.name, b.input || {}, terms);
      inner += '<details class="tool block"><summary>' + tv.sum + '</summary>' +
        tv.body + '</details>';
    }
    else if (b.kind === 'tool_result')
      inner += '<details class="tool block' + (b.isError ? ' terr' : '') +
        '"><summary>' + (b.isError ? '⚠ 工具报错' : '↩ 工具结果') + ' · ' + (b.text || '').length +
        ' 字</summary><div class="body">' + hi((b.text || '').slice(0, 20000), terms) + '</div></details>';
  });
  if (m.compact) {
    inner = '<details class="pack block"><summary>📦 压缩摘要（续接会话的上文）</summary>' +
      '<div class="mdbody">' + inner + '</div></details>';
  }
  el.innerHTML = '<div class="who ' + m.role + '">' + who + '</div><div class="bubble">' + inner + '</div>';
  return el;
}

// ---------- 搜索命中跳转 ----------
var hits = [], hitIdx = -1;
function setupHits() {
  hits = Array.prototype.slice.call($('#conv').querySelectorAll('mark'));
  // details 里的命中也要能跳过去：跳转时展开祖先 details
  hitIdx = -1;
  var bar = $('#hitbar');
  if (!hits.length) { bar.style.display = 'none'; return; }
  bar.style.display = 'flex';
  gotoHit(0);
}
function hideHits() { $('#hitbar').style.display = 'none'; hits = []; hitIdx = -1; }
function gotoHit(i) {
  if (!hits.length) return;
  if (hitIdx >= 0) hits[hitIdx].classList.remove('cur');
  hitIdx = ((i % hits.length) + hits.length) % hits.length;
  var el = hits[hitIdx];
  var p = el.parentElement;
  while (p) { if (p.tagName === 'DETAILS') p.open = true; p = p.parentElement; }
  el.classList.add('cur');
  el.scrollIntoView({ block: 'center' });
  $('#hitn').textContent = (hitIdx + 1) + ' / ' + hits.length + ' 处命中';
}
$('#hitPrev').onclick = function () { gotoHit(hitIdx - 1); };
$('#hitNext').onclick = function () { gotoHit(hitIdx + 1); };

// ---------- 事件 ----------
var timer = null;
function onQuery() {
  var v = $('#q').value.trim(); clearTimeout(timer);
  if (!v) { searchMode = false; render(''); return; }
  render(v); timer = setTimeout(function () { searchMode = true; doSearch(v); }, 280);
}
function reRun() { var v = $('#q').value.trim(); if (searchMode && v) doSearch(v); else render(v); }

// ---------- 深浅色 ----------
function initTheme() {
  var t = localStorage.getItem('chv-theme');
  if (t) document.documentElement.setAttribute('data-theme', t);
}

// ---------- 登录 ----------
function showLogin() {
  $('#login').style.display = 'flex'; $('#side').style.display = 'none';
  $('#main').style.display = 'none'; setTimeout(function () { $('#pw').focus(); }, 50);
}
function showApp() {
  $('#login').style.display = 'none'; $('#side').style.display = 'flex';
  $('#main').style.display = 'flex'; loadList();
}
async function doLogin() {
  var pw = $('#pw').value; $('#loginErr').textContent = '';
  var r = await fetch('api/login', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password: pw })
  });
  var j = await r.json();
  if (r.ok && j.ok) { $('#pw').value = ''; showApp(); }
  else $('#loginErr').textContent = j.error || '登录失败';
}

// ---------- 绑定 ----------
$('#q').addEventListener('input', onQuery);
$('#q').addEventListener('keydown', function (e) {
  if (e.key === 'Escape') { e.target.value = ''; searchMode = false; render(''); }
});
$('#fproj').addEventListener('change', reRun);
$('#ftime').addEventListener('change', reRun);
$('#fthink').addEventListener('change', reRun);
$('#theme').onclick = function () {
  var cur = document.documentElement.getAttribute('data-theme');
  var next = cur === 'dark' ? 'light' : cur === 'light' ? '' : 'dark';
  if (next) document.documentElement.setAttribute('data-theme', next);
  else document.documentElement.removeAttribute('data-theme');
  localStorage.setItem('chv-theme', next);
};
$('#loginBtn').onclick = doLogin;
$('#pw').addEventListener('keydown', function (e) { if (e.key === 'Enter') doLogin(); });
$('#logout').onclick = async function () { await fetch('api/logout'); showLogin(); };

initTheme();
(async function () {
  var me = await (await fetch('api/me')).json();
  if (me.authed) showApp(); else showLogin();
})();
