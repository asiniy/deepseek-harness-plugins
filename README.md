# deepseek-harness-plugins

Plugins for the [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) Web UI.

Each plugin is a folder in this repository and a package of its own: it is
installed into a Harness profile as a bundle, and the browser half runs inside
the Web UI. The host half of a plugin usually does nothing — the feature is
client-side — but the package still has to be there, because a package becomes
a browser module only while the Host holds a Loader entry for it.

## Plugins

| Plugin | What it does |
| --- | --- |
| [`composer-code`](composer-code) | Codex-style markdown in the composer: `inline code` becomes a chip, a ``` fence opens a grey code box. |
| [`turn-sound`](turn-sound) | A short chime when a turn needs attention: an approval, changed files, or a finished turn. |
| [`session-unread`](session-unread) | A "Mark as unread" entry in the session context menu, a dot on the session row, and the marked session floats to the top. |
| [`chrome`](chrome) | Browser control, one session at a time: every session drives its own tab in your everyday Chrome (through Playwright's Chrome extension) and gets its own tab group in the tab strip. |

## Installing a plugin

```bash
git clone git@github.com:asiniy/deepseek-harness-plugins.git
python3 deepseek-harness-plugins/install/install.py composer-code
```

The installer does what `pnpm add` would do — the npm registry is
unreachable from this machine and pnpm is not installed:

1. link the package into `<profile>/node_modules/@<scope>` (the scope is the
   package name, e.g. `@local/composer-code`),
2. record it in the profile manifest — `dependencies` **and**
   `dsh.profile.bundles`.

```jsonc
{
  "dependencies": {
    "@local/composer-code": "file:../../../path/to/deepseek-harness-plugins/composer-code"
  },
  "dsh": {
    "profile": {
      "bundles": ["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-web-app", "@local/composer-code"]
    }
  }
}
```

The Host composes the profile at boot, so restart `dsh web` afterwards. The
browser half is served from `/plugins/...` and can be reloaded without
restarting the Host when its directory is listed in the `hmr` row of the
profile patch.

`install/install.py --profile <dir>` installs into another profile.

## Tests

Every plugin in this repository has a check:

| Plugin | Check | Needs |
| --- | --- | --- |
| [`composer-code`](composer-code) | `test-scan.mjs` — which backticks pair up into a code span.<br>`test-live.mjs` — the composer of the running Web UI, typed with real key events. | the live check needs `dsh web` and the Chrome on 127.0.0.1:9222 |
| [`session-unread`](session-unread) | `test-client.mjs` — the menu entry, the row markers, the persisted set. | nothing |
| [`turn-sound`](turn-sound) | `test-client.mjs` — what rings, the debounce, the mute, the packaged sound. | nothing |
| [`chrome`](chrome) | `test-all.mjs` — the MCP client, the tool bridge, the session rules, and the definition against the harness's own tool registry. | nothing |

```bash
./test.sh                                   # the headless checks
node composer-code/test-live.mjs             # the live check
```

## Writing a plugin

A plugin is a package with two halves:

- `index.js` — the host half. It is loaded by the Host as a Cordis plugin and
  exports an `apply` function; a purely browser-side plugin does nothing
  there.
- `client.js` — the browser half. It registers itself with the client module
  loader and returns a plugin object (`{ inject, apply }`).

`package.json` wires the two together:

```jsonc
{
  "name": "@local/my-plugin",
  "type": "module",
  "exports": { ".": "./index.js", "./client": "./client.js" },
  "dsh": {
    "bundle": { "patch": "./cordis.patch.yml" },
    "client": { "platform": "web", "immediately": true }
  }
}
```

`cordis.patch.yml` adds the host row that publishes the package to the
browser:

```yaml
- insert:
    - id: my-plugin
      name: '@local/my-plugin'
```

See [`composer-code`](composer-code) for a worked example, including its live
test.
