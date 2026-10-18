// 高层交互工具: 页面快照 (带 ref)、点击、输入、按键、滚动、等待、读正文、截图.
//
// 原则: 能用真实输入事件就不用 JS 模拟. 点击与按键走 CDP Input.* (页面看到的是
// isTrusted 的事件, 和用户亲手操作一样), 定位元素、取坐标才在页面里跑一小段脚本.
// 页面脚本每次现传, 不往页面全局挂东西; 快照给元素打 data-cb-ref 属性, 之后按 ref 找回.
//
// 局限: 快照只覆盖顶层文档 (含开放的 shadow root), 跨站 iframe 里的元素用
// chrome_targets + chrome_cdp 处理.

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------- 页面内脚本 ----------------
// 以字符串形式发到页面执行, 不能引用外部变量. op 决定做什么, 返回值必须可 JSON 化.

function pageScript(op, a) {
  const ATTR = 'data-cb-ref';
  const INTERACTIVE =
    'a[href],button,input,select,textarea,summary,[contenteditable=""],[contenteditable="true"],[tabindex]:not([tabindex="-1"]),' +
    '[role=button],[role=link],[role=checkbox],[role=radio],[role=switch],[role=tab],[role=menuitem],[role=menuitemcheckbox],' +
    '[role=option],[role=combobox],[role=textbox],[role=searchbox],[role=slider],[role=spinbutton],[onclick]';
  const CONTEXT = 'h1,h2,h3,h4,[role=heading],[role=dialog],[role=alert],label';

  // 深度遍历, 穿过开放的 shadow root
  function* walk(root) {
    const stack = [root];
    while (stack.length) {
      const n = stack.pop();
      if (n.nodeType === 1) yield n;
      if (n.shadowRoot) stack.push(n.shadowRoot);
      const kids = n.children || [];
      for (let i = kids.length - 1; i >= 0; i--) stack.push(kids[i]);
    }
  }
  function deepQuery(sel) {
    for (const n of walk(document)) if (n.matches?.(sel)) return n;
    return null;
  }
  function visible(el) {
    const r = el.getBoundingClientRect();
    if (r.width < 1 || r.height < 1) return false;
    const s = getComputedStyle(el);
    return s.visibility !== 'hidden' && s.display !== 'none' && Number(s.opacity) > 0.05;
  }
  const clean = (s, n = 80) => {
    const t = String(s || '').replace(/\s+/g, ' ').trim();
    return t.length > n ? t.slice(0, n) + '…' : t;
  };
  function nameOf(el) {
    const by = el.getAttribute('aria-labelledby');
    if (by) {
      const t = by.split(/\s+/).map((id) => document.getElementById(id)?.innerText || '').join(' ');
      if (t.trim()) return clean(t);
    }
    const label = el.labels?.[0]?.innerText;
    return clean(
      el.getAttribute('aria-label') || label || el.getAttribute('alt') || el.getAttribute('title') ||
        el.getAttribute('placeholder') || (/^(INPUT|SELECT|TEXTAREA)$/.test(el.tagName) ? '' : el.innerText) || el.getAttribute('name') || ''
    );
  }
  function roleOf(el) {
    const r = el.getAttribute('role');
    if (r) return r;
    const t = el.tagName.toLowerCase();
    if (t === 'a') return 'link';
    if (t === 'input') return { checkbox: 'checkbox', radio: 'radio', submit: 'button', button: 'button', range: 'slider', search: 'searchbox' }[el.type] || 'textbox';
    if (t === 'select') return 'combobox';
    if (t === 'textarea') return 'textbox';
    if (/^h[1-6]$/.test(t)) return 'heading';
    if (el.isContentEditable) return 'textbox';
    return t;
  }
  function find() {
    let el = null;
    if (a.ref !== undefined) el = deepQuery(`[${ATTR}="${String(a.ref).replace(/\D/g, '')}"]`);
    else if (a.selector) el = document.querySelector(a.selector) || deepQuery(a.selector);
    if (!el) throw new Error(a.ref !== undefined ? `找不到 ref=${a.ref} (页面可能已变化, 请重新 chrome_snapshot)` : `找不到元素: ${a.selector}`);
    return el;
  }
  // 滚到视口中间, 返回中心点坐标, 并检查那个点上是不是它 (没被弹窗、遮罩挡住)
  function locate(el) {
    el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' });
    const r = el.getBoundingClientRect();
    const x = r.left + r.width / 2;
    const y = r.top + r.height / 2;
    let top = document.elementFromPoint(x, y);
    while (top?.shadowRoot) {
      const inner = top.shadowRoot.elementFromPoint(x, y);
      if (!inner || inner === top) break;
      top = inner;
    }
    const covered = top && top !== el && !el.contains(top) && !top.contains(el) ? clean(top.outerHTML, 120) : null;
    return { x, y, covered, hidden: document.visibilityState === 'hidden', tag: el.tagName.toLowerCase(), name: nameOf(el) };
  }

  switch (op) {
    case 'snapshot': {
      let n = 0;
      for (const el of document.querySelectorAll(`[${ATTR}]`)) el.removeAttribute(ATTR);
      const lines = [];
      const vh = innerHeight;
      for (const el of walk(document)) {
        const interactive = el.matches(INTERACTIVE);
        if (!interactive && !el.matches(CONTEXT)) continue;
        if (el.disabled && !a.includeDisabled) continue;
        if (!visible(el)) continue;
        const r = el.getBoundingClientRect();
        const inView = r.bottom > 0 && r.top < vh;
        if (a.viewportOnly && !inView) continue;
        if (lines.length >= a.max) break;
        const role = roleOf(el);
        const name = nameOf(el);
        if (!interactive) {
          if (name) lines.push(`  ${role} "${name}"`);
          continue;
        }
        const ref = ++n;
        el.setAttribute(ATTR, ref);
        const bits = [`[${ref}] ${role}`];
        if (name) bits.push(`"${name}"`);
        if (el.tagName === 'SELECT') bits.push(`已选="${clean(el.selectedOptions[0]?.text, 40)}"`);
        else if ('value' in el && el.value && el.type !== 'password' && role !== 'button') bits.push(`值="${clean(el.value, 40)}"`);
        if (el.type === 'password') bits.push('(密码框)');
        if (el.checked) bits.push('(已选中)');
        if (el.getAttribute('aria-expanded')) bits.push(`(展开=${el.getAttribute('aria-expanded')})`);
        if (el.tagName === 'A') bits.push(`→ ${clean(el.getAttribute('href'), 60)}`);
        if (!inView) bits.push('(视口外)');
        lines.push(bits.join(' '));
      }
      return {
        title: document.title,
        url: location.href,
        scroll: `${Math.round(scrollY)}/${Math.max(0, document.documentElement.scrollHeight - vh)}`,
        count: n,
        truncated: lines.length >= a.max,
        elements: lines.join('\n'),
      };
    }
    case 'locate':
      return locate(find());
    case 'element':
      return find();
    case 'focus': {
      const el = find();
      el.scrollIntoView({ block: 'center', behavior: 'instant' });
      el.focus();
      if (el.tagName === 'SELECT') {
        const want = String(a.text);
        const opt = [...el.options].find((o) => o.value === want || o.text.trim() === want) ||
          [...el.options].find((o) => o.text.toLowerCase().includes(want.toLowerCase()));
        if (!opt) throw new Error(`下拉框里没有「${want}」, 可选: ${[...el.options].map((o) => o.text.trim()).join(' / ').slice(0, 300)}`);
        el.value = opt.value;
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
        return { selected: opt.text.trim() };
      }
      // clear: 选中已有内容, 接下来的 insertText 会替换掉它 (对 React 等受控组件也有效)
      if (a.clear) {
        if ('select' in el && typeof el.select === 'function') el.select();
        else if (el.isContentEditable) {
          const range = document.createRange();
          range.selectNodeContents(el);
          const sel = getSelection();
          sel.removeAllRanges();
          sel.addRange(range);
        }
      }
      const active = document.activeElement;
      return { focused: active === el || el.contains(active) || !!el.shadowRoot?.activeElement, tag: el.tagName.toLowerCase() };
    }
    case 'scrollInfo':
      return { scrollY: Math.round(scrollY), max: Math.max(0, document.documentElement.scrollHeight - innerHeight), w: innerWidth, h: innerHeight };
    case 'check': {
      let el = null;
      try {
        el = a.selector || a.ref !== undefined ? find() : null;
      } catch {}
      const hasText = a.text ? (document.body?.innerText || '').includes(a.text) : true;
      const shown = a.selector || a.ref !== undefined ? !!el && visible(el) : true;
      return { met: a.gone ? !(shown && hasText) : shown && hasText };
    }
    case 'read': {
      const root = a.selector ? find() : document.body;
      const text = (root?.innerText || '').replace(/\n{3,}/g, '\n\n').trim();
      return { title: document.title, url: location.href, length: text.length, text: text.slice(0, a.maxChars), truncated: text.length > a.maxChars };
    }
  }
  throw new Error('未知操作 ' + op);
}

// ---------------- 按键 ----------------

const KEYS = {
  enter: { key: 'Enter', code: 'Enter', keyCode: 13, text: '\r' },
  tab: { key: 'Tab', code: 'Tab', keyCode: 9 },
  escape: { key: 'Escape', code: 'Escape', keyCode: 27 },
  esc: { key: 'Escape', code: 'Escape', keyCode: 27 },
  backspace: { key: 'Backspace', code: 'Backspace', keyCode: 8 },
  delete: { key: 'Delete', code: 'Delete', keyCode: 46 },
  space: { key: ' ', code: 'Space', keyCode: 32, text: ' ' },
  arrowup: { key: 'ArrowUp', code: 'ArrowUp', keyCode: 38 },
  arrowdown: { key: 'ArrowDown', code: 'ArrowDown', keyCode: 40 },
  arrowleft: { key: 'ArrowLeft', code: 'ArrowLeft', keyCode: 37 },
  arrowright: { key: 'ArrowRight', code: 'ArrowRight', keyCode: 39 },
  up: { key: 'ArrowUp', code: 'ArrowUp', keyCode: 38 },
  down: { key: 'ArrowDown', code: 'ArrowDown', keyCode: 40 },
  left: { key: 'ArrowLeft', code: 'ArrowLeft', keyCode: 37 },
  right: { key: 'ArrowRight', code: 'ArrowRight', keyCode: 39 },
  home: { key: 'Home', code: 'Home', keyCode: 36 },
  end: { key: 'End', code: 'End', keyCode: 35 },
  pageup: { key: 'PageUp', code: 'PageUp', keyCode: 33 },
  pagedown: { key: 'PageDown', code: 'PageDown', keyCode: 34 },
};
const MODS = { alt: 1, option: 1, ctrl: 2, control: 2, cmd: 4, meta: 4, command: 4, shift: 8 };
// macOS 上 Cmd+A/C/V 等是编辑命令, 光发按键事件不会生效, 要带上 commands
const MAC_COMMANDS = { a: 'selectAll', c: 'copy', v: 'paste', x: 'cut', z: 'undo' };

export function parseKey(combo) {
  const parts = String(combo).split('+').map((s) => s.trim()).filter(Boolean);
  if (!parts.length) throw new Error('按键为空');
  let modifiers = 0;
  for (const m of parts.slice(0, -1)) {
    const bit = MODS[m.toLowerCase()];
    if (!bit) throw new Error(`不认识的修饰键: ${m} (可用 cmd / ctrl / alt / shift)`);
    modifiers |= bit;
  }
  const last = parts[parts.length - 1];
  let def = KEYS[last.toLowerCase()];
  if (!def && /^f([1-9]|1[0-2])$/i.test(last)) {
    const n = Number(last.slice(1));
    def = { key: 'F' + n, code: 'F' + n, keyCode: 111 + n };
  }
  if (!def && last.length === 1) {
    const ch = last;
    const up = ch.toUpperCase();
    const code = /[a-z]/i.test(ch) ? 'Key' + up : /\d/.test(ch) ? 'Digit' + ch : undefined;
    def = { key: modifiers & 8 ? up : ch, code, keyCode: up.charCodeAt(0), text: modifiers & 8 ? up : ch };
  }
  if (!def) throw new Error(`不认识的按键: ${last}`);
  const ev = { ...def, modifiers };
  // 带 Ctrl/Cmd/Alt 时不产生字符
  if (modifiers & 7) delete ev.text;
  if (modifiers & 4 && last.length === 1 && MAC_COMMANDS[last.toLowerCase()]) ev.commands = [MAC_COMMANDS[last.toLowerCase()]];
  return ev;
}

// ---------------- 工具 ----------------

const refProps = {
  ref: { type: 'number', description: 'chrome_snapshot 给出的元素编号 (推荐)' },
  selector: { type: 'string', description: 'CSS 选择器 (没有 ref 时使用)' },
};
const tabIdProp = { type: 'number', description: '标签页 id; 省略则用本会话上一次操作的标签' };

export const INTERACT_TOOLS = [
  {
    name: 'chrome_snapshot',
    description:
      '列出页面上可交互的元素 (按钮、链接、输入框、下拉框等), 每个带一个编号 [ref], 以及标题等上下文。' +
      '之后用 chrome_click / chrome_type 按 ref 操作。页面变化后 ref 会失效, 需要重新快照。比截图省得多, 操作页面时优先用它。',
    inputSchema: {
      type: 'object',
      properties: {
        tabId: tabIdProp,
        query: { type: 'string', description: '只列名字/文字里含这段文字的元素 (不区分大小写), 找特定按钮时用' },
        viewportOnly: { type: 'boolean', description: '只列当前视口内的元素, 默认 false' },
        max: { type: 'number', description: '最多列多少条, 默认 250' },
      },
      required: [],
    },
  },
  {
    name: 'chrome_read',
    description: '读取页面 (或某个元素) 的可见文字, 用于阅读文章、列表、搜索结果。默认最多 15000 字符。',
    inputSchema: {
      type: 'object',
      properties: { tabId: tabIdProp, selector: { type: 'string', description: '只读这个元素, 缺省整页' }, maxChars: { type: 'number' } },
      required: [],
    },
  },
  {
    name: 'chrome_click',
    description: '点击元素 (真实鼠标事件)。按 ref 或 selector 定位, 也可直接给视口坐标 x/y。元素被遮挡时会提示挡住它的是什么。',
    inputSchema: {
      type: 'object',
      properties: {
        tabId: tabIdProp,
        ...refProps,
        x: { type: 'number' },
        y: { type: 'number' },
        button: { type: 'string', enum: ['left', 'right', 'middle'], description: '默认 left' },
        double: { type: 'boolean', description: '双击' },
      },
      required: [],
    },
  },
  {
    name: 'chrome_type',
    description:
      '向输入框 / 文本域 / 可编辑区域输入文字 (先聚焦再插入, 与真人输入一致, React 等框架能正确收到)。' +
      '对 <select> 下拉框则按选项文字或值选中。clear:true 先清空原内容; submit:true 输完按回车。',
    inputSchema: {
      type: 'object',
      properties: {
        tabId: tabIdProp,
        ...refProps,
        text: { type: 'string' },
        clear: { type: 'boolean', description: '先清空, 默认 false' },
        submit: { type: 'boolean', description: '输完按回车, 默认 false' },
      },
      required: ['text'],
    },
  },
  {
    name: 'chrome_key',
    description: '按键或组合键, 作用于当前焦点。例: Enter, Tab, Escape, ArrowDown, cmd+a, ctrl+shift+k, F5。',
    inputSchema: {
      type: 'object',
      properties: { tabId: tabIdProp, key: { type: 'string' }, repeat: { type: 'number', description: '重复次数, 默认 1' } },
      required: ['key'],
    },
  },
  {
    name: 'chrome_scroll',
    description: '滚动页面 (真实滚轮事件)。给 ref/selector 则把该元素滚到视口中间; 否则按 dy (向下为正, 像素) 滚动, 可用 x/y 指定在哪个位置滚 (用于内部可滚动区域)。',
    inputSchema: {
      type: 'object',
      properties: {
        tabId: tabIdProp,
        ...refProps,
        dy: { type: 'number', description: '默认 600' },
        dx: { type: 'number' },
        x: { type: 'number' },
        y: { type: 'number' },
      },
      required: [],
    },
  },
  {
    name: 'chrome_upload',
    description: '给文件选择框 (<input type=file>) 选上本机文件, 等同于用户在弹出的文件对话框里选了它们。files 用绝对路径 (可用 ~)。',
    inputSchema: {
      type: 'object',
      properties: { tabId: tabIdProp, ...refProps, files: { type: 'array', items: { type: 'string' } } },
      required: ['files'],
    },
  },
  {
    name: 'chrome_wait_for',
    description: '等待元素出现 (selector / ref) 或页面出现某段文字; gone:true 则等它消失。默认最多等 10 秒, 返回是否等到。',
    inputSchema: {
      type: 'object',
      properties: {
        tabId: tabIdProp,
        ...refProps,
        text: { type: 'string' },
        gone: { type: 'boolean' },
        timeoutMs: { type: 'number' },
      },
      required: [],
    },
  },
];

// cdp(tabId, method, params) 由 core.js 提供
export function createInteract(cdp) {
  async function run(tabId, op, a = {}) {
    const r = await cdp(tabId, 'Runtime.evaluate', {
      expression: `(${pageScript.toString()})(${JSON.stringify(op)}, ${JSON.stringify(a)})`,
      returnByValue: true,
      awaitPromise: true,
      allowUnsafeEvalBlockedByCSP: true,
    });
    if (r?.exceptionDetails) {
      const msg = r.exceptionDetails.exception?.description || r.exceptionDetails.text || '页面脚本出错';
      throw new Error(String(msg).replace(/^Error: /, '').split('\n')[0]);
    }
    return r?.result?.value;
  }

  const mouse = (tabId, type, x, y, extra = {}) => cdp(tabId, 'Input.dispatchMouseEvent', { type, x, y, ...extra });

  async function key(tabId, ev) {
    const { text, commands, ...base } = ev;
    const down = { ...base, windowsVirtualKeyCode: base.keyCode, nativeVirtualKeyCode: base.keyCode };
    delete down.keyCode;
    await cdp(tabId, 'Input.dispatchKeyEvent', { type: text ? 'keyDown' : 'rawKeyDown', ...down, ...(text ? { text, unmodifiedText: text } : {}), ...(commands ? { commands } : {}) });
    await cdp(tabId, 'Input.dispatchKeyEvent', { type: 'keyUp', ...down });
  }

  const target = (a) => (a.ref !== undefined ? { ref: a.ref } : a.selector ? { selector: a.selector } : null);

  return {
    async chrome_snapshot(a) {
      const r = await run(a.tabId, 'snapshot', { viewportOnly: !!a.viewportOnly, max: a.query ? 5000 : Math.min(a.max || 250, 1000) });
      if (a.query) {
        const q = a.query.toLowerCase();
        const hits = r.elements.split('\n').filter((l) => l.toLowerCase().includes(q));
        r.elements = hits.length ? hits.join('\n') : `(没有含「${a.query}」的元素)`;
        r.count = hits.length;
      }
      return r;
    },

    async chrome_upload(a) {
      const t = target(a);
      if (!t) throw new Error('需要 ref 或 selector 指向 <input type=file>');
      const files = (a.files || []).map((f) => f.replace(/^~(?=\/)/, process.env.HOME || '~'));
      if (!files.length) throw new Error('files 为空');
      const r = await cdp(a.tabId, 'Runtime.evaluate', {
        expression: `(${pageScript.toString()})('element', ${JSON.stringify(t)})`,
        returnByValue: false,
        allowUnsafeEvalBlockedByCSP: true,
      });
      if (r?.exceptionDetails) throw new Error(String(r.exceptionDetails.exception?.description || r.exceptionDetails.text).split('\n')[0]);
      await cdp(a.tabId, 'DOM.setFileInputFiles', { files, objectId: r.result.objectId });
      return { uploaded: files };
    },

    async chrome_read(a) {
      return run(a.tabId, 'read', { selector: a.selector, maxChars: Math.min(a.maxChars || 15000, 200000) });
    },

    async chrome_click(a) {
      let x = a.x;
      let y = a.y;
      let info = {};
      const t = target(a);
      if (t) {
        info = await run(a.tabId, 'locate', t);
        x = info.x;
        y = info.y;
      } else if (x === undefined || y === undefined) throw new Error('需要 ref、selector 或 x/y 坐标');
      const button = a.button || 'left';
      const clicks = a.double ? 2 : 1;
      await mouse(a.tabId, 'mouseMoved', x, y);
      for (let i = 1; i <= clicks; i++) {
        await mouse(a.tabId, 'mousePressed', x, y, { button, buttons: 1, clickCount: i });
        await mouse(a.tabId, 'mouseReleased', x, y, { button, buttons: 0, clickCount: i });
      }
      const out = { clicked: info.name ? `${info.tag} "${info.name}"` : `(${Math.round(x)}, ${Math.round(y)})`, x: Math.round(x), y: Math.round(y) };
      if (info.covered) out.注意 = `该点被其他元素挡住, 点到的可能是它: ${info.covered}`;
      // 用户窗口里的后台标签: Chrome 暂停渲染, 部分网站不响应. 把它移到独立的不抢焦点窗口即可
      if (info.hidden) out.后台提示 = '该标签在后台 (页面 hidden), 点击可能无效。可用 chrome_api windows.create [{"tabId":<id>,"focused":false}] 把它移到独立窗口再操作, 或请用户切到这个标签。';
      return out;
    },

    async chrome_type(a) {
      const t = target(a);
      let r = { focused: true };
      if (t) r = await run(a.tabId, 'focus', { ...t, clear: !!a.clear, text: a.text });
      if (r.selected) return { 已选择: r.selected };
      if (!r.focused) throw new Error(`元素 (${r.tag}) 无法获得焦点, 可能不是输入框; 可先 chrome_click 它再试`);
      // 没有可替换的选区时 (例如 contenteditable 以外的自定义组件), 用全选 + 删除兜底清空
      if (a.clear && !t) {
        await key(a.tabId, parseKey(process.platform === 'darwin' ? 'cmd+a' : 'ctrl+a'));
        await key(a.tabId, parseKey('Backspace'));
      }
      if (a.text) await cdp(a.tabId, 'Input.insertText', { text: a.text });
      else if (a.clear && t) await key(a.tabId, parseKey('Backspace')); // 只清空: 删掉 focus 时选中的内容
      if (a.submit) await key(a.tabId, parseKey('Enter'));
      return { typed: a.text.length + ' 个字符', submitted: !!a.submit };
    },

    async chrome_key(a) {
      const ev = parseKey(a.key);
      const n = Math.min(Math.max(1, a.repeat || 1), 50);
      for (let i = 0; i < n; i++) await key(a.tabId, ev);
      return { pressed: a.key, times: n };
    },

    async chrome_scroll(a) {
      const t = target(a);
      if (t) {
        const info = await run(a.tabId, 'locate', t);
        return { scrolledTo: `${info.tag} "${info.name}"`, ...(await run(a.tabId, 'scrollInfo')) };
      }
      const before = await run(a.tabId, 'scrollInfo');
      const x = a.x ?? before.w / 2;
      const y = a.y ?? before.h / 2;
      await mouse(a.tabId, 'mouseWheel', x, y, { deltaX: a.dx || 0, deltaY: a.dy ?? 600 });
      await sleep(150);
      const after = await run(a.tabId, 'scrollInfo');
      return { from: before.scrollY, to: after.scrollY, max: after.max, ...(after.scrollY === before.scrollY && !a.x ? { 提示: '页面没有滚动, 可能已到底, 或可滚动的是内部区域 (传 x/y 指到那块区域上)' } : {}) };
    },

    async chrome_wait_for(a) {
      const t = target(a) || {};
      if (!t.ref && !t.selector && !a.text) throw new Error('需要 selector、ref 或 text');
      const timeout = Math.min(a.timeoutMs || 10000, 120000);
      const t0 = Date.now();
      while (Date.now() - t0 < timeout) {
        const r = await run(a.tabId, 'check', { ...t, text: a.text, gone: !!a.gone }).catch(() => ({ met: false }));
        if (r.met) return { met: true, 用时ms: Date.now() - t0 };
        await sleep(250);
      }
      return { met: false, 超时: true, 用时ms: Date.now() - t0 };
    },
  };
}

// 截图参数: 默认 JPEG 并把宽度缩到 maxWidth 以内, 一张图从几 MB 降到一两百 KB
export async function screenshotParams(cdp, tabId, { fullPage = false, format = 'jpeg', quality = 80, maxWidth = 1280 } = {}) {
  const m = await cdp(tabId, 'Page.getLayoutMetrics', {});
  const vv = m.cssVisualViewport || m.visualViewport;
  const content = m.cssContentSize || m.contentSize;
  const width = fullPage ? content.width : vv.clientWidth;
  const height = fullPage ? Math.min(content.height, 16000) : vv.clientHeight;
  const scale = maxWidth ? Math.min(1, maxWidth / width) : 1;
  const params = {
    format,
    clip: { x: fullPage ? 0 : vv.pageX, y: fullPage ? 0 : vv.pageY, width, height, scale },
    captureBeyondViewport: fullPage,
  };
  if (format === 'jpeg') params.quality = quality;
  return params;
}
