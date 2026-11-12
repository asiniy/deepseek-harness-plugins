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

## Installing a plugin

A plugin is installed into a Harness profile the way `pnpm add` would do it:

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

The Host picks the bundle up on the next reload of the profile; the browser
half is served from `/plugins/...` and can be reloaded without restarting the
Host when its directory is listed in the `hmr` row of the profile patch.

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
