'use strict';
// agy（Antigravity CLI）数据源：parseAgySession 与 SOURCES.agy 扫描/索引
const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const os = require('os');
const fs = require('fs');

// 隔离真实数据：agy 指向 fixture，claude/codex 指向空目录
const FIX = fs.mkdtempSync(path.join(os.tmpdir(), 'chv-agy-'));
process.env.AGY_DIR = FIX;
process.env.CLAUDE_PROJECTS_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'chv-agy-empty-'));
process.env.CODEX_SESSIONS_DIR = path.join(FIX, 'no-codex');
process.env.CONFIG_PATH = path.join(FIX, 'no-config.json');
process.env.INDEX_PATH = path.join(FIX, 'index.json');
process.env.INDEX_BLOBS_PATH = path.join(FIX, 'index.blobs.json');

const ID = '11111111-2222-4333-8444-555555555555';
const LOGS = path.join(FIX, 'brain', ID, '.system_generated', 'logs');
fs.mkdirSync(LOGS, { recursive: true });
// 形态照 2026-08-20 对真实 transcript_full.jsonl 的勘察（字段/包裹见 server.js 注释）
fs.writeFileSync(path.join(LOGS, 'transcript_full.jsonl'), [
  JSON.stringify({ step_index: 0, source: 'USER_EXPLICIT', type: 'USER_INPUT', status: 'DONE',
    created_at: '2026-08-06T14:43:09Z',
    content: '<USER_REQUEST>\n你好，帮我看下文件\n</USER_REQUEST>\n<ADDITIONAL_METADATA>\n' +
      'The current local time is: 2026-08-06T22:43:09+08:00.\n</ADDITIONAL_METADATA>\n' +
      '<USER_SETTINGS_CHANGE>\nThe user changed setting `Model Selection` from None to ' +
      'Gemini 3.5 Flash (High). No need to comment on this change if the user doesn\'t ask ' +
      'about it.\n</USER_SETTINGS_CHANGE>' }),
  JSON.stringify({ step_index: 1, source: 'SYSTEM', type: 'CONVERSATION_HISTORY',
    status: 'DONE', content: '' }),
  JSON.stringify({ step_index: 2, source: 'MODEL', type: 'PLANNER_RESPONSE', status: 'DONE',
    created_at: '2026-08-06T14:43:20Z', thinking: '先看看文件内容',
    content: '我来查看这个文件。',
    tool_calls: [{ name: 'view_file', args: { AbsolutePath: '/root/codexDir/Hearth/a.md',
      toolAction: 'Viewing file', toolSummary: 'View a.md' } }] }),
  JSON.stringify({ step_index: 3, source: 'MODEL', type: 'VIEW_FILE', status: 'DONE',
    created_at: '2026-08-06T14:43:21Z',
    content: 'Created At: 2026-08-06T14:43:21Z\nCompleted At: 2026-08-06T14:43:21Z\n' +
      'File Path: `file:///root/codexDir/Hearth/a.md`\nTotal Lines: 3\n内容在这里' }),
  JSON.stringify({ step_index: 4, source: 'SYSTEM', type: 'ERROR_MESSAGE', status: 'DONE',
    error: 'There was a problem parsing the tool call.' }),
  JSON.stringify({ step_index: 5, source: 'SYSTEM', type: 'CHECKPOINT', status: 'DONE',
    created_at: '2026-08-06T15:00:00Z', content: '# Resuming from a compaction\n…' }),
].join('\n') + '\n');
fs.writeFileSync(path.join(FIX, 'history.jsonl'), [
  JSON.stringify({ display: '早期无 conversationId 的旧条目', timestamp: 1786372000000,
    workspace: '/root/somewhere' }),
  JSON.stringify({ display: '你好，帮我看下文件', timestamp: 1786373000000,
    workspace: '/root/codexDir/Hearth', conversationId: ID }),
  JSON.stringify({ display: '/model', timestamp: 1786373100000,
    workspace: '/root/codexDir/Hearth', conversationId: ID, type: 'slash_command' }),
].join('\n') + '\n');

const { parseAgySession, agyProject, refreshIndex, listAll, loadSession } =
  require('../server.js');

test('parseAgySession：包裹剥离 / 思考+工具 / 结果与错误 / 压缩标记', () => {
  const s = parseAgySession(ID, path.join(LOGS, 'transcript_full.jsonl'));
  assert.equal(s.src, 'agy');
  assert.equal(s.project, agyProject('/root/codexDir/Hearth'));
  assert.equal(s.cwd, '/root/codexDir/Hearth');
  assert.equal(s.title, '你好，帮我看下文件');
  assert.equal(s.lastModel, 'Gemini 3.5 Flash (High)'); // 从设置变更记录里挖的
  const [u, a, r, e, c] = s.messages;
  assert.equal(u.role, 'user');
  assert.equal(u.blocks[0].text, '你好，帮我看下文件'); // 环境包裹剥掉
  assert.equal(u.isMeta, false);
  assert.equal(a.role, 'assistant');
  assert.deepEqual(a.blocks.map((b) => b.kind), ['thinking', 'text', 'tool_use']);
  assert.equal(a.blocks[2].name, 'view_file');
  assert.equal(a.blocks[2].input.AbsolutePath, '/root/codexDir/Hearth/a.md');
  assert.equal(r.blocks[0].kind, 'tool_result');
  assert.match(r.blocks[0].text, /^File Path/); // Created/Completed At 头两行剥掉
  assert.equal(r.blocks[0].isError, false);
  assert.equal(e.blocks[0].kind, 'text');
  assert.match(e.blocks[0].text, /^⚠ There was a problem/);
  assert.equal(c.blocks[0].kind, 'compact');
});

test('SOURCES.agy：扫描进索引，src/键正确，claude 页不混入', () => {
  refreshIndex(true);
  const all = listAll();
  assert.equal(all.length, 1);
  assert.equal(all[0].src, 'agy');
  assert.equal(all[0].id, ID);
  const s = loadSession(all[0].project, ID, 'agy');
  assert.ok(s && s.msgCount === 5);
  assert.equal(loadSession(all[0].project, ID, 'claude'), null); // 跨源取不到
});
