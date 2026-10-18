// 全链路: 临时 profile 的无头 Chrome 里加载真扩展, 真连接器 (MCP stdio), 走一遍
// 配对 → 操作页面 → 全部 API 开放 → 省略 tabId / 上传 → 暂停 → 操作日志.
// 端口用 9420 起的一段, 不会和日常在用的 Chrome Bridge (9333 起) 互相看见.
// 运行: node test/extension.test.mjs   (需要 Chrome 126+; 找不到时跳过; CHROME_PATH 可指定)
import { spawn, execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

const root = new URL('..', import.meta.url).pathname;
const results = [];
const check = (name, ok, extra = '') => { results.push(ok); console.log(ok ? 'PASS' : 'FAIL', name, typeof extra === 'string' ? extra.slice(0, 300) : JSON.stringify(extra).slice(0, 300)); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const TEST_PORT = 9420;

const CHROME = process.env.CHROME_PATH || ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/usr/bin/google-chrome', '/usr/bin/chromium'].find((p) => fs.existsSync(p));
if (!CHROME) {
  console.log('SKIP 未找到 Chrome');
  process.exit(0);
}

// 扩展拷到临时目录, 端口改成测试段
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cb-ext-'));
const extDir = path.join(tmp, 'extension');
fs.cpSync(root + 'extension', extDir, { recursive: true });
const bg = path.join(extDir, 'background.js');
fs.writeFileSync(bg, fs.readFileSync(bg, 'utf8').replace('const BASE_PORT = 9333;', `const BASE_PORT = ${TEST_PORT};`));

// 测试网页
const server = http.createServer((q, s) => {
  s.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'set-cookie': 'sid=secret123; Path=/' });
  s.end(`<!doctype html><title>扩展测试</title><button id="b" onclick="this.textContent='已点'">点我</button><input id="i" placeholder="搜索">`);
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const pageUrl = `http://127.0.0.1:${server.address().port}/`;

// ---------- 连接器 (MCP stdio) ----------
const conn = spawn('node', [root + 'connector/index.js'], { stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, CHROME_BRIDGE_PORT: String(TEST_PORT) } });
let cbuf = '', cid = 1;
const creplies = new Map();
conn.stdout.on('data', (d) => { cbuf += d; let i; while ((i = cbuf.indexOf('\n')) >= 0) { const l = cbuf.slice(0, i); cbuf = cbuf.slice(i + 1); try { const m = JSON.parse(l); creplies.get(m.id)?.(m); } catch {} } });
conn.stderr.on('data', (d) => process.env.DEBUG && process.stderr.write(d));
const rpc = (method, params) => new Promise((res) => { const i = cid++; creplies.set(i, res); conn.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: i, method, params }) + '\n'); });
await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'ext-test', version: '1' } });
conn.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
const tool = async (name, args = {}) => {
  const r = await rpc('tools/call', { name, arguments: args });
  const c = r.result?.content?.[0] || {};
  return { err: !!r.result?.isError, text: c.text || '', type: c.type, mime: c.mimeType, data: c.data };
};
const json = (r) => { try { return JSON.parse(r.text); } catch { return null; } };

// ---------- Chrome (CDP over pipe) ----------
const profile = path.join(tmp, 'profile');
const chrome = spawn(CHROME, ['--headless=new', '--remote-debugging-pipe', '--enable-unsafe-extension-debugging', `--user-data-dir=${profile}`, '--no-first-run', '--no-default-browser-check', 'about:blank'], { stdio: ['ignore', 'ignore', 'ignore', 'pipe', 'pipe'] });
let pbuf = '', pid = 0;
const preplies = new Map();
chrome.stdio[4].on('data', (d) => { pbuf += d; let i; while ((i = pbuf.indexOf('\0')) >= 0) { const m = JSON.parse(pbuf.slice(0, i)); pbuf = pbuf.slice(i + 1); preplies.get(m.id)?.(m); } });
const browser = (method, params = {}, sessionId) => new Promise((res, rej) => { const i = ++pid; preplies.set(i, (m) => (m.error ? rej(new Error(m.error.message)) : res(m.result))); chrome.stdio[3].write(JSON.stringify({ id: i, method, params, ...(sessionId ? { sessionId } : {}) }) + '\0'); });

let extId;
try {
  extId = (await browser('Extensions.loadUnpacked', { path: extDir })).id;
  check('扩展加载', !!extId, extId);

  // 弹窗页: 用来配对和改设置 (模拟用户)
  const { targetId } = await browser('Target.createTarget', { url: `chrome-extension://${extId}/popup.html` });
  const { sessionId: popup } = await browser('Target.attachToTarget', { targetId, flatten: true });
  const inPopup = async (expr) => {
    const r = await browser('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true }, popup);
    if (r.exceptionDetails) throw new Error('弹窗里执行出错: ' + (r.exceptionDetails.exception?.description || r.exceptionDetails.text));
    return r.result.value;
  };
  const settings = (patch) => inPopup(`chrome.runtime.sendMessage({ type: 'settings', patch: ${JSON.stringify(patch)} })`);

  // 1. 配对
  let r;
  for (let i = 0; i < 20; i++) { r = await tool('chrome_tabs'); if (/配对码/.test(r.text)) break; await sleep(500); }
  const code = r.text.match(/配对码 ([0-9A-Z]{4}-[0-9A-Z]{4})/)?.[1];
  check('未配对时返回配对码', r.err && !!code, code);
  await sleep(1200); // 等弹窗刷新出待配对卡片
  await inPopup(`(() => { const i = document.getElementById('code'); i.value = ${JSON.stringify(code)}; i.dispatchEvent(new Event('input')); })()`);
  let paired = false;
  for (let i = 0; i < 30 && !paired; i++) { await sleep(300); paired = !(await tool('chrome_tabs')).err; }
  check('在弹窗输入配对码后可用', paired, await inPopup(`(async () => document.getElementById('pairMsg').textContent + ' | ' + document.getElementById('state').textContent + ' | ' + JSON.stringify((await chrome.runtime.sendMessage({ type: 'status' })).pending))()`));

  // 2. 操作页面
  const tab = json(await tool('chrome_new_tab', { url: 'about:blank', active: false }));
  const nav = json(await tool('chrome_navigate', { tabId: tab.tabId, url: pageUrl, waitFor: 'complete' }));
  check('导航', nav?.达到 === 'complete', nav);
  const snap = json(await tool('chrome_snapshot', { tabId: tab.tabId }));
  check('快照经扩展返回', /\[1\] button "点我"/.test(snap?.elements || ''), snap?.elements);
  await tool('chrome_click', { tabId: tab.tabId, ref: 1 });
  await tool('chrome_type', { tabId: tab.tabId, selector: '#i', text: 'hello' });
  const st = await tool('chrome_eval', { tabId: tab.tabId, expression: `document.getElementById('b').textContent + '/' + document.getElementById('i').value` });
  check('点击与输入生效', st.text === '已点/hello', st.text);
  const shot = await tool('chrome_screenshot', { tabId: tab.tabId });
  check('截图默认 JPEG', shot.type === 'image' && shot.mime === 'image/jpeg');
  const net = json(await tool('chrome_network', { tabId: tab.tabId, urlPattern: '127.0.0.1' }));
  const doc = net?.请求?.find((x) => x.type === 'Document');
  const body = json(await tool('chrome_network', { tabId: tab.tabId, requestId: doc?.requestId, body: true }));
  check('读响应体', /点我/.test(body?.body || ''), body);

  r = await tool('chrome_eval', { tabId: tab.tabId, expression: 'await new Promise((r) => setTimeout(r, 50)); 6 * 7' });
  check('chrome_eval 支持顶层 await', r.text === '42', r.text);
  const bgTab = json(await tool('chrome_new_tab', { url: pageUrl, active: false }));
  await sleep(800);
  const vis = await tool('chrome_eval', { tabId: bgTab.tabId, expression: 'document.visibilityState' });
  check('后台标签开在独立窗口里, 页面处于可见状态', vis.text === 'visible', vis.text);
  await tool('chrome_click', { tabId: bgTab.tabId, selector: '#b' });
  const bgClicked = await tool('chrome_eval', { tabId: bgTab.tabId, expression: `document.getElementById('b').textContent` });
  check('后台标签里点击生效', bgClicked.text === '已点', bgClicked.text);
  const bgWin = json(await tool('chrome_api', { path: 'tabs.get', args: [bgTab.tabId] }))?.windowId;
  // 用户窗口 = 弹窗页 (模拟用户打开的标签) 所在的窗口
  const userWin = (json(await tool('chrome_tabs')) || []).find((t) => String(t.url).startsWith('chrome-extension://'))?.windowId;
  const bgWinInfo = json(await tool('chrome_api', { path: 'windows.get', args: [bgWin] }));
  check('后台标签开在独立、不抢焦点的窗口里', bgWin && userWin && bgWin !== userWin && bgWinInfo?.focused === false, `${bgWin} vs ${userWin}, focused=${bgWinInfo?.focused}`);
  await tool('chrome_close_tab', { tabId: bgTab.tabId });
  await tool('chrome_eval', { tabId: tab.tabId, expression: '1' }); // 当前标签切回主测试标签

  // 3. 全部开放
  r = await tool('chrome_api', { path: 'cookies.getAll', args: [{ domain: '127.0.0.1' }] });
  check('cookies.getAll 直接可用', !r.err && /secret123/.test(r.text), r.text);
  r = await tool('chrome_cdp', { tabId: tab.tabId, method: 'Network.getAllCookies' });
  check('CDP 读 cookie 直接可用', !r.err && /secret123/.test(r.text));
  r = await tool('chrome_api', { path: 'history.search', args: [{ text: '', maxResults: 5 }] });
  check('历史记录可读', !r.err, r.text);

  // 4. 省略 tabId: 默认用当前标签
  r = await tool('chrome_eval', { expression: 'document.title' });
  check('省略 tabId 作用于当前标签', r.text === '扩展测试', r.text);
  const q = json(await tool('chrome_snapshot', { query: '搜索' }));
  check('快照按文字筛选', q?.count === 1 && /textbox "搜索"/.test(q.elements), q);
  await tool('chrome_eval', { expression: `document.body.insertAdjacentHTML('beforeend', '<input type=file id=f>')` });
  const upFile = path.join(tmp, 'hello.txt');
  fs.writeFileSync(upFile, 'hi');
  r = await tool('chrome_upload', { selector: '#f', files: [upFile] });
  const upName = await tool('chrome_eval', { expression: `document.getElementById('f').files[0]?.name` });
  check('上传文件', !r.err && upName.text === 'hello.txt', r.text + ' ' + upName.text);
  await tool('chrome_close_tab', {});
  const nav2 = json(await tool('chrome_navigate', { url: pageUrl, active: false }));
  check('关掉当前标签后, 导航自动新开标签', !!nav2?.tabId && nav2.tabId !== tab.tabId, nav2);
  tab.tabId = nav2.tabId;

  // 6. 暂停
  await settings({ paused: true });
  r = await tool('chrome_tabs');
  check('暂停后所有操作被拒', r.err && /暂停/.test(r.text), r.text);
  await settings({ paused: false });
  check('恢复后可用', !(await tool('chrome_tabs')).err);

  // 7. 操作日志
  const log = await inPopup(`chrome.runtime.sendMessage({ type: 'activity', limit: 100 })`);
  check('操作日志记录了操作与暂停期间被拒的命令', log.some((x) => x.outcome === 'paused') && log.some((x) => x.outcome === 'ok' && /cookies\.getAll/.test(x.what)), log.slice(0, 3));

  await tool('chrome_close_tab', { tabId: tab.tabId });
} catch (e) {
  check('未预期的异常', false, e.stack);
} finally {
  conn.stdin.end();
  chrome.kill();
  server.close();
  await sleep(500);
  fs.rmSync(tmp, { recursive: true, force: true });
  if (process.platform === 'darwin') {
    const acct = createHash('sha256').update(`path:${root}test/extension.test.mjs`).digest('hex').slice(0, 32);
    try { execFileSync('security', ['delete-generic-password', '-s', 'chrome-bridge', '-a', acct], { stdio: 'ignore' }); } catch {}
  }
}

const passed = results.filter(Boolean).length;
console.log(`\n${passed}/${results.length} passed`);
process.exit(passed === results.length ? 0 : 1);
