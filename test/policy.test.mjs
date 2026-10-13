// 权限闸门 (extension/policy.js) 的分类与匹配规则. 运行: node test/policy.test.mjs
import * as Policy from '../extension/policy.js';

const results = [];
const check = (name, ok, extra = '') => { results.push(ok); console.log(ok ? 'PASS' : 'FAIL', name, extra); };

// chrome.* API
check('标签与窗口直接放行', ['tabs.query', 'windows.create', 'tabGroups.group', 'webNavigation.getAllFrames'].every((p) => Policy.classifyApi(p) === 'ok'));
check('cookie / 历史 / 浏览数据需要完全模式', ['cookies.getAll', 'history.search', 'browsingData.remove', 'downloads.download', 'bookmarks.getTree'].every((p) => Policy.classifyApi(p) === 'sensitive'));
check('截当前可见标签需要完全模式', Policy.classifyApi('tabs.captureVisibleTab') === 'sensitive');
check('未知命名空间默认敏感', Policy.classifyApi('somethingNew.call') === 'sensitive');
check('扩展自己的存储与调试器永远拒绝', ['storage.local.set', 'storage.local.get', 'debugger.attach', 'runtime.reload', 'management.setEnabled'].every((p) => Policy.classifyApi(p) === 'never'));

// CDP
check('页面级 CDP 放行', ['Runtime.evaluate', 'Input.dispatchMouseEvent', 'Page.navigate', 'Network.getResponseBody', 'DOM.getDocument'].every((m) => Policy.classifyCdp(m) === 'ok'));
check('读写 cookie 的 CDP 需要完全模式', ['Network.getAllCookies', 'Network.getCookies', 'Network.setCookie', 'Storage.getCookies', 'Browser.grantPermissions'].every((m) => Policy.classifyCdp(m) === 'sensitive'));
check('跳到别的 target 永远拒绝', ['Target.attachToTarget', 'Target.createTarget', 'Target.attachToBrowserTarget'].every((m) => Policy.classifyCdp(m) === 'never'));
check('setAutoAttach 仍可用 (子框架靠它)', Policy.classifyCdp('Target.setAutoAttach') === 'ok');

// 禁止站点
const list = ['chase.com', '*.bank.com', 'https://www.paypal.com/signin', '# 注释', ''];
check('域名匹配自身与子域', !!Policy.siteBlocked('https://chase.com/', list) && !!Policy.siteBlocked('https://secure.chase.com/x', list));
check('不误伤相似域名', !Policy.siteBlocked('https://notchase.com/', list) && !Policy.siteBlocked('https://chase.com.evil.io/', list));
check('*. 只匹配子域', !!Policy.siteBlocked('https://my.bank.com/', list) && !Policy.siteBlocked('https://bank.com/', list));
check('完整 URL 写法被规范化', Policy.normalizeSitePattern('https://www.paypal.com/signin') === 'www.paypal.com');
check('非法条目被丢弃', Policy.normalizeSitePattern('# 注释') === null && Policy.normalizeSitePattern('a b') === null);
check('无效 URL 不算命中', Policy.siteBlocked('not a url', list) === null);

// 特权页面
check('其他扩展页面是特权页', Policy.privilegedUrl('chrome-extension://abc/vault.html', 'self'));
check('本扩展页面不是特权页', !Policy.privilegedUrl('chrome-extension://self/popup.html', 'self'));
check('chrome:// 是特权页', Policy.privilegedUrl('chrome://settings/passwords', 'self'));
check('普通网页不是特权页', !Policy.privilegedUrl('https://example.com', 'self'));

// 导航目标
const nav = (m, p) => Policy.navigationTargets(m, p).join(',');
check('Page.navigate 的 URL', nav('cdp.send', { cdpMethod: 'Page.navigate', cdpParams: { url: 'https://a.com' } }) === 'https://a.com');
check('tabs.update 两种参数形式', nav('api.call', { path: 'tabs.update', args: [5, { url: 'https://b.com' }] }) === 'https://b.com' && nav('api.call', { path: 'tabs.update', args: [{ url: 'https://c.com' }] }) === 'https://c.com');
check('windows.create 的 URL 数组', nav('api.call', { path: 'windows.create', args: [{ url: ['https://d.com', 'https://e.com'] }] }) === 'https://d.com,https://e.com');
check('非导航命令没有目标', nav('cdp.send', { cdpMethod: 'Runtime.evaluate' }) === '');

const passed = results.filter(Boolean).length;
console.log(`\n${passed}/${results.length} passed`);
process.exit(passed === results.length ? 0 : 1);
