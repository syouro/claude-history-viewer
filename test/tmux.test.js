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

test('paneState：codex 编号菜单（› 光标 + Press enter 提示）→ menu 且 enter 标记', () => {
  // 2026-08-20 实测 codex v0.147 启动时的更新提示（按数字只移动光标，回车才确认）
  const screen = [
    '  ✨ Update available! 0.147.0 -> 0.148.0',
    '  Release notes: https://github.com/openai/codex/releases/latest',
    '› 1. Update now (runs `npm install -g @openai/codex`)',
    '  2. Skip',
    '  3. Skip until next version',
    '  Press enter to continue',
  ].join('\n');
  const st = paneState(screen);
  assert.equal(st.kind, 'menu');
  assert.equal(st.enter, true); // 前端点按钮要补一个回车
  assert.deepEqual(st.options.map((o) => o.n), [1, 2, 3]);
  assert.equal(st.options[0].sel, true);
  assert.match(st.options[0].label, /Update now/);
});

test('paneState：codex 菜单的同行右列描述与换行续行 → 拆进 desc', () => {
  // 2026-08-20 实测 codex 限额提醒菜单：描述在同行右侧对齐，长了换行成无序号续行
  const screen = [
    '  Approaching rate limits',
    '  Switch to gpt-5.6-luna for lower credit usage?',
    '› 1. Switch to gpt-5.6-luna                 Fast and affordable agentic coding',
    '                                            model.',
    '  2. Keep current model',
    '  3. Keep current model (never show again)  Hide future rate limit reminders',
    '  Press enter to confirm or esc to go back',
  ].join('\n');
  const st = paneState(screen);
  assert.equal(st.kind, 'menu');
  assert.equal(st.enter, true);
  assert.equal(st.question, 'Switch to gpt-5.6-luna for lower credit usage?');
  assert.equal(st.options[0].label, 'Switch to gpt-5.6-luna'); // 右列不混进 label
  assert.equal(st.options[0].desc, 'Fast and affordable agentic coding model.'); // 续行拼回
  assert.equal(st.options[1].desc, undefined);
  assert.equal(st.options[2].desc, 'Hide future rate limit reminders');
});

test('paneState：AskUserQuestion 带选项描述与分隔线 → menu（描述归属上方选项）', () => {
  // 2026-08-20 实测：编号行之间夹描述行，末项被分隔线隔开，旧的连续块扫描认不出
  const screen = [
    ' ☐ Color',
    'Which color do you prefer?',
    '❯ 1. Red',
    '     A warm, bold color.',
    '  2. Green',
    '     A natural, calm color.',
    '  3. Blue',
    '     A cool, serene color.',
    '  4. Type something.',
    '────────────────────────────────────────',
    '  5. Chat about this',
    'Enter to select · ↑/↓ to navigate · Esc to cancel',
  ].join('\n');
  const st = paneState(screen);
  assert.equal(st.kind, 'menu');
  assert.equal(st.enter, undefined); // Claude 按数字直接生效，不能补回车
  assert.equal(st.question, 'Which color do you prefer?');
  assert.deepEqual(st.options.map((o) => o.n), [1, 2, 3, 4, 5]);
  assert.equal(st.options[0].sel, true);
  assert.equal(st.options[0].desc, 'A warm, bold color.');
  assert.equal(st.options[3].desc, undefined);
  assert.equal(st.options[4].label, 'Chat about this');
});

test('paneState：agy 编号审批菜单（裸 > 光标）→ menu（按数字直接生效，无 enter 标记）', () => {
  // 2026-08-20 实测 Antigravity CLI v1.1.15 的命令审批（实测按数字直接提交）
  const screen = [
    '● Bash(touch /tmp/t.txt) (ctrl+o to expand)',
    'Command',
    '────────────────────────────────────────────',
    'Requesting permission for:',
    '   touch /tmp/t.txt',
    'Do you want to proceed?',
    '> 1. Yes',
    "  2. Yes, and always allow in this conversation for commands that start with 'touch'",
    "  3. Yes, and always allow for commands that start with 'touch' (Persist to settings.json)",
    '  4. No',
    '  ↑/↓ Navigate · tab Amend · ctrl+g edit/expand command',
    'esc to cancel                                    Gemini 3.7 Flash · high',
  ].join('\n');
  const st = paneState(screen);
  assert.equal(st.kind, 'menu');
  assert.equal(st.enter, undefined);
  assert.equal(st.nav, undefined); // 编号菜单优先，不走 nav 路径
  assert.equal(st.question, 'Do you want to proceed?');
  assert.deepEqual(st.options.map((o) => o.n), [1, 2, 3, 4]);
  assert.equal(st.options[0].sel, true);
});

test('paneState：agy 无编号信任对话框 → nav 菜单（↑/↓ + 回车选）', () => {
  // 2026-08-20 实测：无编号、裸 > 光标，按数字无效，只能方向键移动后回车
  const screen = [
    'Accessing workspace:',
    '/tmp/x',
    'Do you trust the contents of this project?',
    'Antigravity CLI requires permission to read, edit, and execute files here.',
    '> Yes, I trust this folder',
    '  No, exit',
    '',
    '  ↑/↓ Navigate · enter Confirm',
    '                                                 Gemini 3.7 Flash · high',
  ].join('\n');
  const st = paneState(screen);
  assert.equal(st.kind, 'menu');
  assert.equal(st.nav, true);
  assert.deepEqual(st.options.map((o) => o.i), [0, 1]);
  assert.equal(st.options[0].label, 'Yes, I trust this folder');
  assert.equal(st.options[0].sel, true);
  assert.equal(st.options[1].label, 'No, exit');
});

test('paneState：agy 模型选择器（选项 + 滑杆装饰行）→ nav 菜单，装饰行不混进选项', () => {
  // 2026-08-20 实测 /model：选项与提示行之间夹 Effort 滑杆和深缩进说明
  const screen = [
    '────────────────────────────────────────────',
    'Switch Model',
    '',
    '> Gemini 3.7 Flash             (current)',
    '  Gemini 3.6 Flash',
    '  Gemini 3.5 Flash',
    '  Gemini 3.1 Pro',
    '  Claude Sonnet 4.6 (Thinking)',
    '  Claude Opus 4.6 (Thinking)',
    '  GPT-OSS 120B (Medium)',
    '',
    '  Effort  ◂        ●━━━━━━━━━━━━━━●━━━━━━━━━━━━━━◉        ▸',
    '                  low          medium          high',
    '            Deepest reasoning for complex problems — slower but strongest',
    '',
    'Keyboard: ↑/↓ Navigate  ←/→ Effort  enter Select  esc Go Back',
    '                                                 Gemini 3.7 Flash · high',
  ].join('\n');
  const st = paneState(screen);
  assert.equal(st.kind, 'menu');
  assert.equal(st.nav, true);
  assert.equal(st.question, 'Switch Model');
  assert.equal(st.options.length, 7); // 滑杆 / 说明行被排除
  assert.equal(st.options[0].label, 'Gemini 3.7 Flash');
  assert.equal(st.options[0].desc, '(current)'); // 右列备注拆进 desc
  assert.equal(st.options[0].sel, true);
  assert.equal(st.options[5].label, 'Claude Opus 4.6 (Thinking)');
});

test('paneState：agy 干活中（盲文转轮 + 输入框还在）→ busy 而不是 idle', () => {
  // 2026-08-20 实测：agy 生成时输入框仍显示，不能被 > 提示符骗成 idle
  const screen = [
    '> Run this exact bash command: touch /tmp/t.txt',
    '⣯  Generating...',
    '└ Tip: Use /diff to view uncommitted changes in your workspace.',
    '────────────────────────────────────────────',
    '>',
    '────────────────────────────────────────────',
    'esc to cancel                                    Gemini 3.7 Flash · high',
  ].join('\n');
  const st = paneState(screen);
  assert.equal(st.kind, 'busy');
});

test('paneState：markdown 引用块里的有序列表（每行都带 >）不算菜单', () => {
  const screen = [
    '● 原文引用：',
    '  > 1. 先备份',
    '  > 2. 再删除',
    '  > 3. 最后验证',
    '────────────────────────────────────────────',
    '❯ ',
    '────────────────────────────────────────────',
  ].join('\n');
  const st = paneState(screen);
  assert.equal(st.kind, 'idle'); // 光标行不唯一 → 不是菜单
});

test('paneState：codex 的 › 输入提示符 → idle', () => {
  const screen = [
    '  Tip: Switch models or reasoning effort quickly with /model.',
    '› Explain this codebase',
    '  gpt-5.6-sol xhigh · Context 100% left · /tmp/x',
  ].join('\n');
  const st = paneState(screen);
  assert.equal(st.kind, 'idle');
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
