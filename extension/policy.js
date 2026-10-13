// 权限闸门: 哪些 chrome.* API 与 CDP 方法可以直接用, 哪些要用户在弹窗里开「完全模式」,
// 哪些无论如何都不给. 纯函数, 不碰 chrome.*, 测试直接 import.
//
// 思路: 页面级能力 (读写页面、点击输入、看网络) 是这个工具的本职, 直接放行;
// 能拿走跨站数据或改浏览器全局状态的 (cookie、历史、浏览数据、全部请求拦截) 默认关闭,
// 防止 agent 被网页内容里的提示词注入骗去外传. 能让 agent 脱离用户控制的 (改本扩展的存储,
// 嵌套调试其他扩展) 一律拒绝.

// 标准模式下可直接调用的 chrome.* 命名空间. 书签、最近关闭 (sessions) 会泄露浏览记录;
// scripting 能往任意标签 (包括黑名单站点) 注入代码, 而 chrome_eval 已覆盖它的用途: 都放到完全模式
const API_OK = new Set(['tabs', 'windows', 'tabGroups', 'webNavigation', 'notifications']);
// 永远拒绝: 本扩展的信任表与配置在 storage 里; debugger/runtime 能绕过本闸门
const API_NEVER = new Set(['storage', 'debugger', 'runtime', 'management', 'permissions', 'action', 'alarms', 'offscreen', 'extension']);

// CDP: 按方法名分类. 页面级的绝大多数方法放行, 下列需要完全模式
const CDP_SENSITIVE = [
  /^Network\.(getAllCookies|getCookies|setCookies?|deleteCookies|clearBrowserCookies|clearBrowserCache)$/,
  /^Storage\./,
  /^Browser\./,
  /^SystemInfo\./,
  /^Security\.setIgnoreCertificateErrors$/,
  /^Page\.setDownloadBehavior$/,
  /^Target\.(createBrowserContext|disposeBrowserContext|getBrowserContexts|exposeDevToolsProtocol|setDiscoverTargets|setRemoteLocations)$/,
];
// 拿到别的 target 的控制权: 只允许本标签的子会话 (setAutoAttach 自动附加的那些)
const CDP_NEVER = [/^Target\.(attachToTarget|attachToBrowserTarget|createTarget|closeTarget|activateTarget|sendMessageToTarget)$/];

/** @returns {'ok' | 'sensitive' | 'never'} */
export function classifyApi(path) {
  const p = String(path || '');
  const ns = p.split('.')[0];
  if (API_NEVER.has(ns)) return 'never';
  // 截当前可见标签: 截到的可能是黑名单站点, 而它不经过按标签的检查
  if (p === 'tabs.captureVisibleTab') return 'sensitive';
  if (API_OK.has(ns)) return 'ok';
  return 'sensitive';
}

/** @returns {'ok' | 'sensitive' | 'never'} */
export function classifyCdp(method) {
  const m = String(method || '');
  if (CDP_NEVER.some((re) => re.test(m))) return 'never';
  if (CDP_SENSITIVE.some((re) => re.test(m))) return 'sensitive';
  return 'ok';
}

// 黑名单条目: "bank.com" 匹配 bank.com 及其子域; "*.bank.com" 只匹配子域; 支持写完整 URL
export function normalizeSitePattern(s) {
  let v = String(s || '').trim().toLowerCase();
  if (!v || v.startsWith('#')) return null;
  v = v.replace(/^[a-z][a-z0-9+.-]*:\/\//, '').replace(/[/?#].*$/, '').replace(/:\d+$/, '');
  return /^(\*\.)?[a-z0-9.-]+$/.test(v) ? v : null;
}

export function hostOf(url) {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return '';
  }
}

export function siteBlocked(url, patterns) {
  const host = hostOf(url);
  if (!host) return null;
  for (const raw of patterns || []) {
    const p = normalizeSitePattern(raw);
    if (!p) continue;
    if (p.startsWith('*.')) {
      if (host.endsWith(p.slice(1))) return p;
    } else if (host === p || host.endsWith('.' + p)) return p;
  }
  return null;
}

// 不属于本扩展的特权页面: 别的扩展 (密码管理器等) 与浏览器自身页面
export function privilegedUrl(url, ownExtensionId) {
  const u = String(url || '');
  if (u.startsWith('chrome-extension://')) return !u.startsWith(`chrome-extension://${ownExtensionId}/`);
  return /^(chrome|chrome-untrusted|devtools|edge|brave):/.test(u);
}

// 从命令参数里找出这次要去的 URL (导航类命令), 用来在跳转前就挡住黑名单站点
export function navigationTargets(method, p = {}) {
  const list = (v) => (v === undefined || v === null ? [] : Array.isArray(v) ? v : [v]);
  if (method === 'tabs.create') return list(p.url);
  if (method === 'cdp.send' && p.cdpMethod === 'Page.navigate') return list(p.cdpParams?.url);
  if (method === 'api.call') {
    const a = p.args || [];
    if (p.path === 'tabs.create' || p.path === 'windows.create') return list(a[0]?.url);
    if (p.path === 'tabs.update') return list((a[0] !== null && typeof a[0] === 'object' ? a[0] : a[1])?.url);
  }
  return [];
}

// 给操作日志用的一行摘要, 不含参数里的长文本
export function summarize(method, p) {
  const cut = (s, n = 80) => (s && String(s).length > n ? String(s).slice(0, n) + '…' : s);
  switch (method) {
    case 'cdp.send':
      return p.cdpMethod === 'Runtime.evaluate' ? `执行 JS: ${cut(p.cdpParams?.expression, 60)}` : p.cdpMethod;
    case 'api.call':
      return `chrome.${p.path}`;
    case 'tabs.create':
      return `新标签 ${cut(p.url) || ''}`;
    case 'tabs.close':
      return `关闭标签 ${p.tabId}`;
    case 'events.subscribe':
      return `订阅 ${p.path}`;
    default:
      return method;
  }
}

export const FULL_MODE_MINUTES = 30;
