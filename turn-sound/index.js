/**
 * Host half of the turn-sound bundle.
 *
 * Two jobs:
 *
 *  1. Serve the notification sound to the browser. The browser half fetches
 *     `/turn-sound.mp3` and decodes it with the Web Audio API. The plugin
 *     asset route only serves image formats, so the file is exposed through a
 *     small exact HTTP route owned by this plugin instead.
 *
 *  2. Optionally run a command on the Host machine whenever a chat turn
 *     ends, so a notification still fires when the browser tab is closed or
 *     the UI is used from another device. The command comes from the row's
 *     `config.command`, or from `DSH_TURN_SOUND_COMMAND`. With neither set,
 *     this half does nothing beyond serving the file.
 *
 * Examples:
 *   DSH_TURN_SOUND_COMMAND="paplay /usr/share/sounds/freedesktop/stereo/message.oga"
 *   DSH_TURN_SOUND_COMMAND="notify-send 'Harness: turn finished'"
 */

import { readFile } from 'node:fs/promises'
import { spawn } from 'node:child_process'

/** Required service: the Web server that owns the route table. */
export const inject = ['webServer']

/** Absolute pathname the browser fetches the sound from. */
const SOUND_PATH = '/turn-sound.mp3'

/** The sound file shipped inside this package. */
const SOUND_FILE = new URL('./assets/aoe2-attack.mp3', import.meta.url)

/**
 * @param {unknown} value - candidate command string.
 * @returns {string} the trimmed command, or an empty string.
 */
function readCommand(value) {
  return typeof value === 'string' ? value.trim() : ''
}

/**
 * Host plugin body: serve the sound and run the optional end-of-turn command.
 *
 * @param {import('@deepseek-ai/cordis').Context} ctx - Host context.
 * @param {{ command?: string }} [config] - row configuration.
 * @returns {void}
 */
export function apply(ctx, config) {
  ctx.effect(() =>
    ctx.webServer.register({
      kind: 'exact',
      path: SOUND_PATH,
      /**
       * @param {Request} request - the incoming request.
       * @returns {Promise<Response>} the sound, or a method refusal.
       */
      resource: async (request) => {
        if (request.method !== 'GET' && request.method !== 'HEAD') {
          return new Response(null, { status: 405, headers: { allow: 'GET, HEAD' } })
        }
        let bytes
        try {
          bytes = await readFile(SOUND_FILE)
        } catch {
          return new Response('turn-sound: the sound file is missing', { status: 404 })
        }
        return new Response(request.method === 'HEAD' ? null : bytes, {
          status: 200,
          headers: {
            'content-type': 'audio/mpeg',
            'content-length': String(bytes.byteLength),
            'cache-control': 'public, max-age=86400',
          },
        })
      },
    }),
  )

  const command = readCommand(config?.command) || readCommand(process.env.DSH_TURN_SOUND_COMMAND)
  if (command === '') return

  ctx.on('session/event', (session, event) => {
    if (event?.type !== 'turn/end') return
    try {
      const child = spawn(command, { shell: true, detached: true, stdio: 'ignore' })
      child.on('error', () => {})
      child.unref()
    } catch {
      // A failing notification command must never disturb the session.
    }
  })
}
