'use strict';
// tmux 桥接的纯函数用例：stripAnsi 与 paneState（终端画面 → 交互状态）
const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const os = require('os');

// 隔离真实数据（require server.js 时会读扫描根配置）
process.env.CLAUDE_PROJECTS_DIR = os.tmpdir();
process.env.CONFIG_PATH = path.join(os.tmpdir(), 'chv-tmux-no-config.json');
process.env.INDEX_PATH = path.join(os.tmpdir(), 'chv-tmux-index.json');
process.env.INDEX_BLOBS_PATH = path.join(os.tmpdir(), 'chv-tmux-blobs.json');

const { stripAnsi, paneState } = require('../server.js');
const ESC = String.fromCharCode(27);

test('stripAnsi 去掉 SGR / 光标控制 / OSC', () => {
  assert.equal(stripAnsi(ESC + '[31mred' + ESC + '[0m'), 'red');
  assert.equal(stripAnsi(ESC + '[2K' + ESC + '[1Ghi'), 'hi');
  assert.equal(stripAnsi(ESC + ']0;title' + String.fromCharCode(7) + 'body'), 'body');
  assert.equal(stripAnsi('plain'), 'plain');
});

test('paneState：权限确认菜单 → menu（问题 + 选项 + 光标位）', () => {
  const screen = [
    '╭──────────────────────────────╮',
    '│ Bash command                 │',
    '│                              │',
    '│   rm -rf node_modules        │',
    '│   Remove node modules        │',
    '│                              │',
    '│ Do you want to proceed?      │',
    '│ ❯ 1. Yes                     │',
    '│   2. Yes, and don\'t ask again│',
    '│   3. No, and tell Claude     │',
    '╰──────────────────────────────╯',
    '',
  ].join('\n');
  const st = paneState(screen);
  assert.equal(st.kind, 'menu');
  assert.equal(st.question, 'Do you want to proceed?');
  assert.equal(st.options.length, 3);
  assert.deepEqual(st.options.map((o) => o.n), [1, 2, 3]);
  assert.equal(st.options[0].sel, true);
  assert.equal(st.options[2].sel, false);
  assert.match(st.options[1].label, /don't ask again/);
});

test('paneState：带 ANSI 着色与括号提示行的菜单也能识别', () => {
  const screen = [
    ' Do you want to make this edit to app.js?',
    ' ' + ESC + '[36m❯ 1. Yes' + ESC + '[0m',
    '   2. Yes, allow all edits during this session',
    '   3. No, and tell Claude what to do differently (esc)',
    ' (Use arrow keys)',
    '',
  ].join('\n');
  const st = paneState(screen);
  assert.equal(st.kind, 'menu');
  assert.equal(st.options.length, 3);
  assert.match(st.question, /make this edit/);
});

test('paneState：正文里的有序列表（无 ❯ 光标）不算菜单', () => {
  const screen = [
    '接下来分三步：',
    '1. 读文件',
    '2. 改代码',
    '3. 跑测试',
    '',
    '╭──────────────╮',
    '│ >            │',
    '╰──────────────╯',
  ].join('\n');
  const st = paneState(screen);
  assert.equal(st.kind, 'idle');
});

test('paneState：选项块下方还有提示行 / 状态栏（真实权限确认形态）→ menu', () => {
  const screen = [
    '❯ 请用 Bash 运行 touch /tmp/t.txt',
    '',
    '  Creating empty test file in /tmp',
    '  ⎿  $ touch /tmp/t.txt',
    '',
    '────────────────────────────────────',
    ' Bash command',
    '',
    '   touch /tmp/t.txt',
    '',
    ' Do you want to proceed?',
    ' ❯ 1. Yes',
    '   2. Yes, and always allow access to tmp/ from this project',
    '   3. No',
    '',
    ' Esc to cancel · Tab to amend · ctrl+e to explain',
  ].join('\n');
  const st = paneState(screen);
  assert.equal(st.kind, 'menu');
  assert.equal(st.question, 'Do you want to proceed?');
  assert.deepEqual(st.options.map((o) => o.n), [1, 2, 3]);
  assert.equal(st.options[0].sel, true);
});

test('paneState：❯ 提示符 + 横线分隔的输入区（真实 TUI 形态）→ idle', () => {
  const screen = [
    '                                    ● high · /effort',
    '────────────────────────────────────────────',
    '❯ Try "refactor <filepath>"',
    '────────────────────────────────────────────',
    '  [root@host dir] [Ctx 0%] Fable 5',
    '  ⏸ manual mode on · ← for agents',
  ].join('\n');
  const st = paneState(screen);
  assert.equal(st.kind, 'idle');
  assert.equal(st.mode, 'manual mode'); // 状态栏里的权限模式要带出来
});

test('paneState：accept edits 状态栏 → mode', () => {
  const screen = [
    '────────────────────────────────',
    '❯ ',
    '────────────────────────────────',
    '  ⏵⏵ accept edits on (shift+tab to cycle)',
  ].join('\n');
  const st = paneState(screen);
  assert.equal(st.kind, 'idle');
  assert.equal(st.mode, 'accept edits');
});

test('paneState：esc to interrupt → busy', () => {
  const st = paneState('✻ Deliberating… (esc to interrupt · 32s)\n');
  assert.equal(st.kind, 'busy');
});

test('paneState：普通 shell 输出 → unknown', () => {
  const st = paneState('$ ls\nfoo bar baz\n$ ');
  assert.equal(st.kind, 'unknown');
});
