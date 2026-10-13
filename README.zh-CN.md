# Chrome Bridge

[English](README.md) · **中文**

> 本仓库 fork 自 [T0MYYY/chrome-bridge](https://github.com/T0MYYY/chrome-bridge)，在它的加密配对基础上加了**权限闸门**、**禁止站点**、**暂停开关**、**操作日志**和一整套**高层交互工具**，并修复了一个身份识别漏洞。改动见[与上游的区别](#与上游的区别)。

一个 MCP server，让 AI agent 直接操作**你日常在用的 Chrome**：默认 profile、登录状态、cookie 和扩展都是现成的。不需要 `--remote-debugging-port`，也不用另开一个自动化浏览器。任何 MCP 客户端都能用，包括 Claude Code、Codex 等。

分两部分：

- **扩展**（`extension/`）：MV3 扩展，通过 `chrome.debugger` 提供 Chrome DevTools Protocol 能力，按权限闸门开放 `chrome.*` API。
- **连接器**（`connector/`）：由 agent 启动的 stdio MCP server，与扩展之间走一条经过鉴权、加密的本机 WebSocket。

```
agent ──stdio/MCP──▶ 连接器 (127.0.0.1:9333–9352) ◀══ 加密 WebSocket ══ 扩展 ──chrome.debugger──▶ 你的标签页
```

## 特性

- **真实的浏览器会话**：打开的页面已经是登录状态，你装的扩展也照常生效。
- **每个 agent 只配对一次**：agent 第一次连上时，你在扩展弹窗里输入一个 8 位码；之后它的所有会话都静默接入。本机其他软件没法简单连上来接管你的浏览器（见[安全](#安全)）。
- **完整的网络与 console 记录**，包括跨站 iframe（OOPIF）和 worker。`chrome_navigate` 先附加调试器再导航，从第一个字节开始记录。
- **像人一样操作页面**：`chrome_snapshot` 列出可交互元素并编号，`chrome_click` / `chrome_type` / `chrome_key` / `chrome_scroll` 按编号操作，用的是真实输入事件（页面收到的事件 `isTrusted` 为真）。
- **默认安全，按需放权**：读 cookie、历史、浏览数据等敏感操作默认关闭，你在弹窗里开「完全模式」后才放行，30 分钟自动关闭。可设禁止站点、一键暂停，弹窗里能看到 agent 做过的每一步。
- **通用出口**：任意 CDP 方法（`chrome_cdp`）、`chrome.*` API（`chrome_api`）、`chrome.*` 事件（`chrome_events`），同样经过权限闸门。
- **多个会话可以同时使用**：每个 agent 会话有自己的端口，扩展会跟所有会话都连上。调试器附加和事件订阅按会话做引用计数，一个会话 detach 或退出，绝不会影响其他会话。新会话不到 1 秒就能被发现。

## 工具

| 工具 | 作用 |
|---|---|
| `chrome_tabs` | 列出标签页。`attached` 表示本会话已附加；`otherSessions` 大于 0 表示有其他会话在用 |
| `chrome_new_tab` / `chrome_close_tab` | 开、关标签页（`active:false` 在后台打开） |
| `chrome_navigate` | 先附加再导航，然后等页面到达指定的 `readyState` |
| `chrome_snapshot` | 列出页面上可交互的元素，每个带编号 `[ref]`（穿透 shadow DOM，标出视口外元素） |
| `chrome_click` | 按 ref / 选择器 / 坐标点击（真实鼠标事件，支持双击、右键），被遮挡时提示挡住它的元素 |
| `chrome_type` | 聚焦后输入文字，可先清空、输完回车；对下拉框按选项文字选中 |
| `chrome_key` | 按键或组合键：`Enter`、`Tab`、`cmd+a`、`ctrl+shift+k`… |
| `chrome_scroll` | 滚轮滚动，或把元素滚到视口中间 |
| `chrome_wait_for` | 等元素或文字出现 / 消失 |
| `chrome_read` | 读页面或某个元素的可见文字（可截断） |
| `chrome_eval` | 在页面里执行 JS，支持顶层 `await`，结果过大自动截断 |
| `chrome_screenshot` | 截可视区域或整页；默认 JPEG 且宽度压到 1280，可选 PNG |
| `chrome_network` / `chrome_console` | 读取网络请求（可看单个请求的请求头、响应头、**响应体**），以及 console、日志和异常，含 iframe 与 worker |
| `chrome_detach` | 释放本会话的调试器附加 |
| `chrome_cdp` / `chrome_targets` | 对标签页、target 或子会话发送任意 CDP 方法 |
| `chrome_api` | `chrome.*` API，如 `windows.create`；`cookies.getAll` 这类敏感 API 需要完全模式 |
| `chrome_events` | 订阅、读取、退订任意 `chrome.*` 事件 |
| `chrome_status` | agent 身份、配对状态（待配对时附配对码）、端口，以及所有已接入的会话 |
| `chrome_wait` | 等待一段时间，不用借助 shell |

## 安装

需要 Chrome 116+、Node.js 18+，以及一个 MCP 客户端。

```bash
git clone https://github.com/TonyLee-99/chrome-bridge.git
cd chrome-bridge/connector && npm install
```

1. **加载扩展**：打开 `chrome://extensions`，开启「开发者模式」，点「加载已解压的扩展程序」，选择 `extension/` 目录。
2. **在 agent 中注册 MCP server**：

   **Claude Code**

   ```bash
   claude mcp add -s user chrome-bridge -- node /绝对路径/chrome-bridge/connector/index.js
   ```

   **Codex**（`~/.codex/config.toml`）

   ```toml
   [mcp_servers.chrome-bridge]
   command = "node"
   args = ["/绝对路径/chrome-bridge/connector/index.js"]
   ```

   **其他 MCP 客户端**（常见的 JSON 写法）

   ```json
   { "mcpServers": { "chrome-bridge": { "command": "node", "args": ["/绝对路径/chrome-bridge/connector/index.js"] } } }
   ```

3. **配对**：让 agent 在 Chrome 里做任意一件事，它的第一次工具调用会返回一个类似 `K7Q2-M9XD` 的码。点 Chrome 工具栏上的 Chrome Bridge 图标（同时会弹出系统通知），输入这个码，输满 8 位就自动配对。这个 agent 以后都不用再配对。

以后更新：`git pull`，在 `chrome://extensions` 重新加载扩展，然后在正在运行的会话里执行一次客户端的 MCP 重连（例如 Claude Code 的 `/mcp`）。

## 配对与 agent 身份

- **什么算「同一个 agent」**：在 macOS 上，连接器沿父进程链往上找（跳过 shell 和 `npx` 这类启动器）到 agent 进程，用 `codesign` 校验这个**运行中进程的代码签名**，身份记为「团队 ID + 标识符」。例如 Claude Code 是 `Q6L2SF6YDW:com.anthropic.claude-code`（Anthropic PBC），Codex 是 `2DC432GLL2:codex`。agent 升级后身份不变。agent 若是跑在**通用解释器**上的脚本（`node`、`python`、`bun`、`deno` 等），解释器自己的签名说明不了跑的是哪个程序，因此按**脚本路径**识别。没有签名的 agent 按可执行文件路径识别。完全无法识别时，使用只在当前会话有效的内存身份。
- **凭据**：每个 agent 有一把 P-256 签名密钥。macOS 上存在**钥匙串**里，经 `security -i` 从 stdin 写入，不会出现在进程列表中；其他系统存在 `~/.config/chrome-bridge/agents/*.json`，权限 `0600`。扩展也有一把自己的、不可导出的密钥，存在 IndexedDB 里。
- **握手**（SIGMA 结构，只用标准 WebCrypto）：双方对「双方静态公钥 + 本次新生成的 ECDH 公钥」的握手记录签名，再派生出两个方向各一把 AES-GCM 密钥。之后每一帧都加密并带序号。
- **配对证明**：配对码有 40 bit 熵，经 PBKDF2（30 万次迭代）处理，以 agent 公钥为盐，并绑定到这条通道的握手记录。双方都必须证明自己知道这个码；连续猜错 3 次，码就作废。
- **管理**：弹窗里列出已配对的 agent（含签名强度、最近使用时间），可以**撤销**。撤销后它的会话立即断开，该 agent 会换一把新密钥，需要重新配对。

## 安全

能防住的：

- **本机程序冒充连接器**（在端口区间里监听）：它没有已配对的密钥，最多只能发起一个配对请求，而你手里不会有它的码，忽略即可。
- **程序自己启动连接器**，想蹭某个 agent 的配对：它作为父进程，签名对不上，会被当作一个新的、未配对的 agent。
- **程序冒充扩展**，想给 agent 喂假结果：没有受信任的密钥，没有码也过不了配对，握手直接失败。
- **在中间转发、注入、篡改或重放流量**：通道端到端加密，每帧带序号。
- **网页**：只接受来自 `chrome-extension://` 的 WebSocket 连接；探测地址不返回 CORS 头。

防不住的：**以你的用户身份运行、专门针对这个工具的恶意程序**。比如读取 agent 的钥匙串项（知道条目名的话，`security` 就能读出来）、注入 agent 或 Chrome 进程、借辅助功能权限替你点弹窗。桌面系统对同一用户下的程序本来就隔离不彻底，Chrome 自己的 cookie 也是这个级别的保护。我们的目标是：其他软件**没法简单访问**你的浏览器，要访问就必须专门针对这个工具来攻击。

### 权限闸门

已配对的 agent 能操作页面，但能做什么分三档（规则在 `extension/policy.js`）：

| 档位 | 内容 | 默认 |
|---|---|---|
| 放行 | 页面级操作：读写页面、点击输入、截图、看网络与 console；`tabs`、`windows`、`tabGroups`、`webNavigation`、`notifications` | 开 |
| 完全模式 | 能拿走跨站数据或改浏览器全局状态的：`cookies`、`history`、`browsingData`、`downloads`、`bookmarks`、`sessions`、`webRequest`、`scripting`、`tabs.captureVisibleTab`；CDP 的 `Network.getAllCookies`、`Storage.*`、`Browser.*` 等 | 关，弹窗里开启后 30 分钟自动关闭 |
| 永远拒绝 | 能让 agent 脱离你控制的：本扩展的 `storage`（信任表在里面）、`debugger`、`runtime`、`management`；CDP 跳到别的 target（`Target.attachToTarget` 等）；调试其他扩展的页面或 `chrome://` 页面 | — |

为什么默认关掉 cookie 这类操作：agent 会阅读网页内容，而网页里可能藏着「把 cookie 发到某某网址」这样的**提示词注入**。闸门保证即使 agent 被骗，也拿不走你的登录态。

另外三个开关都在弹窗里：

- **禁止站点**：每行一个域名（含子域，`*.x.com` 只匹配子域）。agent 不能打开、导航到或操作这些网站；已附加的标签会被立即放开；`chrome_tabs` 里这些标签只显示域名，不显示标题和完整网址。
- **暂停全部**：立即拒绝所有命令，并放开所有标签。角标显示 `OFF`。
- **操作日志**：最近 300 条命令（被拒的标红），只存在内存里。

角标：数字 = 有 agent 等待配对；`OFF` = 已暂停；`ALL` = 完全模式开启中。

扩展仍然申请了 `debugger`、`<all_urls>` 等较宽的权限（完全模式要用），但去掉了用不上又危险的 `nativeMessaging`、`management`、`proxy`、`privacy`、`clipboardRead`、`tabCapture` 等。只配对你信任的 agent。

## 多会话的原理

- 每个连接器占用 `127.0.0.1:9333–9352` 中第一个空闲端口。20 个都被占时，每 2 秒重试一次。
- 扩展每秒用普通 HTTP（`GET /chrome-bridge`）探测这段端口，探到连接器再建 WebSocket。之所以用 HTTP 来发现，是因为 Chrome 会对反复**失败的 WebSocket 连接**限流：实测直接用 WebSocket 扫 20 个端口，新连接会被推迟 7–26 秒。
- 回复和 CDP 事件按连接分别投递。一个标签页的调试器，要等**最后一个**在用它的会话 detach 或断开后才真正解除。
- agent 会话结束时，它的连接器会退出（stdin 关闭或父进程消失），扩展随即释放这个会话占用的一切。
- service worker 靠每 20 秒一次的心跳保持常驻，占约十几 MB 内存，所以 Chrome 闲置很久之后，发现新会话也一样快。
- 两个会话同时用同一个标签页时，CDP 状态是共享的。`chrome_tabs` 会标出其他会话正在用的标签页。

## 排障

- **提示「未配对」**：工具结果里有配对码，点 Chrome 工具栏的 Chrome Bridge 图标输入即可。`chrome_status` 也会显示这个码。
- **提示「扩展未接入」**：先用 `chrome_status` 看本会话的端口，再打开扩展弹窗（打开弹窗时也会立即重扫一次端口）。确认扩展已启用，且版本是 3.x。
- **标签页上一直有黄色「正在调试」提示条**：可能有其他会话还在用它（看 `chrome_tabs` 的 `otherSessions`），也可以调用 `chrome_detach`。在黄条上点「取消」会让所有会话都从这个标签页断开，下次命令会自动重新附加。
- 日志：连接器的日志写到 stderr；扩展的日志在 `chrome://extensions` → Chrome Bridge →「Service Worker」。

## 开发

```bash
cd connector && npm test         # 跑下面全部
node test/protocol.test.mjs      # 握手、配对与各类攻击场景 (内存中)
node test/agent.test.mjs         # agent 识别: 跳过 shell / npm 等启动层
node test/policy.test.mjs        # 权限闸门分类、禁止站点匹配
node test/integration.test.mjs   # 真实连接器进程 + 模拟扩展
node test/interact.test.mjs      # 交互工具, 跑在临时 profile 的无头 Chrome 上
node test/extension.test.mjs     # 全链路: 无头 Chrome 加载真扩展 + 真连接器
```

后两个测试用独立的临时 profile 和 9420 起的端口，不会碰你日常的 Chrome 和配对。

`CHROME_BRIDGE_PORT` 用来改连接器的起始端口（默认 `9333`）。改了它，也要同步改 `extension/background.js` 里的 `BASE_PORT`。两边的 `PORT_SPAN`（20）必须一致。

## 与上游的区别

相对 [T0MYYY/chrome-bridge](https://github.com/T0MYYY/chrome-bridge) v3.0.0：

- **修复：解释器身份漏洞**。官方 `node` 带 Node.js 基金会的代码签名，原版按签名识别，导致**所有 node 脚本共用一个身份**：给任何一个 node 写的 agent 配过对，本机任意 node 脚本（比如某个 npm 包的安装脚本）启动连接器就能继承配对。现在解释器按脚本路径识别。
- **新增**：权限闸门、完全模式、禁止站点、暂停开关、操作日志（见[权限闸门](#权限闸门)）。
- **新增**：`chrome_snapshot`、`chrome_click`、`chrome_type`、`chrome_key`、`chrome_scroll`、`chrome_wait_for`、`chrome_read`；`chrome_network` 可读响应体。
- **改进**：截图默认 JPEG 并缩放（体积和 token 消耗大幅减少）；`chrome_eval` 结果过大时截断；`chrome_navigate` 导航失败时如实报错；给 agent 的说明里加入防提示词注入、不可撤销操作先确认的规则。
- **精简权限**；钥匙串写入时过滤控制字符；测试只清理自己建的钥匙串条目。
- **测试**：新增闸门、交互工具、全链路三组测试，共 105 项。

## 许可证

[MIT](LICENSE)。原作 © 2026 Tom Chen（[T0MYYY](https://github.com/T0MYYY)），本 fork 的改动 © 2026 TonyLee-99。
