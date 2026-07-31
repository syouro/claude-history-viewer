'use strict';
var $ = function (s) { return document.querySelector(s); };
var sessions = [], current = null, searchMode = false, lastTerms = [], favs = {};
var SHARE = new URLSearchParams(location.search).get('share'); // 访客只读模式
function favKey(s) { return s.project + '/' + s.id; }
function shareQ() { return SHARE ? '&share=' + encodeURIComponent(SHARE) : ''; }
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
// 表格：按 GFM 切单元格（\| 为转义竖线，首尾竖线可省）
function mdCells(line) {
  var s = line.trim();
  if (s.charAt(0) === '|') s = s.slice(1);
  if (s.charAt(s.length - 1) === '|' && s.charAt(s.length - 2) !== '\\') s = s.slice(0, -1);
  var cells = [], cur = '';
  for (var k = 0; k < s.length; k++) {
    var c = s.charAt(k);
    if (c === '\\' && s.charAt(k + 1) === '|') { cur += '|'; k++; continue; }
    if (c === '|') { cells.push(cur.trim()); cur = ''; continue; }
    cur += c;
  }
  cells.push(cur.trim());
  return cells;
}
function mdIsSep(l) {
  if (l.indexOf('|') < 0) return false;
  var cs = mdCells(l);
  return cs.length > 0 && cs.every(function (c) { return /^:?-+:?$/.test(c); });
}
function mdTable(head, sep, rows) {
  var aligns = mdCells(sep).map(function (c) {
    var l = c.charAt(0) === ':', r = c.charAt(c.length - 1) === ':';
    return l && r ? 'center' : r ? 'right' : l ? 'left' : '';
  });
  var hs = mdCells(head);
  var cell = function (tag, txt, i) {
    var a = aligns[i] ? ' style="text-align:' + aligns[i] + '"' : '';
    return '<' + tag + a + '>' + mdInline(txt) + '</' + tag + '>';
  };
  var out = '<div class="tw"><table class="mtbl"><thead><tr>' +
    hs.map(function (c, i) { return cell('th', c, i); }).join('') + '</tr></thead><tbody>';
  rows.forEach(function (r) {
    var cs = mdCells(r), tr = '';
    for (var i = 0; i < hs.length; i++) tr += cell('td', cs[i] === undefined ? '' : cs[i], i);
    out += '<tr>' + tr + '</tr>';
  });
  return out + '</tbody></table></div>';
}
function mdBlocks(text) {
  var lines = text.split('\n'), html = [], i = 0, fence = BT + BT + BT;
  var isList = function (l) { return /^\s*([-*+]|\d+[.)])\s+/.test(l); };
  // 表格要看下一行是不是分隔行（|---|---|），所以带一个 lookahead
  var isTable = function (l, nx) { return l.indexOf('|') >= 0 && mdIsSep(nx || ''); };
  var isBlock = function (l, nx) {
    return l.slice(0, 3) === fence || /^#{1,6}\s+/.test(l) || /^\s*>/.test(l) ||
      isList(l) || /^\s*([-*_])\1\1+\s*$/.test(l) || isTable(l, nx);
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
    if (isTable(line, lines[i + 1])) {
      var head = line, sep = lines[i + 1], rows = [];
      i += 2;
      while (i < lines.length && lines[i].indexOf('|') >= 0 && !/^\s*$/.test(lines[i])) {
        rows.push(lines[i]); i++;
      }
      html.push(mdTable(head, sep, rows));
      continue;
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
    while (i < lines.length && !/^\s*$/.test(lines[i]) && !isBlock(lines[i], lines[i + 1])) {
      para.push(lines[i]); i++;
    }
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
  var proj = $('#fproj').value, sel = $('#ftime').value;
  var lo = 0, hi = Infinity;                       // 自定义区间按本地日历日，含首含尾
  if (sel === 'custom') {
    var f = $('#ffrom').value, t = $('#fto').value;
    if (f) lo = new Date(f + 'T00:00:00').getTime();
    if (t) hi = new Date(t + 'T23:59:59.999').getTime();
  } else if (+sel) {
    lo = Date.now() - (+sel) * 86400e3;
  }
  return arr.filter(function (s) {
    if (proj && s.project !== proj) return false;
    var ts = tsOf(s);
    if (ts < lo || ts > hi) return false;
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
  // 收藏组置顶
  var favItems = items.filter(function (s) { return favs[favKey(s)]; });
  if (favItems.length) {
    var fg = document.createElement('div'); fg.className = 'grp'; fg.textContent = '★ 收藏';
    list.appendChild(fg);
    favItems.forEach(function (s) { list.appendChild(itemEl(s, filter)); });
  }
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
function isLive(s) { return Date.now() - s.mtime < 120e3; }
function itemEl(s, filter) {
  var el = document.createElement('div');
  el.className = 'item' + (current && current.id === s.id ? ' on' : '');
  var fv = favs[favKey(s)];
  el.innerHTML = '<div class="t">' + (fv ? '★ ' : '') +
    (filter ? hi(s.title, [filter]) : esc(s.title)) + '</div>' +
    (fv && fv.note ? '<div class="fnote">' + esc(fv.note) + '</div>' : '') +
    '<div class="r">' + (isLive(s) ? '<span class="liveb">进行中</span>' : '') +
    '<span>' + rel(s.lastTs) + '</span><span>' + s.msgCount + ' 条</span>' +
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
    '&id=' + encodeURIComponent(s.id) + shareQ() + (params || ''))
    .then(function (r) { return r.json(); });
}
async function open(s, jumpIdx) {
  // 搜索模式或锚点跳转时全量加载（要能定位任意位置）；平时只取最近 PAGE 条
  var full = (searchMode && lastTerms.length) || jumpIdx != null;
  var data = await apiSession(s, full ? '&limit=0' : '&limit=' + PAGE);
  if (data.error) return;
  current = data;
  view = { offset: data.offset, total: data.total, terms: full ? lastTerms : [],
    mode: 'main', loading: false, wrap: null, older: null };
  $('#top').style.display = 'flex'; $('#ttl').textContent = data.title;
  var bits = [projName(data.project), '<span id="mcount">' + data.msgCount + ' 条消息</span>',
    data.usage && data.usage.cost ? ('≈ ' + fmtUSD(data.usage.cost)) : '',
    data.agentName ? ('⚙ ' + esc(data.agentName)) : '',
    data.gitBranch ? ('⎇ ' + data.gitBranch) : '',
    data.cwd ? ('<span class="mono">' + esc(data.cwd) + '</span>') : '',
    data.firstTs ? new Date(data.firstTs).toLocaleString('zh-CN') : ''].filter(Boolean);
  $('#sub').innerHTML = bits.map(function (b) { return '<span>' + b + '</span>'; }).join('');
  $('#exp').onclick = function () {
    var a = document.createElement('a');
    a.href = 'api/export?project=' + encodeURIComponent(data.project) +
      '&id=' + encodeURIComponent(data.id) + shareQ();
    a.download = ''; document.body.appendChild(a); a.click(); a.remove();
  };
  if (SHARE) {
    $('#fav').style.display = 'none'; $('#share').style.display = 'none';
    $('#sub').innerHTML += '<span class="robadge">只读分享</span>';
  }
  syncFavUI(data);
  renderChains(data);
  renderMain(data.messages);
  document.body.classList.remove('nav-open'); // 移动端选完会话收起抽屉
  if (jumpIdx != null) jumpToMsg(jumpIdx);
  history.replaceState(null, '', '#s=' + encodeURIComponent(data.project) + '/' +
    encodeURIComponent(data.id) + (jumpIdx != null ? '/' + jumpIdx : ''));
  scheduleLive();
  if (searchMode) doSearch($('#q').value.trim()); else render($('#q').value.trim());
}
function jumpToMsg(idx) {
  var el = $('#conv').querySelector('.msg[data-idx="' + idx + '"]');
  if (!el) return;
  el.scrollIntoView({ block: 'center' });
  el.classList.add('flash');
  setTimeout(function () { el.classList.remove('flash'); }, 2000);
}
// #s=项目/会话ID[/消息序号] 直达定位
function navFromHash() {
  var m = location.hash.match(/^#s=([^/]+)\/([^/]+)(?:\/(\d+))?$/);
  if (!m) return;
  var s = { project: decodeURIComponent(m[1]), id: decodeURIComponent(m[2]) };
  var idx = m[3] === undefined ? null : +m[3];
  if (current && current.project === s.project && current.id === s.id && idx != null &&
      $('#conv').querySelector('.msg[data-idx="' + idx + '"]')) { jumpToMsg(idx); return; }
  open(s, idx);
}
window.addEventListener('hashchange', navFromHash);

// ---------- 收藏 ----------
async function loadFavs() {
  try { favs = await (await fetch('api/favs')).json(); } catch (e) { favs = {}; }
}
function syncFavUI(s) {
  var fv = favs[favKey(s)];
  $('#fav').textContent = fv ? '★ 已收藏' : '☆ 收藏';
  $('#fav').className = fv ? 'on' : '';
  var inp = $('#favnote');
  inp.style.display = fv ? 'block' : 'none';
  inp.value = fv ? (fv.note || '') : '';
  $('#fav').onclick = function () { setFav(s, !fv, fv ? fv.note : ''); };
  inp.onkeydown = function (e) { if (e.key === 'Enter') { setFav(s, true, inp.value); inp.blur(); } };
  inp.onblur = function () { if (favs[favKey(s)]) setFav(s, true, inp.value); };
}
async function setFav(s, fav, note) {
  var old = JSON.stringify(favs[favKey(s)] || null);
  var r = await fetch('api/fav', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ project: s.project, id: s.id, fav: fav, note: note || '' })
  });
  var j = await r.json();
  if (!j.ok) return;
  favs = j.favs;
  if (JSON.stringify(favs[favKey(s)] || null) === old) return; // 无变化不重绘
  if (current && current.id === s.id) syncFavUI(s);
  render($('#q').value.trim());
}

// ---------- 只读分享 ----------
$('#share').onclick = async function () {
  if (!current) return;
  var r = await fetch('api/share', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ project: current.project, id: current.id, days: 7 })
  });
  var j = await r.json();
  if (!j.token) return;
  var link = location.origin + location.pathname + '?share=' + encodeURIComponent(j.token) +
    '#s=' + encodeURIComponent(current.project) + '/' + encodeURIComponent(current.id);
  var note = '只读链接（' + new Date(j.exp).toLocaleDateString('zh-CN') + ' 过期）：';
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(link).then(function () {
      var b = $('#share'); b.textContent = '✓ 已复制';
      setTimeout(function () { b.textContent = '分享'; }, 1500);
    }, function () { window.prompt(note, link); });
  } else window.prompt(note, link);
};
// 访客只读视图：无侧栏，仅渲染 token 对应的会话
function showShareView() {
  $('#login').style.display = 'none'; $('#side').style.display = 'none';
  $('#main').style.display = 'flex';
  navFromHash();
}

// ---------- 实时跟踪进行中的会话 ----------
var liveTimer = null;
function scheduleLive() {
  clearTimeout(liveTimer);
  if (!current) return;
  // 活跃会话（2 分钟内有写入）3s 一查，闲置的 15s 一查
  liveTimer = setTimeout(pollLive, isLive(current) ? 3000 : 15000);
}
async function pollLive() {
  if (!current) return;
  if (document.hidden) { scheduleLive(); return; }
  try {
    var meta = await apiSession(current, '&meta=1');
    if (!current || meta.id !== current.id) return; // 期间切换了会话
    current.mtime = meta.mtime;
    var mc = $('#mcount'); if (mc) mc.textContent = meta.total + ' 条消息';
    if (view.mode === 'main' && meta.total > view.total) {
      var delta = await apiSession(current,
        '&limit=' + (meta.total - view.total) + '&before=' + meta.total);
      if (!current || delta.id !== current.id || view.mode !== 'main') return;
      var conv = $('#conv');
      var follow = conv.scrollHeight - conv.scrollTop - conv.clientHeight < 150;
      delta.messages.forEach(function (m, j) {
        if (!m.isMeta) view.wrap.appendChild(msgEl(m, view.terms, false, delta.offset + j));
      });
      view.total = meta.total;
      if (follow) conv.scrollTop = conv.scrollHeight; // 在底部时自动跟随
    } else if (meta.total < view.total) {
      open(current); return; // 文件被重写（罕见），整体重开
    }
  } catch (e) { /* 网络抖动，下轮再试 */ }
  scheduleLive();
}
// 侧栏列表每分钟静默刷新（保持滚动位置；搜索模式不打扰）
setInterval(function () {
  if (document.hidden || searchMode) return;
  fetch('api/sessions').then(function (r) { return r.ok ? r.json() : null; })
    .then(function (d) {
      if (!d) return;
      var list = $('#list'), st = list.scrollTop;
      sessions = d; fillProjects(); render($('#q').value.trim());
      list.scrollTop = st;
    });
}, 60000);
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
  msgs.forEach(function (m, j) {
    if (!m.isMeta) wrap.appendChild(msgEl(m, view.terms, false, view.offset + j));
  });
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
  data.messages.forEach(function (m, j) {
    if (!m.isMeta) frag.appendChild(msgEl(m, view.terms, false, data.offset + j));
  });
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
    '&id=' + encodeURIComponent(current.id) + '&agent=' + encodeURIComponent(agentId) +
    shareQ())).json();
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
function msgEl(m, terms, side, idx) {
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
  var anchor = '';
  if (!side && idx !== undefined) {
    el.dataset.idx = idx;
    anchor = '<button class="alink" title="复制此消息的直达链接">🔗</button>';
  }
  el.innerHTML = '<div class="who ' + m.role + '">' + who + '</div><div class="bubble">' +
    anchor + inner + '</div>';
  return el;
}
// 锚点按钮：事件委托，复制 #s= 直达链接
$('#conv').addEventListener('click', function (e) {
  var btn = e.target && e.target.closest ? e.target.closest('.alink') : null;
  if (!btn || !current) return;
  var msg = btn.closest('.msg');
  var link = location.origin + location.pathname + '#s=' +
    encodeURIComponent(current.project) + '/' + encodeURIComponent(current.id) +
    '/' + msg.dataset.idx;
  var done = function () {
    btn.textContent = '✓';
    setTimeout(function () { btn.textContent = '🔗'; }, 1200);
  };
  if (navigator.clipboard && navigator.clipboard.writeText)
    navigator.clipboard.writeText(link).then(done, function () { window.prompt('复制链接：', link); });
  else window.prompt('复制链接：', link);
});

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

// ---------- 用量统计面板 ----------
function fmtTok(n) {
  n = n || 0;
  if (n >= 1e9) return (n / 1e9).toFixed(2) + 'B';
  if (n >= 1e6) return (n / 1e6).toFixed(1) + 'M';
  if (n >= 1e3) return (n / 1e3).toFixed(1) + 'k';
  return String(n);
}
function tile(v, k) {
  return '<div class="tile"><div class="v">' + v + '</div><div class="k">' + k + '</div></div>';
}
function fmtUSD(n) {
  n = n || 0;
  return '$' + (n >= 100 ? n.toFixed(0) : n >= 1 ? n.toFixed(2) : n.toFixed(3));
}
function usageRow(name, u, extra) {
  return '<tr><td>' + esc(name) + '</td>' + (extra || '') +
    '<td>' + u.msgs + '</td><td>' + fmtTok(u.out) + '</td><td>' + fmtTok(u.in) +
    '</td><td>' + fmtTok(u.cw) + '</td><td>' + fmtTok(u.cr) +
    '</td><td>' + fmtUSD(u.cost) + '</td></tr>';
}
var USAGE_TH = '<th>消息</th><th>输出</th><th>输入</th><th>缓存写</th><th>缓存读</th><th>花费（估算）</th>';
// 统计区间（UTC 日期，与后端按 timestamp 切出来的天对齐）
var statsRange = { preset: '30', from: '', to: '' };
function dayStr(d) { return new Date(d).toISOString().slice(0, 10); }
function shiftDay(day, n) { return dayStr(new Date(day + 'T00:00:00Z').getTime() + n * 86400e3); }
function daysBetween(a, b) {
  return Math.round((new Date(b + 'T00:00:00Z') - new Date(a + 'T00:00:00Z')) / 86400e3);
}
// 预设 -> {from,to}；'all' 交给后端（前端再用 range.minDay/maxDay 画图）
function presetRange(p) {
  var today = dayStr(Date.now());
  if (p === 'all') return { from: '', to: '' };
  if (p === 'year') return { from: today.slice(0, 4) + '-01-01', to: today };
  if (p === 'custom') return { from: statsRange.from, to: statsRange.to };
  return { from: shiftDay(today, -(+p - 1)), to: today };
}
// 区间太长时按周 / 月并柱，柱子数控制在 ~100 根以内
function bucketDays(from, to, daysMap) {
  var span = Math.max(1, Math.min(daysBetween(from, to) + 1, 3660));
  var unit = span <= 100 ? 'day' : span <= 400 ? 'week' : 'month';
  var list = [], index = {};
  for (var i = 0; i < span; i++) {
    var day = shiftDay(from, i);
    var key = unit === 'day' ? day
      : unit === 'week' ? shiftDay(from, Math.floor(i / 7) * 7)
      : day.slice(0, 7);
    var b = index[key];
    if (!b) {
      b = index[key] = {
        key: key, from: day, to: day,
        label: unit === 'month' ? key : key.slice(5),
        u: { in: 0, out: 0, cw: 0, cr: 0, msgs: 0, cost: 0 },
      };
      list.push(b);
    }
    b.to = day;
    var u = daysMap[day];
    if (u) {
      b.u.in += u.in; b.u.out += u.out; b.u.cw += u.cw; b.u.cr += u.cr;
      b.u.msgs += u.msgs; b.u.cost += u.cost || 0;
    }
  }
  return { unit: unit, list: list };
}
var UNIT_CN = { day: '每日', week: '每周', month: '每月' };
async function openStats() {
  var r = presetRange(statsRange.preset);
  var qs = [];
  if (r.from) qs.push('from=' + r.from);
  if (r.to) qs.push('to=' + r.to);
  var st = await (await fetch('api/stats' + (qs.length ? '?' + qs.join('&') : ''))).json();
  current = null; view.mode = 'stats'; clearTimeout(liveTimer);
  $('#top').style.display = 'none'; $('#chains').style.display = 'none'; hideHits();
  // 「全部」用库里数据的真实边界当区间；空库退化成今天
  var today = dayStr(Date.now());
  var cFrom = r.from || st.range.minDay || today;
  var cTo = r.to || st.range.maxDay || today;
  if (cTo < cFrom) cTo = cFrom;
  var bk = bucketDays(cFrom, cTo, st.days || {});
  var series = bk.list;
  var max = Math.max.apply(0, series.map(function (s) { return s.u.out; })) || 1;
  var bars = '', labels = '', peak = '', lblEvery = Math.ceil(series.length / 8);
  series.forEach(function (s, i) {
    var h = Math.round(s.u.out / max * 100);
    bars += '<div class="cbar" data-i="' + i + '"><i style="height:' + h + '%"></i></div>';
    labels += '<span>' + (i % lblEvery === 0 ? s.label : '') + '</span>';
    if (s.u.out === max && max > 0 && !peak)
      peak = '<div class="cpeak" style="left:' + ((i + 0.5) / series.length * 100) +
        '%;top:2px">' + fmtTok(s.u.out) + '</div>';
  });
  var presets = [['7', '近 7 天'], ['30', '近 30 天'], ['90', '近 90 天'], ['365', '近一年'],
    ['year', '今年'], ['all', '全部'], ['custom', '自定义']];
  var picker = '<div class="rpick">' + presets.map(function (p) {
    return '<button class="rbtn' + (statsRange.preset === p[0] ? ' on' : '') +
      '" data-p="' + p[0] + '">' + p[1] + '</button>';
  }).join('') +
    '<span class="rcustom"' + (statsRange.preset === 'custom' ? '' : ' style="display:none"') +
    '><input type="date" id="rfrom" value="' + (statsRange.from || cFrom) + '">' +
    '<span>→</span><input type="date" id="rto" value="' + (statsRange.to || cTo) + '">' +
    '<button class="rbtn" id="rgo">查询</button></span>' +
    '<span class="rnote">' + cFrom + ' ~ ' + cTo + '（UTC）</span></div>';
  var t = st.totals;
  var projRows = Object.keys(st.byProject).sort(function (a, b) {
    return st.byProject[b].out - st.byProject[a].out;
  }).map(function (pj) {
    var u = st.byProject[pj];
    return usageRow(projName(pj), u, '<td>' + u.sessions + '</td>');
  }).join('');
  var modelRows = Object.keys(st.byModel).sort(function (a, b) {
    return st.byModel[b].out - st.byModel[a].out;
  }).map(function (m) { return usageRow(m, st.byModel[m]); }).join('');
  $('#conv').innerHTML = '<div class="wrap stats">' + picker +
    '<div class="tiles">' +
    tile(t.sessions, '会话') + tile(t.msgTotal, '消息') +
    tile(fmtTok(t.out), '输出 token') + tile(fmtTok(t.in), '输入 token') +
    tile(fmtTok(t.cw), '缓存写入') + tile(fmtTok(t.cr), '缓存读取') +
    tile(fmtUSD(t.cost), '花费（估算）') +
    '</div>' +
    '<h3>' + UNIT_CN[bk.unit] + '输出 token</h3>' +
    '<div class="chart">' + peak + '<div class="cbars">' + bars + '</div>' +
    '<div class="cxl">' + labels + '</div><div class="ctip" id="ctip"></div></div>' +
    '<h3>按项目</h3><div class="tblwrap"><table class="stbl">' +
    '<tr><th>项目</th><th>会话</th>' + USAGE_TH + '</tr>' + projRows + '</table></div>' +
    '<h3>按模型</h3><div class="tblwrap"><table class="stbl">' +
    '<tr><th>模型</th>' + USAGE_TH + '</tr>' + modelRows + '</table></div>' +
    '</div>';
  $('#conv').scrollTop = 0;
  // 区间选择
  $('#conv').querySelectorAll('.rbtn[data-p]').forEach(function (b) {
    b.onclick = function () {
      var p = b.dataset.p;
      if (p === 'custom' && statsRange.preset !== 'custom') {
        if (!statsRange.from) { statsRange.from = cFrom; statsRange.to = cTo; }
      }
      statsRange.preset = p;
      openStats();
    };
  });
  if ($('#rgo')) {
    $('#rgo').onclick = function () {
      var f = $('#rfrom').value, tt = $('#rto').value;
      if (!f || !tt) return;
      if (f > tt) { var sw = f; f = tt; tt = sw; }
      statsRange = { preset: 'custom', from: f, to: tt };
      openStats();
    };
  }
  // 悬浮提示：逐条柱子显示当格完整拆解
  var tip = $('#ctip');
  document.querySelectorAll('.cbar').forEach(function (bar) {
    bar.addEventListener('mouseenter', function () {
      var s = series[+bar.dataset.i];
      var u = s.u;
      var head = s.from === s.to ? s.from : s.from + ' ~ ' + s.to;
      tip.innerHTML = '<b>' + head + '</b><br>输出 ' + fmtTok(u.out) +
        ' · 输入 ' + fmtTok(u.in) + '<br>缓存写 ' + fmtTok(u.cw) +
        ' · 读 ' + fmtTok(u.cr) + '<br>' + u.msgs + ' 条回复 · ' + fmtUSD(u.cost);
      tip.style.display = 'block';
      var r = bar.getBoundingClientRect(), c = bar.closest('.chart').getBoundingClientRect();
      var x = r.left - c.left + r.width / 2;
      tip.style.left = Math.min(Math.max(x - 60, 4), c.width - 150) + 'px';
      tip.style.top = '20px';
    });
    bar.addEventListener('mouseleave', function () { tip.style.display = 'none'; });
  });
  render($('#q').value.trim());
}

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
  $('#main').style.display = 'none'; $('#menuBtn').style.display = 'none';
  setTimeout(function () { $('#pw').focus(); }, 50);
}
function showApp() {
  $('#login').style.display = 'none'; $('#side').style.display = 'flex';
  $('#main').style.display = 'flex';
  $('#menuBtn').style.display = ''; // 交回 CSS 控制（桌面隐藏/移动显示）
  loadFavs().then(loadList).then(navFromHash).then(function () {
    // 移动端进来没有目标会话时，直接展开列表抽屉
    if (!current && window.matchMedia('(max-width:720px)').matches)
      document.body.classList.add('nav-open');
  });
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
$('#ftime').addEventListener('change', function () {
  var custom = $('#ftime').value === 'custom';
  $('#fdates').style.display = custom ? 'flex' : 'none';
  if (custom && !$('#ffrom').value) {                 // 首次切过来给个近 30 天的默认区间
    var today = new Date();
    var local = function (d) {
      return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 10);
    };
    $('#fto').value = local(today);
    $('#ffrom').value = local(new Date(today.getTime() - 29 * 86400e3));
  }
  reRun();
});
$('#ffrom').addEventListener('change', reRun);
$('#fto').addEventListener('change', reRun);
$('#fthink').addEventListener('change', reRun);
$('#theme').onclick = function () {
  var cur = document.documentElement.getAttribute('data-theme');
  var next = cur === 'dark' ? 'light' : cur === 'light' ? '' : 'dark';
  if (next) document.documentElement.setAttribute('data-theme', next);
  else document.documentElement.removeAttribute('data-theme');
  localStorage.setItem('chv-theme', next);
};
$('#statsBtn').onclick = function () {
  document.body.classList.remove('nav-open');
  openStats();
};
$('#menuBtn').onclick = function () { document.body.classList.toggle('nav-open'); };
$('#scrim').onclick = function () { document.body.classList.remove('nav-open'); };
$('#loginBtn').onclick = doLogin;
$('#pw').addEventListener('keydown', function (e) { if (e.key === 'Enter') doLogin(); });
$('#logout').onclick = async function () { await fetch('api/logout'); showLogin(); };

initTheme();
(async function () {
  var me = await (await fetch('api/me')).json();
  if (me.authed) showApp();
  else if (SHARE) showShareView();
  else showLogin();
})();
