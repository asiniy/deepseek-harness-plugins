# @local/composer-code

Codex-style markdown in the Harness Web UI composer.

Two behaviours, both applied while the composer is typed:

- **Inline code** — `` `code` `` becomes a chip: monospace, coloured, on a
  grey background. The backticks stay in the message and are drawn as
  ordinary text, so they are not highlighted but still visible.
- **Code fences** — a ``` line opens a grey box that the rest of the message
  is typed into. The fence line moves into a zero-height paragraph of its
  own, so it is invisible in the composer and present in the message, and a
  line for the rest of the message appears under the box. A second ``` line
  closes the box and the text after it leaves the box.

## How it works

The DSH composer is a Lexical editor that keeps plain text. The plugin
decorates that editor state instead of touching the text:

- the composer publishes its editor on the content-editable element
  (`__lexicalEditor`), and the editor publishes the node classes it has
  registered. The plugin adds three node types of its own (inline code span,
  code block, fence line) and registers transforms that keep them in sync
  with the text;
- the fence line and the code box are paragraphs of the composer itself, and
  the plugin paints them from the DOM. A block of the plugin's own node type
  works until the user types into it: the browser cannot hold a caret in an
  element it does not know, and the caret leaves the box on the first
  keystroke. The box is therefore a plain paragraph that the plugin paints;
- the fence line is a paragraph of its own, so the newline between the fence
  and the code is the gap the composer already draws between blocks — no
  hidden line breaks are needed;
- the inline code span holds the code without its backticks, and the
  backticks are ordinary text beside it. The message therefore still reads
  `` `code` `` while the screen shows the code as a chip.

Every step is guarded: a composer that does not look the way the plugin
expects is left alone.

## Two rules taken from Codex

- A code span opens wherever a backtick opens it. Codex shipped a regression
  here ([openai/codex#59827](https://github.com/openai/codex/issues/59827)):
  the span only formatted when a space or punctuation came first, so
  ``abc`code` `` stayed literal. The scan here has no left boundary.
- The composer keeps the source text. Every decoration is a view of the text
  the user typed, and the text the message carries is the text the user
  typed.

## Tests

There is no unit test for the plugin: its logic is Lexical, and Lexical is
not installable on this machine (the npm registry answers 403). The check is
therefore a live one — `test-live.mjs` drives the composer of the running Web
UI through the Chrome DevTools Protocol, types with real key events, and
asserts what the user sees:

```bash
node composer-code/test-live.mjs
```

It needs `dsh web` running and the Chrome instance the harness drives
(127.0.0.1:9222). Seven checks: the inline chip and its plain backticks, the
caret behind the closing backtick, editing inside the chip, the fence opening
the grey box with a line for the rest of the message, the code staying in the
box over several lines, the keystrokes staying visible after the code is
backspaced away, and an empty code box being removed with backspace.

## Install

The plugin lives in the [deepseek-harness-plugins](https://github.com/asiniy/deepseek-harness-plugins)
repository, one folder per plugin. Clone it and link the folder into a
profile:

```bash
git clone git@github.com:asiniy/deepseek-harness-plugins.git \
  ~/Documents/deepseek-harness/default-workspace/deepseek-harness-plugins
python3 ~/Documents/deepseek-harness/default-workspace/install-composer-code.py
```

The installer links the bundle into `~/.dsh/profiles/web/node_modules/@local/`
and records it in the profile manifest (dependencies + `dsh.profile.bundles`),
which is the same work `pnpm add` would do — the npm registry is unreachable
from this machine.

The script links the bundle into `~/.dsh/profiles/web/node_modules/@local/`
and records it in the profile manifest (dependencies + `dsh.profile.bundles`),
which is the same work `pnpm add` would do — the npm registry is unreachable
from this machine.

The profile watches the plugin directory (`hmr` in `cordis.patch.yml`), so
edits to `client.js` reload in the browser without a page refresh.
