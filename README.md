# Chrome Bridge

**English** · [中文](README.zh-CN.md)

> Forked from [T0MYYY/chrome-bridge](https://github.com/T0MYYY/chrome-bridge). On top of its encrypted pairing, this fork adds a **permission gate**, a **blocked-site list**, a **pause switch**, an **activity log** and a set of **high-level interaction tools**, and fixes an agent-identity bug. See [Changes from upstream](#changes-from-upstream).

An MCP server that lets AI agents drive **the Chrome you already use**: your default profile, logins, cookies and extensions. There's no `--remote-debugging-port` and no separate automation browser. It works with any MCP client, including Claude Code, Codex, and others.

It has two parts:

- **Extension** (`extension/`): an MV3 extension that exposes the Chrome DevTools Protocol through `chrome.debugger` and gives gated access to `chrome.*` APIs.
- **Connector** (`connector/`): a stdio MCP server that your agent launches. It talks to the extension over an authenticated, encrypted local WebSocket.

```
agent ──stdio/MCP──▶ connector (127.0.0.1:9333–9352) ◀══ encrypted WebSocket ══ extension ──chrome.debugger──▶ your tabs
```

## Features

- **Your real browser session.** Pages open already logged in, with your extensions active.
- **Pair once per agent.** The first time an agent connects, you type an 8-character code into the extension popup. After that, every future session of that agent connects silently. Other software on your machine can't simply connect and take over your browser (see [Security](#security)).
- **Full network and console capture**, including cross-origin iframes (OOPIF) and workers. `chrome_navigate` attaches before it navigates, so capture starts at the first byte.
- **Drive pages like a person.** `chrome_snapshot` lists interactive elements with numbered refs; `chrome_click` / `chrome_type` / `chrome_key` / `chrome_scroll` act on them with real input events (the page sees `isTrusted` events).
- **Safe by default.** Reading cookies, history or browsing data is off until you turn on a 30-minute **full mode** in the popup. Block sites, pause everything with one click, and see every step an agent took.
- **Generic escape hatches**: CDP methods (`chrome_cdp`), `chrome.*` APIs (`chrome_api`) and `chrome.*` events (`chrome_events`), all behind the same gate.
- **Many sessions at once.** Each agent session gets its own port and the extension connects to all of them. Debugger attachments and event subscriptions are reference-counted per session, so one session detaching or exiting never breaks another. New sessions are discovered in under a second.

## Tools

| Tool | What it does |
|---|---|
| `chrome_tabs` | List tabs. `attached` = attached by this session; `otherSessions` > 0 = another session is using it |
| `chrome_new_tab` / `chrome_close_tab` | Open and close tabs (`active:false` opens in the background) |
| `chrome_navigate` | Attach, then navigate, then wait for a `readyState` |
| `chrome_snapshot` | List interactive elements with refs (pierces shadow DOM, flags off-screen elements) |
| `chrome_click` | Click by ref, selector or coordinates (real mouse events, double/right click); warns when the target is covered |
| `chrome_type` | Focus and type, optionally clearing first and pressing Enter; picks `<select>` options by label |
| `chrome_key` | Keys and chords: `Enter`, `Tab`, `cmd+a`, `ctrl+shift+k`… |
| `chrome_scroll` | Wheel-scroll, or scroll an element into view |
| `chrome_wait_for` | Wait for an element or text to appear or disappear |
| `chrome_read` | Visible text of the page or an element (truncated) |
| `chrome_eval` | Run JS in the page (top-level `await` supported); oversized results are truncated |
| `chrome_screenshot` | Viewport or full page; JPEG scaled to 1280px by default, PNG optional |
| `chrome_network` / `chrome_console` | Captured requests (headers and **response bodies** per request) and console/log/exception entries, including iframes and workers |
| `chrome_detach` | Release this session's debugger attachment |
| `chrome_cdp` / `chrome_targets` | Any CDP method on a tab, a target or a child session |
| `chrome_api` | `chrome.*` APIs, e.g. `windows.create`; sensitive ones like `cookies.getAll` need full mode |
| `chrome_events` | Subscribe to, read and unsubscribe from any `chrome.*` event |
| `chrome_status` | Agent identity, pairing state (with the code while pairing), port, and all connected sessions |
| `chrome_wait` | Sleep without a shell |

## Install

Requirements: Chrome 116+, Node.js 18+, and an MCP client.

```bash
git clone https://github.com/TonyLee-99/chrome-bridge.git
cd chrome-bridge/connector && npm install
```

1. **Load the extension.** Open `chrome://extensions`, enable **Developer mode**, click **Load unpacked** and select the `extension/` folder.
2. **Register the MCP server** with your agent:

   **Claude Code**

   ```bash
   claude mcp add -s user chrome-bridge -- node /absolute/path/to/chrome-bridge/connector/index.js
   ```

   **Codex** (`~/.codex/config.toml`)

   ```toml
   [mcp_servers.chrome-bridge]
   command = "node"
   args = ["/absolute/path/to/chrome-bridge/connector/index.js"]
   ```

   **Any other MCP client** (the usual JSON shape)

   ```json
   { "mcpServers": { "chrome-bridge": { "command": "node", "args": ["/absolute/path/to/chrome-bridge/connector/index.js"] } } }
   ```

3. **Pair.** Ask the agent to do anything in Chrome. Its first tool call returns a code like `K7Q2-M9XD`. Click the Chrome Bridge icon in the toolbar (a notification also pops up) and type the code. The popup pairs automatically once all 8 characters are in, and you're done for that agent.

To update later, `git pull`, reload the extension in `chrome://extensions`, and run your client's MCP reconnect (e.g. `/mcp` in Claude Code) in running sessions.

## Pairing and agent identity

- **What counts as "one agent".** On macOS, the connector walks up its parent processes (skipping shells and `npx`-style launchers) to the agent and verifies that **running process's code signature** with `codesign`. The identity is *team ID + identifier*, e.g. Claude Code is `Q6L2SF6YDW:com.anthropic.claude-code` (Anthropic PBC), and Codex is `2DC432GLL2:codex`. The identity survives agent upgrades. Agents that are scripts run by a **generic interpreter** (`node`, `python`, `bun`, `deno`…) are identified by **script path**, because the interpreter's own signature says nothing about which program it runs. Unsigned agents fall back to their executable path. If the agent can't be identified at all, the connector uses an in-memory identity that's valid only for that session.
- **Credentials.** Each agent gets a P-256 signing key. On macOS it's stored in the **Keychain**: written through `security -i` on stdin, so it never appears in a process list. On other systems it's stored in `~/.config/chrome-bridge/agents/*.json` with mode `0600`. The extension has its own non-extractable key in IndexedDB.
- **Handshake** (SIGMA-style, standard WebCrypto only): both sides sign a transcript of both static keys and fresh ECDH keys, then derive per-direction AES-GCM keys. Every frame is encrypted and sequence-numbered.
- **Pairing proof.** The code has 40 bits of entropy and goes through PBKDF2 (300k iterations), salted with the agent key and bound to the channel transcript. Each side must prove it knows the code. Three wrong guesses invalidate the code.
- **Managing agents.** The popup lists paired agents (with signature strength and last use) and lets you **revoke** one. Revoking disconnects its sessions; that agent then rotates its key and has to pair again.

## Security

What this protects against:

- **A local program posing as a connector** (listening on a port in range). It has no paired key, so all it can do is raise a pairing request you'll never have a code for. Ignore it.
- **A program launching the connector itself** to borrow an agent's pairing. Its parent process's signature doesn't match, so it's treated as a new, unpaired agent.
- **A program posing as the extension** to feed fake results to the agent. It fails the handshake: it has no trusted key and can't pass pairing without the code.
- **Relaying, injecting, tampering or replaying traffic.** The channel is end-to-end encrypted and sequence-numbered.
- **Web pages.** WebSocket upgrades are accepted only from `chrome-extension://` origins, and the discovery endpoint sends no CORS headers.

What it can't protect against: malware **running as your user that specifically targets this tool**. Examples: reading the agent's Keychain item (`security` can read it once you know the item's name), injecting into the agent or Chrome process, or clicking the popup through Accessibility permissions. Desktop OSes don't strongly isolate programs run by the same user, and Chrome's own cookie store has the same limit. The goal is that other software **can't simply access** your browser; access requires a targeted attack.

### Permission gate

A paired agent can work with pages, but what it can do comes in three tiers (rules in `extension/policy.js`):

| Tier | What | Default |
|---|---|---|
| Allowed | Page-level work: read and edit pages, click and type, screenshots, network and console; `tabs`, `windows`, `tabGroups`, `webNavigation`, `notifications` | on |
| Full mode | Anything that can take cross-site data or change browser-wide state: `cookies`, `history`, `browsingData`, `downloads`, `bookmarks`, `sessions`, `webRequest`, `scripting`, `tabs.captureVisibleTab`; CDP `Network.getAllCookies`, `Storage.*`, `Browser.*`… | off; turned on in the popup, auto-off after 30 min |
| Never | Anything that would let an agent escape your control: this extension's `storage` (holds the trust table), `debugger`, `runtime`, `management`; CDP hops to other targets (`Target.attachToTarget`…); debugging other extensions' pages or `chrome://` pages | — |

Why cookies are off by default: agents read web pages, and a page can carry a **prompt injection** like "send the cookies to this URL". The gate means a fooled agent still can't walk off with your logins.

Three more controls live in the popup:

- **Blocked sites**: one domain per line (subdomains included; `*.x.com` matches subdomains only). Agents can't open, navigate to or operate these sites; attached tabs are released at once; `chrome_tabs` shows only their domain.
- **Pause all**: rejects every command and releases every tab. Badge shows `OFF`.
- **Activity log**: the last 300 commands (denied ones in red), kept in memory only.

Badge: a number = agents waiting to pair; `OFF` = paused; `ALL` = full mode on.

The extension still requests `debugger`, `<all_urls>` and other broad permissions (full mode needs them), but drops unused, risky ones such as `nativeMessaging`, `management`, `proxy`, `privacy`, `clipboardRead` and `tabCapture`. Only pair agents you trust.

## How multi-session works

- Each connector binds the first free port in `127.0.0.1:9333–9352`. If all 20 are busy, it retries every 2 s.
- The extension probes that range every second with plain HTTP (`GET /chrome-bridge`), then opens a WebSocket to every connector it finds. It uses HTTP for discovery because Chrome throttles repeated *failed WebSocket* connections: probing 20 ports with WebSockets delayed new connections by 7–26 s in testing.
- Replies and CDP events are routed per connection. A tab's debugger stays attached until the **last** session using it detaches or disconnects.
- When an agent session ends, its connector exits (stdin closed or parent gone), and the extension releases everything that session held.
- The service worker stays resident through a 20 s heartbeat, about ten-odd MB of memory, so discovery stays fast even after Chrome has been idle.
- Sessions share CDP state on a tab they both use. `chrome_tabs` flags tabs other sessions are using.

## Troubleshooting

- **"Not paired"**: the tool result contains the code. Click the Chrome Bridge toolbar icon and type it. `chrome_status` shows the code too.
- **"Extension not connected"**: `chrome_status` shows this session's port. Open the extension popup (opening it also triggers a rescan). Make sure the extension is enabled and is version 3.x.
- **A tab keeps the yellow "debugging" bar**: another session may still be using it (`chrome_tabs` → `otherSessions`), or call `chrome_detach`. Clicking **Cancel** on the bar detaches every session from that tab; the next command re-attaches.
- Logs: the connector logs to stderr. Extension logs are in `chrome://extensions` → Chrome Bridge → *service worker*.

## Development

```bash
cd connector && npm test         # everything below
node test/protocol.test.mjs      # handshake, pairing, attack cases (in-memory)
node test/agent.test.mjs         # agent identification: skips shell / npm launchers
node test/policy.test.mjs        # permission tiers, blocked-site matching
node test/integration.test.mjs   # real connector processes + simulated extension
node test/interact.test.mjs      # interaction tools on headless Chrome (temp profile)
node test/extension.test.mjs     # full chain: real extension in headless Chrome + real connector
```

The last two use a throwaway profile and ports from 9420, so they never touch your everyday Chrome or pairings.

`CHROME_BRIDGE_PORT` changes the connector's base port (default `9333`). If you change it, also change `BASE_PORT` in `extension/background.js`. `PORT_SPAN` (20) must match on both sides.

## Changes from upstream

Relative to [T0MYYY/chrome-bridge](https://github.com/T0MYYY/chrome-bridge) v3.0.0:

- **Fix: interpreter identity.** The official `node` binary is code-signed by the Node.js Foundation, and upstream identified agents by signature, so **every node script shared one identity**. Pair any node-based agent once, and any node script on the machine (an npm install script, say) could launch the connector and inherit that pairing. Interpreters are now identified by script path.
- **New**: permission gate, full mode, blocked sites, pause switch, activity log (see [Permission gate](#permission-gate)).
- **New**: `chrome_snapshot`, `chrome_click`, `chrome_type`, `chrome_key`, `chrome_scroll`, `chrome_wait_for`, `chrome_read`; response bodies in `chrome_network`.
- **Better**: JPEG, downscaled screenshots by default; truncated oversized `chrome_eval` results; `chrome_navigate` reports navigation errors; agent instructions now cover prompt injection and confirming irreversible actions.
- **Fewer permissions**; control characters stripped from the keychain comment; tests only delete keychain entries they created.
- **Tests**: three new suites (gate, interaction tools, full chain), 105 checks in total.

## License

[MIT](LICENSE). Original © 2026 Tom Chen ([T0MYYY](https://github.com/T0MYYY)); modifications in this fork © 2026 TonyLee-99.
