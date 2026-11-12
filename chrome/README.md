# chrome — per-session browser control

Every harness **session** gets its own browser session: its own Playwright MCP
server, its own tab in your everyday Chrome, and its own tab group in the tab
strip. Nothing is shared between sessions, and no session can take over a tab
you opened.

```
session A → its own MCP server → its own extension connection → its own group → its own tab
session B → its own MCP server → its own extension connection → its own group → its own tab
```

## How it reaches your browser

Through **Playwright's own Chrome extension**, so Chrome stays a stock browser:
no debugging port, no relocated profile, no second window.

1. Install the [Playwright Extension](https://chromewebstore.google.com/detail/playwright-extension/mmlmfjhmonkocbjadbfplnigmagldckm)
   in the Chrome you use.
2. Put the pairing token in `~/.dsh/.env`:

   ```bash
   PLAYWRIGHT_MCP_EXTENSION_TOKEN=<the token the extension shows>
   ```

3. Install this plugin into the profile:

   ```bash
   python3 ../install/install.py chrome
   ```

   and restart `dsh web`.

The extension names the tab group **`Playwright · <session name>`** — the name
the model gives the session with `browser_name_session`. It is the highlight you
see in the tab strip.

## The tools

Playwright's 24 tools, registered in the agent's own scope, so a session only
ever sees its own:

`browser_navigate`, `browser_snapshot`, `browser_click`, `browser_type`,
`browser_fill_form`, `browser_take_screenshot`, `browser_evaluate`,
`browser_tabs`, `browser_console_messages`, `browser_network_request(s)`,
`browser_drag`, `browser_drop`, `browser_file_upload`, `browser_handle_dialog`,
`browser_hover`, `browser_press_key`, `browser_resize`, `browser_find`,
`browser_select_option`, `browser_wait_for`, `browser_navigate_back`,
`browser_close`, `browser_run_code_unsafe`.

Plus two of the plugin's own:

| Tool | What it does |
|---|---|
| `browser_name_session` | names the session — the name the tab group carries, e.g. `🌐 Google 30s` |
| `browser_mark_tab` | marks the tab `deliverable` or `handoff` so it survives the turn |

## Rules the session enforces

- **Its own tab.** The session opens a tab and selects it; `browser_tabs`
  with `action: "select"` is refused, so a tab you opened is never taken over.
- **Navigation allowlist.** Only the origins in `allowedOrigins` (the bundle's
  `cordis.patch.yml`, the same list the ChatGPT browser extension enforces for
  this user). A refusal names the allowed origins.
- **Cleanup at the end of the turn.** The tab closes when the turn ends — unless
  it is marked `deliverable` (a result you want open) or `handoff` (work
  continues there later). The tab is identified by its URL and closed by index:
  the plugin never closes a page it does not own.

## Configuration

The bundle's row (`cordis.patch.yml`) carries the settings:

| Key | Default | Meaning |
|---|---|---|
| `serverDir` | `~/.local/share/dsh-playwright-mcp` | where the MCP server is installed |
| `serverCommand` / `serverArgs` | `node …/cli.js --extension …` | how the MCP server is started |
| `serverName` | `playwright` | the namespace of the tool names (`mcp__playwright__…`) |
| `allowedOrigins` | the extension's list | the origins the agent may open |
| `toolCallTimeoutMs` | `120000` | timeout of one tool call |

The MCP server itself is installed without the npm registry (the corporate proxy
blocks it): `install-playwright-mcp.sh` fetches the published wrapper from
`cdn.jsdelivr.net` and links the `playwright-core` that ships with the Codex
runtime.

## Tests

```bash
node test-all.mjs          # every check
node --test "test/*.test.mjs"
```

| File | Covers |
|---|---|
| `test/mcp-client.test.mjs` | the MCP stdio client: handshake, tool list, tool call, protocol error, timeout, shutdown |
| `test/bridge.test.mjs` | the tool definition: naming, schemas, the canonical value, rendering, image projection |
| `test/session.test.mjs` | the session: its own tab, the allowlist, refusing to take over your tab, naming, marks, turn-end cleanup |
| `test/plugin.test.mjs` | the plugin: a session per agent, teardown on dispose |
| `test/registry.test.mjs` | the bridge against the **real** tool registry — the contract the harness enforces |

`registry.test.mjs` is the one that matters most: it mounts the harness's own
`dsh-tools` registry and executor and runs the definition through them. It
caught a bug the unit tests could not: the projector has to be **synchronous**
(the harness calls it without awaiting), and an `async` projector hands it a
`Promise`, which fails the durable result's lossless-JSON check.

## Files

| File | What it is |
|---|---|
| `index.js` | the host half: a session per agent |
| `lib/session.js` | one agent's browser session and its rules |
| `lib/mcp-client.js` | a dependency-free MCP client over stdio |
| `lib/bridge.js` | MCP tool → harness tool definition |
| `install-playwright-mcp.sh` | installs `@playwright/mcp` without the npm registry |
| `launch-chrome.sh` | opens your Chrome (the extension does the rest) |
| `seed-profile.sh` | copies a Chrome profile into the agent's own directory |
