// 交互工具 (connector/interact.js) 端到端: 在临时 profile 里起一个无头 Chrome,
// 直连它的 CDP 代替扩展, 跑快照、点击、输入、下拉、按键、滚动、等待、读正文、截图.
// 运行: node test/interact.test.mjs   (找不到 Chrome 时跳过; 可用 CHROME_PATH 指定)
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { createInteract, parseKey, screenshotParams } from '../connector/interact.js';

const require = createRequire(new URL('../connector/', import.meta.url));
const WebSocket = require('ws');
const results = [];
const check = (name, ok, extra = '') => { results.push(ok); console.log(ok ? 'PASS' : 'FAIL', name, typeof extra === 'string' ? extra : JSON.stringify(extra)); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 纯函数部分不需要浏览器
check('parseKey 回车带 \\r', parseKey('Enter').text === '\r');
check('parseKey cmd+a 带 selectAll 命令且不产生字符', parseKey('cmd+a').commands?.[0] === 'selectAll' && parseKey('cmd+a').modifiers === 4 && !parseKey('cmd+a').text);
check('parseKey shift+a 产生大写', parseKey('shift+a').text === 'A');
check('parseKey 拒绝未知键', (() => { try { parseKey('hyper+q'); return false; } catch { return true; } })());

const CHROME = process.env.CHROME_PATH || ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/usr/bin/google-chrome', '/usr/bin/chromium'].find((p) => fs.existsSync(p));
if (!CHROME) {
  console.log('SKIP 未找到 Chrome, 跳过浏览器部分');
  finish();
}

const PAGE = `<!doctype html><html><head><title>测试页</title></head><body style="height:4000px">
<h1>交互测试</h1>
<form id="f"><label for="name">姓名</label><input id="name" value="旧值"><button type="submit">提交</button></form>
<button id="inc" aria-label="加一">+</button><span id="count">0</span>
<select id="fruit"><option value="a">苹果</option><option value="b">香蕉</option></select>
<button id="hidden" style="display:none">看不见</button>
<div id="later"></div>
<p id="art">第一段正文。</p>
<button id="far" style="position:absolute;top:3500px">底部按钮</button>
<script>
  window.log = [];
  let n = 0;
  inc.addEventListener('click', (e) => { n++; count.textContent = n; log.push('click:' + e.isTrusted); });
  f.addEventListener('submit', (e) => { e.preventDefault(); log.push('submit:' + document.getElementById('name').value); });
  document.getElementById('name').addEventListener('input', (e) => log.push('input:' + e.isTrusted));
  fruit.addEventListener('change', () => log.push('change:' + fruit.value));
  setTimeout(() => { later.textContent = '延迟出现的文字'; }, 600);
</script></body></html>`;

const server = http.createServer((q, s) => { s.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); s.end(PAGE); });
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const url = `http://127.0.0.1:${server.address().port}/`;

const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'cb-test-'));
const chrome = spawn(CHROME, ['--headless=new', '--remote-debugging-port=0', `--user-data-dir=${profile}`, '--no-first-run', '--no-default-browser-check', '--window-size=1200,800', 'about:blank'], { stdio: 'ignore' });

let port;
for (let i = 0; i < 100 && !port; i++) {
  await sleep(100);
  try { port = fs.readFileSync(path.join(profile, 'DevToolsActivePort'), 'utf8').split('\n')[0]; } catch {}
}
const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
const ws = new WebSocket(targets.find((t) => t.type === 'page').webSocketDebuggerUrl);
await new Promise((r) => ws.on('open', r));
let id = 0;
const waiting = new Map();
ws.on('message', (d) => { const m = JSON.parse(d); waiting.get(m.id)?.(m); });
// 模拟扩展的 cdp(tabId, method, params): tabId 只有一个, 直接忽略
const cdp = (_tab, method, params = {}) => new Promise((res, rej) => { const i = ++id; waiting.set(i, (m) => (m.error ? rej(new Error(m.error.message)) : res(m.result))); ws.send(JSON.stringify({ id: i, method, params })); });
const evalJs = async (e) => (await cdp(1, 'Runtime.evaluate', { expression: e, returnByValue: true })).result.value;

const T = createInteract(cdp);
const tabId = 1;

try {
  await cdp(1, 'Page.navigate', { url });
  for (let i = 0; i < 50 && (await evalJs('document.readyState')) !== 'complete'; i++) await sleep(100);

  const snap = await T.chrome_snapshot({ tabId });
  const refOf = (re) => Number(snap.elements.split('\n').find((l) => l.startsWith('[') && re.test(l))?.match(/^\[(\d+)\]/)?.[1]);
  check('快照: 标题与上下文', snap.title === '测试页' && /heading "交互测试"/.test(snap.elements));
  check('快照: 按 aria-label / label 命名', /button "加一"/.test(snap.elements) && /textbox "姓名" 值="旧值"/.test(snap.elements), snap.elements);
  check('快照: 不列隐藏元素', !/看不见/.test(snap.elements));
  check('快照: 下拉框显示已选项而不是全部选项', /combobox 已选="苹果"/.test(snap.elements));
  check('快照: 标出视口外元素', /底部按钮" \(视口外\)/.test(snap.elements));

  await T.chrome_click({ tabId, ref: refOf(/"加一"/) });
  await T.chrome_click({ tabId, selector: '#inc', double: true });
  check('点击: 真实事件 (isTrusted) 且双击算两次', (await evalJs('count.textContent')) === '3' && (await evalJs('log.every(x => !x.startsWith("click") || x === "click:true")')));

  await T.chrome_type({ tabId, ref: refOf(/"姓名"/), text: '张三', clear: true, submit: true });
  const log = await evalJs('log');
  check('输入: 清空后替换, 触发可信 input 事件', log.includes('input:true') && (await evalJs('document.getElementById("name").value')) === '张三', log);
  check('输入: submit 按回车提交表单', log.includes('submit:张三'));

  const sel = await T.chrome_type({ tabId, selector: '#fruit', text: '香蕉' });
  check('下拉框按文字选中', sel.已选择 === '香蕉' && (await evalJs('log')).includes('change:b'));
  const bad = await T.chrome_type({ tabId, selector: '#fruit', text: '榴莲' }).catch((e) => e.message);
  check('下拉框没有该项时列出可选项', /苹果 \/ 香蕉/.test(bad), bad);

  const gone = await T.chrome_click({ tabId, ref: 999 }).catch((e) => e.message);
  check('失效的 ref 给出明确提示', /重新 chrome_snapshot/.test(gone));

  const w = await T.chrome_wait_for({ tabId, text: '延迟出现的文字', timeoutMs: 5000 });
  check('等待文字出现', w.met === true, w);
  const w2 = await T.chrome_wait_for({ tabId, selector: '#nope', timeoutMs: 600 });
  check('等不到时返回超时而不是报错', w2.met === false && w2.超时);

  const s1 = await T.chrome_scroll({ tabId, dy: 800 });
  check('滚轮滚动', s1.to > s1.from, s1);
  const s2 = await T.chrome_scroll({ tabId, selector: '#far' });
  check('滚到元素', s2.scrollY > 2500, s2);

  const r = await T.chrome_read({ tabId, maxChars: 20 });
  check('读正文并截断', r.truncated && r.text.length === 20 && r.title === '测试页');
  const r2 = await T.chrome_read({ tabId, selector: '#art' });
  check('读指定元素', r2.text === '第一段正文。');

  await evalJs('document.getElementById("name").focus()');
  await T.chrome_key({ tabId, key: 'Backspace', repeat: 2 });
  check('按键: 退格两次', (await evalJs('document.getElementById("name").value')) === '', await evalJs('document.getElementById("name").value'));

  const sp = await screenshotParams(cdp, tabId, { maxWidth: 600 });
  const shot = await cdp(tabId, 'Page.captureScreenshot', sp);
  const jpeg = Buffer.from(shot.data, 'base64');
  check('截图: JPEG 且按 maxWidth 缩小', jpeg[0] === 0xff && jpeg[1] === 0xd8 && sp.clip.scale === 0.5, `${jpeg.length} bytes, scale ${sp.clip.scale}`);
} catch (e) {
  check('未预期的异常', false, e.stack);
} finally {
  ws.close();
  chrome.kill();
  server.close();
  await sleep(300);
  fs.rmSync(profile, { recursive: true, force: true });
}
finish();

function finish() {
  const passed = results.filter(Boolean).length;
  console.log(`\n${passed}/${results.length} passed`);
  process.exit(passed === results.length ? 0 : 1);
}
