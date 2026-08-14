'use strict';
// parseCodexSession：codex rollout-*.jsonl 的解析
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { parseCodexSession, codexProject } = require('../server.js');

const L = (o) => JSON.stringify(o);
const lines = [
  L({ timestamp: '2026-04-08T06:24:32.741Z', type: 'session_meta', payload: {
    id: '019d6bc3-7f32-7f83-8dfc-26c1cbc5c797', timestamp: '2026-04-08T06:24:27.500Z',
    cwd: '/root/codexDir/chuyu', git: { branch: 'main' } } }),
  L({ timestamp: '2026-04-08T06:24:32.750Z', type: 'response_item', payload: {
    type: 'message', role: 'developer',
    content: [{ type: 'input_text', text: '<permissions instructions>\nblah' }] } }),
  L({ timestamp: '2026-04-08T06:24:32.751Z', type: 'turn_context', payload: {
    turn_id: 't1', cwd: '/root/codexDir/chuyu', model: 'gpt-5.4' } }),
  L({ timestamp: '2026-04-08T06:24:32.752Z', type: 'response_item', payload: {
    type: 'message', role: 'user',
    content: [{ type: 'input_text', text: '<environment_context>\n<cwd>x</cwd>' }] } }),
  L({ timestamp: '2026-04-08T06:24:32.754Z', type: 'response_item', payload: {
    type: 'message', role: 'user', content: [{ type: 'input_text', text: '测试一下' }] } }),
  // event_msg 的 user/agent_message 与 response_item 重复，应被忽略
  L({ timestamp: '2026-04-08T06:24:32.755Z', type: 'event_msg', payload: {
    type: 'user_message', message: '测试一下' } }),
  L({ timestamp: '2026-04-08T06:24:34.057Z', type: 'response_item', payload: {
    type: 'reasoning', summary: [{ type: 'summary_text', text: '想一想' }],
    content: null, encrypted_content: 'xxx' } }),
  L({ timestamp: '2026-04-08T06:24:34.100Z', type: 'response_item', payload: {
    type: 'function_call', name: 'exec_command',
    arguments: '{"cmd":"pwd","workdir":"/root/codexDir/chuyu"}', call_id: 'c1' } }),
  L({ timestamp: '2026-04-08T06:24:34.200Z', type: 'response_item', payload: {
    type: 'function_call_output', call_id: 'c1',
    output: 'Command: pwd\nProcess exited with code 0\nOutput:\n/root/codexDir/chuyu\n' } }),
  L({ timestamp: '2026-04-08T06:24:34.300Z', type: 'response_item', payload: {
    type: 'custom_tool_call', name: 'apply_patch', call_id: 'c2',
    input: '*** Begin Patch\n*** Add File: /tmp/a\n+hello\n*** End Patch' } }),
  L({ timestamp: '2026-04-08T06:24:34.350Z', type: 'response_item', payload: {
    type: 'custom_tool_call_output', call_id: 'c2',
    output: '{"output":"Success.","metadata":{"exit_code":0,"duration_seconds":0}}' } }),
  L({ timestamp: '2026-04-08T06:24:34.410Z', type: 'response_item', payload: {
    type: 'message', role: 'assistant', content: [{ type: 'output_text', text: '搞定了。' }] } }),
  L({ timestamp: '2026-04-08T06:24:34.420Z', type: 'event_msg', payload: {
    type: 'agent_message', message: '搞定了。' } }),
  L({ timestamp: '2026-04-08T06:24:34.500Z', type: 'event_msg', payload: {
    type: 'token_count', info: {
      total_token_usage: { input_tokens: 9246, cached_input_tokens: 7552, output_tokens: 291 },
      last_token_usage: { input_tokens: 9246, cached_input_tokens: 7552, output_tokens: 291 } } } }),
  L({ timestamp: '2026-04-08T06:25:00.000Z', type: 'event_msg', payload: {
    type: 'turn_aborted', turn_id: 't2', reason: 'interrupted' } }),
  L({ timestamp: '2026-04-08T06:26:00.000Z', type: 'compacted', payload: {
    message: '', replacement_history: [] } }),
];

const id = 'rollout-2026-04-08T14-24-27-019d6bc3-7f32-7f83-8dfc-26c1cbc5c797';
let fp;
test.before(() => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'chv-codex-'));
  fp = path.join(dir, id + '.jsonl');
  fs.writeFileSync(fp, lines.join('\n') + '\n');
});

test('codexProject 与前端 encCwd 同款编码', () => {
  assert.equal(codexProject('/root/codexDir/chuyu'), '-root-codexDir-chuyu');
  assert.equal(codexProject(''), 'codex');
});

test('parseCodexSession 基本解析', () => {
  const s = parseCodexSession(id, fp);
  assert.equal(s.src, 'codex');
  assert.equal(s.project, '-root-codexDir-chuyu');
  assert.equal(s.cwd, '/root/codexDir/chuyu');
  assert.equal(s.gitBranch, 'main');
  assert.equal(s.firstPrompt, '测试一下');
  assert.equal(s.firstTs, '2026-04-08T06:24:27.500Z');

  // developer 与 <environment_context> 包裹都标记为 meta
  const metas = s.messages.filter((m) => m.isMeta);
  assert.equal(metas.length, 2);

  const kinds = s.messages.filter((m) => !m.isMeta)
    .map((m) => m.blocks.map((b) => b.kind).join(','));
  assert.deepEqual(kinds, ['text', 'thinking', 'tool_use', 'tool_result',
    'tool_use', 'tool_result', 'text', 'compact', 'compact']);

  // exec_command 的 arguments 解析成对象
  const tu = s.messages.find((m) => m.blocks[0].kind === 'tool_use');
  assert.equal(tu.blocks[0].name, 'exec_command');
  assert.equal(tu.blocks[0].input.cmd, 'pwd');
  // custom_tool_call 的 input 保持字符串（apply_patch 补丁）
  const patch = s.messages.filter((m) => m.blocks[0].kind === 'tool_use')[1];
  assert.equal(patch.blocks[0].name, 'apply_patch');
  assert.match(patch.blocks[0].input, /Add File/);
  // 包了一层 JSON 的 custom_tool_call_output 解出内层 output
  const results = s.messages.filter((m) => m.blocks[0].kind === 'tool_result');
  assert.match(results[0].blocks[0].text, /exited with code 0/);
  assert.equal(results[0].blocks[0].isError, false);
  assert.equal(results[1].blocks[0].text, 'Success.');

  // token 用量：in 拆掉缓存读
  assert.equal(s.usage.in, 9246 - 7552);
  assert.equal(s.usage.cr, 7552);
  assert.equal(s.usage.out, 291);
  assert.equal(s.usage.msgs, 1);
  const day = s.usageByDay['2026-04-08'];
  assert.ok(day && day['gpt-5.4'] && day['gpt-5.4'].out === 291);
});
