'use strict';
// node:test 骨架 —— 覆盖 server.js 的纯函数、parseSession 与 JSON 索引。
// 运行：node --test
// 前端 app.js 依赖浏览器全局（document/location），不在此测；md() 等需另配 DOM 环境。
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

// 用临时目录当扫描根与索引，隔离真实 ~/.claude 与仓库文件。必须在 require server 前设好。
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'chv-test-'));
const PROJECTS = path.join(TMP, 'projects');
fs.mkdirSync(PROJECTS, { recursive: true });
process.env.CLAUDE_PROJECTS_DIR = PROJECTS; // → ROOTS 单根
process.env.INDEX_PATH = path.join(TMP, 'index.json');
process.env.INDEX_BLOBS_PATH = path.join(TMP, 'blobs.json');
process.env.BLOB_TTL_MS = '200'; // 缩短释放时间以便测惰性释放
process.env.CONFIG_PATH = path.join(TMP, 'no-config.json'); // 不存在 → 全默认

const S = require('../server.js');

function writeSession(project, id, records) {
  const dir = path.join(PROJECTS, project);
  fs.mkdirSync(dir, { recursive: true });
  const fp = path.join(dir, id + '.jsonl');
  fs.writeFileSync(fp, records.map((r) => JSON.stringify(r)).join('\n') + '\n');
  return fp;
}
// 造一条 assistant 消息记录（带用量）
const asst = (text, extra = {}) => ({
  type: 'assistant', timestamp: '2026-08-01T10:00:00.000Z',
  message: { role: 'assistant', model: 'claude-opus-4-8',
    content: [{ type: 'text', text }], usage: { input_tokens: 100, output_tokens: 50 } },
  ...extra,
});
const usr = (text) => ({
  type: 'user', timestamp: '2026-08-01T09:59:00.000Z',
  message: { role: 'user', content: text },
});

test('globToRe: * 与 ? 通配，其余按字面', () => {
  assert.ok(S.globToRe('-tmp-*').test('-tmp-foo'));
  assert.ok(!S.globToRe('-tmp-*').test('x-tmp-foo'));
  assert.ok(S.globToRe('a?c').test('abc'));
  assert.ok(!S.globToRe('a?c').test('ac'));
  assert.ok(!S.globToRe('a.b').test('axb')); // . 不当通配
});

test('extractBlocks: 字符串 / 数组内容与空块过滤', () => {
  assert.deepEqual(S.extractBlocks('user', 'hi'), [{ kind: 'text', text: 'hi' }]);
  assert.deepEqual(S.extractBlocks('user', '   '), []); // 纯空白丢弃
  const b = S.extractBlocks('assistant', [
    { type: 'text', text: 'a' },
    { type: 'thinking', thinking: 't' },
    { type: 'tool_use', name: 'Bash', input: { command: 'ls' } },
    { type: 'tool_result', content: 'ok', is_error: true },
    { type: 'unknown' },
  ]);
  assert.equal(b.length, 4);
  assert.equal(b[1].kind, 'thinking');
  assert.equal(b[2].name, 'Bash');
  assert.equal(b[3].isError, true);
});

test('toolResultText: 字符串 / 文本数组 / 图片占位', () => {
  assert.equal(S.toolResultText('x'), 'x');
  assert.equal(S.toolResultText([{ type: 'text', text: 'a' }, { type: 'image' }]), 'a\n[image]');
});

test('priceFor: 精确命中、去日期后缀、未知返回 null', () => {
  assert.deepEqual(S.priceFor('claude-opus-4-8'), { in: 5, out: 25 });
  assert.deepEqual(S.priceFor('claude-sonnet-5-20250929'), { in: 3, out: 15 });
  assert.equal(S.priceFor('gpt-4'), null);
  assert.equal(S.priceFor(''), null);
});

test('costOf: 含缓存档位系数；未知模型返回 null', () => {
  const c = S.costOf({ input_tokens: 1e6, output_tokens: 1e6,
    cache_creation_input_tokens: 1e6, cache_read_input_tokens: 1e6 }, 'claude-opus-4-8');
  // 5 + 25 + 5*1.25 + 5*0.1 = 36.75
  assert.ok(Math.abs(c - 36.75) < 1e-6);
  assert.equal(S.costOf({ input_tokens: 100 }, 'unknown-model'), null);
});

test('parseSession: 标题/首问/消息数/用量/侧链', () => {
  const fp = writeSession('proj-a', 's1', [
    { type: 'ai-title', aiTitle: '搜索索引重构' },
    { type: 'summary', summary: '早前的历史摘要' },
    usr('帮我加个 sqlite 索引'),
    asst('好的，我用 JSON 索引'),
    { type: 'system', subtype: 'compact_boundary', timestamp: '2026-08-01T10:01:00.000Z' },
    asst('子代理在忙', { isSidechain: true, agentId: 'ag1' }),
  ]);
  const s = S.parseSession('proj-a', 's1', fp);
  assert.equal(s.title, '搜索索引重构');
  assert.equal(s.firstPrompt, '帮我加个 sqlite 索引');
  assert.equal(s.summaries.length, 1);
  assert.ok(s.msgCount >= 3);                    // 含 compact 边界
  assert.equal(s.usage.msgs, 2);                 // 两条 assistant 计用量
  assert.equal(s.usage.in, 200);
  assert.ok(s.usage.cost > 0);
  assert.equal(s.sidechains.length, 1);
  assert.equal(s.sidechains[0].agentId, 'ag1');
});

test('searchBlobs: 正文与思考分离、统一小写', () => {
  const s = { messages: [{ isMeta: false, blocks: [
    { kind: 'text', text: 'Hello WORLD' },
    { kind: 'thinking', text: 'SECRET thought' },
    { kind: 'tool_use', name: 'Bash' },
  ] }], sidechains: [] };
  const { text, think } = S.searchBlobs(s);
  assert.ok(text.includes('hello world'));
  assert.ok(text.includes('bash'));
  assert.ok(!text.includes('secret'));           // 思考不进正文 blob
  assert.ok(think.includes('secret thought'));
});

test('listAll + 索引：增量刷新与命中', () => {
  writeSession('proj-b', 's2', [usr('独特关键词 alpaca'), asst('回复 alpaca')]);
  const list = S.listAll();                       // 触发 refreshIndex 建索引
  assert.ok(list.some((x) => x.project === 'proj-b' && x.id === 's2'));
});

test('search：blob 粗筛 + 精确命中数', () => {
  const hits = S.search('alpaca', false);
  const one = hits.find((r) => r.id === 's2');
  assert.ok(one, '应命中含 alpaca 的会话');
  assert.ok(one.hits >= 1);
  const none = S.search('这个词绝不存在xyzzy', false);
  assert.equal(none.length, 0);
});

test('search：含思考开关影响 thinking 命中', () => {
  writeSession('proj-c', 's3', [
    usr('普通提问'),
    { type: 'assistant', timestamp: '2026-08-02T10:00:00.000Z',
      message: { role: 'assistant', model: 'claude-opus-4-8',
        content: [{ type: 'thinking', thinking: '内心独白 zephyr' }] } },
  ]);
  S.refreshIndex(true);
  assert.equal(S.search('zephyr', false).length, 0);      // 默认不搜思考
  assert.ok(S.search('zephyr', true).some((r) => r.id === 's3')); // 含思考才命中
});

test('blobs.json 落盘且不进 index.json（摘要与 blob 分离）', () => {
  S.search('alpaca', false);                               // 触发 blob 载入
  S.saveIndex(); S.saveBlobs();                             // 强制落盘（跳过 3s 防抖）
  const idx = JSON.parse(fs.readFileSync(process.env.INDEX_PATH, 'utf8'));
  assert.equal(idx.version, 2);
  const anyEntry = Object.values(idx.entries)[0];
  assert.ok(anyEntry.summary && anyEntry.stamp);
  assert.ok(!('text' in anyEntry) && !('think' in anyEntry)); // 摘要索引不含 blob
  const blobs = JSON.parse(fs.readFileSync(process.env.INDEX_BLOBS_PATH, 'utf8'));
  assert.ok(blobs.blobs['proj-b/s2'].text.includes('alpaca'));
});

test('blob stamp 过期时自愈重建（改文件后仍能搜到新内容）', () => {
  writeSession('proj-b', 's2', [usr('换了内容 beluga'), asst('回复 beluga')]);
  S.refreshIndex(true);                                    // 更新摘要 stamp
  const hit = S.search('beluga', false);                  // blobFor 发现 stamp 不符 → 重建
  assert.ok(hit.some((r) => r.id === 's2'));
  assert.equal(S.search('alpaca', false).length, 0);      // 旧内容已不在
});

test.after(() => { try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* */ } });
