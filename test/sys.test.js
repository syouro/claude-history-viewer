'use strict';
// 服务器状态的纯函数用例：meminfo / proc stat 解析与进程树 RSS 求和
const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const os = require('os');

// 隔离真实数据（require server.js 时会读扫描根配置）
process.env.CLAUDE_PROJECTS_DIR = os.tmpdir();
process.env.CONFIG_PATH = path.join(os.tmpdir(), 'chv-sys-no-config.json');
process.env.INDEX_PATH = path.join(os.tmpdir(), 'chv-sys-index.json');
process.env.INDEX_BLOBS_PATH = path.join(os.tmpdir(), 'chv-sys-blobs.json');

const { parseMeminfo, parseProcStat, subtreeRss, sysSnapshot } = require('../server.js');

test('parseMeminfo：kB 转字节，忽略不带 kB 的行', () => {
  const mi = parseMeminfo([
    'MemTotal:        3743496 kB',
    'MemAvailable:    1550416 kB',
    'HugePages_Total:       0', // 无单位行不收
    'SwapTotal:       8388604 kB',
  ].join('\n'));
  assert.equal(mi.MemTotal, 3743496 * 1024);
  assert.equal(mi.MemAvailable, 1550416 * 1024);
  assert.equal(mi.SwapTotal, 8388604 * 1024);
  assert.equal(mi.HugePages_Total, undefined);
});

test('parseProcStat：comm 里的空格和括号不干扰字段定位', () => {
  // 真实样本（截断）：pid (comm) state ppid ... 第 24 字段是 rss（页数）
  const line = '123 (tmux: server) S 1 123 123 0 -1 4194304 166 0 0 0 0 0 0 0 ' +
    '20 0 1 0 885496267 6889472 428 18446744073709551615 0 0';
  const st = parseProcStat(line);
  assert.equal(st.ppid, 1);
  assert.equal(st.rss, 428 * 4096);
  assert.equal(parseProcStat('garbage without paren'), null);
});

test('subtreeRss：沿子进程求和，兄弟树不掺和', () => {
  const procs = new Map([
    [100, { ppid: 1, rss: 1000 }],   // 根
    [101, { ppid: 100, rss: 200 }],  // 子
    [102, { ppid: 101, rss: 30 }],   // 孙
    [200, { ppid: 1, rss: 9999 }],   // 无关的兄弟树
  ]);
  assert.equal(subtreeRss(procs, 100), 1230);
  assert.equal(subtreeRss(procs, 101), 230);
  assert.equal(subtreeRss(procs, 12345), 0); // 不存在的 pid
});

test('sysSnapshot：无窗格时用默认单价，结构齐全', () => {
  const s = sysSnapshot([]);
  assert.ok(s.mem.total > 0);
  assert.ok(s.mem.avail >= 0);
  assert.ok(Array.isArray(s.load) && s.load.length === 3);
  assert.ok(s.cpus >= 1);
  assert.equal(s.est.sampled, 0);
  assert.equal(s.est.perAgent, 500 * 1024 * 1024);
  assert.ok(s.est.canOpen >= 0);
  assert.deepEqual(s.paneMem, {});
});
