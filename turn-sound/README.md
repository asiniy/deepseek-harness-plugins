# @local/turn-sound

A short chime in the Harness Web UI when a chat turn needs attention.

The sound plays when the agent needs the user:

- an approval is requested (`pendingInteraction` of kind `approval`);
- files changed (the `workspace/changes` session event);
- a turn finished (the Agent of a Session went idle).

The sound plays whether or not the tab is focused: no visibility check gates
it, so a visible tab rings as well as a hidden one.

## Mute it

Muting is a browser-local setting:

```js
localStorage.setItem('dsh.turn-sound.enabled', '0')  // muted
localStorage.setItem('dsh.turn-sound.enabled', '1')   // unmuted
```

## The two halves

- `client.js` — the browser half. It is built from `client.source.js` and the
  packaged sound: the browser bundle must carry the sound itself, because the
  plugin asset route only serves image formats. Rebuild it after changing
  either:

  ```bash
  python3 build-client.py
  ```

- `index.js` — the host half. It serves the sound over HTTP for the case
  where the browser half wants to fetch it instead of carrying it, and it can
  run a command on the Host machine when a turn ends, so a notification still
  fires when the browser tab is closed or the UI is used from another device.
  The command comes from the row's `config.command`, or from
  `DSH_TURN_SOUND_COMMAND`:

  ```bash
  DSH_TURN_SOUND_COMMAND="paplay /usr/share/sounds/freedesktop/stereo/message.oga"
  ```

## The sound

`assets/aoe2-attack.mp3` — the packaged notification sound. Drop another audio
file into `assets/` and `build-client.py` picks it up instead (it prefers this
one); `assets/make-chime.py` writes a generated two-tone chime for that
(16-bit mono PCM, 22 kHz, ~33 KB).

## Tests

`test-client.mjs` is a headless check of the browser half: it runs the
plugin against a fake window, a fake plugin context and a fake audio
context, and asserts what rings and what does not — an approval, changed
files, a finished turn — plus the debounce, the mute setting, the unlock
listeners, and that the built bundle carries the packaged sound.

```bash
node turn-sound/test-client.mjs
```

## Install

Clone the repository and link the folder into a profile:

```bash
git clone git@github.com:asiniy/deepseek-harness-plugins.git
python3 deepseek-harness-plugins/install/install.py turn-sound
```

The installer links the bundle into `~/.dsh/profiles/web/node_modules/@local/`
and records it in the profile manifest (dependencies + `dsh.profile.bundles`).
