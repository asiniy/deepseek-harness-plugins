/**
 * Browser half of the turn-sound bundle (source).
 *
 * `build-client.py` replaces `__SOUND_DATA_URI__` with the base64 payload of
 * `assets/aoe2-attack.mp3` and writes the loadable `client.js` next to this
 * file. Edit this file, then run the build script.
 *
 * The sound plays when the agent needs attention:
 *
 *   - an approval is requested (`pendingInteraction` of kind `approval`);
 *   - files changed (`workspace/changes` session event);
 *   - a turn finished (the Agent of a Session went idle).
 *
 * The sound plays whether or not the tab is focused: no visibility check
 * gates it, so a visible tab rings exactly like a background one.
 *
 * The plugin adds no interface. Muting it is a browser-local setting:
 * `localStorage.setItem('dsh.turn-sound.enabled', '0')` (and `'1'` to unmute).
 */

window.__ModuleLoader__.load({
  id: '@local/turn-sound',
  factory() {
    const STORAGE_KEY = 'dsh.turn-sound.enabled'
    const VOLUME = 0.8
    /** Collapse repeats inside this window, so one turn rings once. */
    const DEBOUNCE_MS = 1500
    const UNLOCK_EVENTS = ['pointerdown', 'keydown', 'touchstart']

    /** The notification sound, inlined by the build script. */
    const SOUND_DATA_URI = '__SOUND_DATA_URI__'

    // ---------------------------------------------------------------- state

    /**
     * @returns {boolean} whether the sound is enabled.
     */
    function readEnabled() {
      try {
        const stored = window.localStorage.getItem(STORAGE_KEY)
        if (stored === '0') return false
        if (stored === '1') return true
      } catch {
        // Private-mode storage failures must not break the plugin.
      }
      return true
    }

    const enabled = readEnabled()

    // ---------------------------------------------------------------- audio

    let audio = null
    let decoding = null
    let lastPlayedAt = 0

    /**
     * @returns {AudioContext|null} the shared audio context, or null.
     */
    function audioContext() {
      if (audio !== null) return audio
      const Ctor = window.AudioContext || window.webkitAudioContext
      if (Ctor === undefined) return null
      try {
        audio = new Ctor()
      } catch {
        audio = null
      }
      return audio
    }

    /**
     * @param {AudioContext} context - the audio context to resume.
     * @returns {Promise<void>} resolves once the context may be running.
     */
    function resumeAudio(context) {
      if (context.state !== 'suspended') return Promise.resolve()
      const resumed = context.resume()
      if (resumed && typeof resumed.then === 'function') return resumed.then(() => {}, () => {})
      return Promise.resolve()
    }

    /**
     * Decode the inlined sound into an AudioBuffer.
     *
     * @param {AudioContext} context - the audio context decoding the sound.
     * @returns {Promise<AudioBuffer>} the decoded sound.
     */
    function loadSound(context) {
      decoding ??= (async () => {
        const payload = SOUND_DATA_URI.slice(SOUND_DATA_URI.indexOf(',') + 1)
        const binary = atob(payload)
        const bytes = new Uint8Array(binary.length)
        for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index)
        return await context.decodeAudioData(bytes.buffer)
      })().catch((error) => {
        decoding = null
        throw error
      })
      return decoding
    }

    /**
     * Play the notification sound once.
     *
     * @param {string} reason - the trigger, for the console record.
     */
    function notify(reason) {
      if (!enabled) return
      const now = Date.now()
      if (now - lastPlayedAt < DEBOUNCE_MS) return
      lastPlayedAt = now
      const context = audioContext()
      if (context === null) return
      const start = () => {
        loadSound(context)
          .then((buffer) => {
            const source = context.createBufferSource()
            const gain = context.createGain()
            source.buffer = buffer
            gain.gain.value = VOLUME
            source.connect(gain)
            gain.connect(context.destination)
            source.start()
          })
          .catch((error) => {
            console.warn('[turn-sound]', reason, error)
          })
      }
      if (context.state === 'suspended') {
        resumeAudio(context).then(start)
        return
      }
      start()
    }

    /** Create/resume the audio context from a user gesture. */
    function unlockAudio() {
      const context = audioContext()
      if (context === null) return
      resumeAudio(context)
    }

    function attachUnlock() {
      for (const type of UNLOCK_EVENTS) {
        window.addEventListener(type, unlockAudio, { capture: true, passive: true })
      }
    }

    function detachUnlock() {
      for (const type of UNLOCK_EVENTS) {
        window.removeEventListener(type, unlockAudio, { capture: true })
      }
    }

    // --------------------------------------------------------------- plugin

    return {
      inject: ['remote', 'sessions', 'uiSession'],

      /**
       * @param {import('@deepseek-ai/cordis').Context} ctx - browser context.
       */
      apply(ctx) {
        ctx.effect(() => {
          attachUnlock()

          // -- approvals ---------------------------------------------------
          // The Session UI publishes one status entry per Session. A new
          // pending interaction of kind `approval` means the agent is waiting
          // for a decision, in any Session the page knows about.
          const seenInteractions = new Map()

          const disposeStatus = ctx.uiSession.sessionStatus.subscribe(() => {
            const snapshot = ctx.uiSession.sessionStatus.getSnapshot()
            if (snapshot === undefined) return
            for (const [sessionId, status] of snapshot) {
              const interaction = status.pendingInteraction
              if (interaction === undefined) continue
              let seen = seenInteractions.get(sessionId)
              if (seen === undefined) {
                seen = new Set()
                seenInteractions.set(sessionId, seen)
              }
              if (seen.has(interaction.key)) continue
              seen.add(interaction.key)
              if (interaction.kind === 'approval') notify('approval')
            }
          })

          // -- session events ----------------------------------------------
          // `workspace/changes` (files changed) and `approval/asked` (a
          // decision request) are durable Session events. They arrive on the
          // event window of every open Session.
          /** @type {Map<string, { binding: object, dispose: () => void }>} */
          const watched = new Map()

          /**
           * @param {string} sessionId - Session identity to watch.
           */
          const watch = (sessionId) => {
            if (watched.has(sessionId)) return
            let binding
            try {
              binding = ctx.sessions.binding(sessionId)
            } catch {
              return
            }
            if (binding === undefined) return
            const dispose = binding.eventSource.subscribe(() => {
              const { change } = binding.eventSource.getSnapshot()
              if (change.kind !== 'append') return
              for (const { event } of change.entries) {
                if (event === undefined) continue
                if (event.type === 'workspace/changes') notify('change')
                else if (event.type === 'approval/asked') notify('approval')
              }
            })
            watched.set(sessionId, { binding, dispose })
          }

          const syncWatched = () => {
            const ids = new Set()
            const list = ctx.sessions.list.getSnapshot()
            if (list !== undefined) for (const id of list.ids) ids.add(id)
            const status = ctx.uiSession.sessionStatus.getSnapshot()
            if (status !== undefined) for (const id of status.keys()) ids.add(id)
            for (const id of ids) watch(id)
          }

          const disposeList = ctx.sessions.list.subscribe(syncWatched)
          syncWatched()

          // -- turn finished -------------------------------------------------
          // The Host forwards one Agent lifecycle transition per Session.
          const disposeAgentStatus = ctx.remote.$on('api-session/status', (sessionId, running) => {
            if (running === true) return
            notify('finished')
          })

          return () => {
            disposeAgentStatus()
            disposeList()
            disposeStatus()
            detachUnlock()
            for (const entry of watched.values()) entry.dispose()
            watched.clear()
          }
        })
      },
    }
  },
})
