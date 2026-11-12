# @local/session-unread

A local DSH bundle that adds Codex's **Mark as unread** to the Harness Web UI.

## What it does

- Adds a **Mark as unread** / **Mark as read** entry to the session context menu
  (right-click a session row, or use its `...` button). It sits between
  *Copy session ID* and the native *Reveal* entry, and carries a glyph like
  every other menu entry: the plugin's envelope-with-dot for *Mark as
  unread*, the shipped check circle for *Mark as read*.
- Marks the session row with the same done-dot the shipped completion marker
  uses. It sits in the row's status cell beside the title (the
  `sidebar.session.row.leading` seat, which keeps its content while the row is
  hovered). That cell belongs to DSH's own status while the session runs or
  waits for an answer — the spinner and the warning take it, and the leading
  seat never renders — so in that case the marker moves beside the time label
  instead, and never appears in both places at once.
- Keeps the marked sessions in `localStorage` under `dsh.session-unread.v1`, so
  they survive a reload.
- **Floats the marked session to the top of the list.** DSH orders a group's
  rows by recency, and its own *Pin* action is what floats a row to the top in
  every view and order mode, so the plugin borrows it: marking unread pins the
  session, and clearing the mark releases it again — but only a pin the plugin
  set, so a pin you placed by hand survives. The row therefore shows the pin
  icon while it is marked unread.
- Clears a mark when the session is opened, and forgets a session that left
  the catalog. Marking the session you are reading works too: the marker shows
  at once and goes when you open that session again.

## What it does not do

The marked set is **local to this browser**. Nothing reaches the Host, so the
marker is not shared with another browser or device — the same boundary the
shipped "new task completed" marker lives behind
(*completion-time > last-seen never reaches the host*).

The built-in completion marker is a separate thing: DSH marks a session
unread by itself when the session finishes while another one is open. That
state lives in a private set inside `dsh-client-ui-session` with no public
setter, so this plugin cannot set it — it keeps its own set and its own dot.

## Layout

| File | Role |
| --- | --- |
| `index.js` | Host half. Does nothing; it exists so the Host publishes the browser half. |
| `cordis.patch.yml` | The Host row that makes the package a browser module. |
| `client.js` | The browser half: menu entry, row markers, persisted set. |
| `locale/*.json` | Plugin card title and description. |
| `icon.svg` | Plugin card icon, declared by the manifest's `icon` field. |
| `test-client.mjs` | Headless check of the browser half's behaviour. |

## Install

The plugin lives in the [deepseek-harness-plugins](https://github.com/asiniy/deepseek-harness-plugins)
repository, one folder per plugin. Clone it and install the plugin:

```
git clone git@github.com:asiniy/deepseek-harness-plugins.git
python3 deepseek-harness-plugins/install/install.py session-unread
```

That links the package into `~/.dsh/profiles/web/node_modules/@local/` and
records it in the profile manifest (`dependencies` and `dsh.profile.bundles`),
because this machine has no npm registry access and no pnpm. Restart
`dsh web` afterwards: the Host composes the profile at boot.

## Check

```
node test-client.mjs
```

Runs the browser half against a fake window, a fake `require`, and a fake
plugin context, and asserts the menu labels, the persisted set, the row
marker, and both rules that clear a mark.
