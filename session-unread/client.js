/**
 * Browser half of the session-unread bundle.
 *
 * Codex lets you right-click a session and mark it unread. DSH has no such
 * action: the shipped sidebar marks a session unread by itself, when the
 * session finishes while another one is open, and that marker is private to
 * the browser (`dsh-client-ui-session` keeps it in a `completionUnread` set
 * with no public setter, and it never reaches the Host).
 *
 * This plugin adds the missing action:
 *
 *   - "Mark as unread" / "Mark as read" in the session context menu, through
 *     `ctx.contextMenus` — the same list the built-in Pin, Rename, Fork,
 *     Copy session ID and Archive entries live in;
 *   - a done-dot on the session row, drawn with the same `StateDot` the
 *     built-in completion marker uses. The dot sits in the row's status cell,
 *     beside the title (the `sidebar.session.row.leading` seat, which keeps
 *     its content while the row is hovered);
 *   - the marked Session floats to the top of the list, through the same
 *     mechanism the built-in Pin action uses.
 *
 * The marked set lives in localStorage, so it survives a reload, and it is
 * cleared when the session is opened: the flag means "not read yet", exactly
 * like the built-in marker. Nothing reaches the Host, so the marker belongs
 * to this browser only.
 */

window.__ModuleLoader__.load({
  id: '@local/session-unread',
  factory: (require) => {
    const React = require('react')
    const { IconCheckCircleOutlineRegular, StateDot } = require('@deepseek-ai/dsh-client-ui-primitives')

    /** Locale namespace of this plugin's own copy. */
    const NS = 'local.sessionUnread'

    /** Context-menu glyph keys this plugin contributes. */
    const ICON_UNREAD = 'local.sessionUnread.unread'
    const ICON_READ = 'local.sessionUnread.read'

    /** localStorage key holding the marked-unread Session identities. */
    const STORAGE_KEY = 'dsh.session-unread.v1'

    /** localStorage key holding the Sessions this plugin pinned to float them. */
    const PINNED_KEY = 'dsh.session-unread.pinned.v1'

    const en = {
      'menu.markUnread': 'Mark as unread',
      'menu.markRead': 'Mark as read',
      'dot.label': 'Unread',
    }

    const zh = {
      'menu.markUnread': '标记为未读',
      'menu.markRead': '标记为已读',
      'dot.label': '未读',
    }

    // ---------------------------------------------------------------- state

    /**
     * @param {string} key - localStorage key.
     * @returns {string[]} the persisted identities, or none when storage is unavailable.
     */
    function readStored(key) {
      try {
        const raw = window.localStorage.getItem(key)
        if (raw === null) return []
        const parsed = JSON.parse(raw)
        if (!Array.isArray(parsed)) return []
        return parsed.filter((value) => typeof value === 'string')
      } catch {
        // Private-mode storage failures must not break the sidebar.
        return []
      }
    }

    /**
     * @param {string} key - localStorage key.
     * @param {ReadonlySet<string>} ids - identities to persist.
     * @returns {void}
     */
    function writeStored(key, ids) {
      try {
        window.localStorage.setItem(key, JSON.stringify([...ids]))
      } catch {
        // A failed write costs the marker its persistence, not its use.
      }
    }

    /**
     * The published state: the marked identities, the Session the main view
     * currently holds, and the Sessions this plugin pinned to float them.
     *
     * @type {{ unread: ReadonlySet<string>, mainId: string | null, pinned: ReadonlySet<string> }}
     */
    let state = {
      unread: new Set(readStored(STORAGE_KEY)),
      mainId: null,
      pinned: new Set(readStored(PINNED_KEY)),
    }

    /** @type {Set<() => void>} */
    const listeners = new Set()

    /**
     * Replace the published state and notify its subscribers.
     *
     * @param {{ unread: ReadonlySet<string>, mainId: string | null, pinned: ReadonlySet<string> }} next - the new state.
     * @returns {void}
     */
    function publish(next) {
      state = next
      for (const listener of [...listeners]) {
        try {
          listener()
        } catch (error) {
          console.error('[session-unread] subscriber failed', error)
        }
      }
    }

    const store = {
      /**
       * @returns {{ unread: ReadonlySet<string>, mainId: string | null, pinned: ReadonlySet<string> }} the current state.
       */
      getSnapshot: () => state,
      /**
       * @param {() => void} listener - state subscriber.
       * @returns {() => void} the unsubscribe function.
       */
      subscribe: (listener) => {
        listeners.add(listener)
        return () => {
          listeners.delete(listener)
        }
      },
    }

    /**
     * Mark a Session unread or read.
     *
     * @param {string} sessionId - Session identity.
     * @param {boolean} unread - whether the Session should carry the marker.
     * @returns {void}
     */
    function setUnread(sessionId, unread) {
      if (unread === state.unread.has(sessionId)) return
      const next = new Set(state.unread)
      if (unread) next.add(sessionId)
      else next.delete(sessionId)
      writeStored(STORAGE_KEY, next)
      publish({ unread: next, mainId: state.mainId, pinned: state.pinned })
    }

    /**
     * Release the plugin's own pin on a Session that lost its mark.
     *
     * The plugin body owns the Host-facing call; this hook is where the
     * browser-local state asks for it.
     *
     * @type {(sessionId: string) => void}
     */
    let releasePin = () => {}

    // ------------------------------------------------------------ main view

    /**
     * The Session the main view holds, if any.
     *
     * A transition can retain the old and the new Session for a moment, so the
     * previous holder wins while it is still retained.
     *
     * @param {{ ids?: readonly string[], byId?: Record<string, { retainedBy?: Record<string, number> }> }} snapshot - the session list snapshot.
     * @param {string | null} previous - the Session the main view held before.
     * @returns {string | null} the current holder, or null when there is none.
     */
    function mainSessionId(snapshot, previous) {
      const byId = snapshot.byId ?? {}
      const ids = snapshot.ids ?? []
      let retained = null
      for (const id of ids) {
        const count = byId[id]?.retainedBy?.mainView
        if (typeof count === 'number' && count > 0) {
          retained = id
          break
        }
      }
      if (retained === null) return null
      if (previous !== null) {
        const previousCount = byId[previous]?.retainedBy?.mainView
        if (typeof previousCount === 'number' && previousCount > 0) return previous
      }
      return retained
    }

    /**
     * Fold a session list snapshot into the published state.
     *
     * @param {{ ids?: readonly string[], byId?: Record<string, unknown>, phase?: string }} snapshot - the session list snapshot.
     * @returns {void}
     */
    function sync(snapshot) {
      const mainId = mainSessionId(snapshot, state.mainId)
      const unread = new Set(state.unread)
      let changed = false

      // Opening a Session reads it: the marker goes when the main view moves.
      if (mainId !== null && mainId !== state.mainId && unread.delete(mainId)) {
        changed = true
        releasePin(mainId)
      }

      // A Session that left the catalog is gone for good.
      if (snapshot.phase === 'ready') {
        const byId = snapshot.byId ?? {}
        for (const id of [...unread]) {
          if (byId[id] === undefined) {
            unread.delete(id)
            changed = true
            releasePin(id)
          }
        }
      }

      if (!changed && mainId === state.mainId) return
      if (changed) writeStored(STORAGE_KEY, unread)
      publish({ unread, mainId, pinned: state.pinned })
    }

    // ------------------------------------------------------------------- ui

    /**
     * The envelope-with-dot glyph for "Mark as unread".
     *
     * The plugin's own mark, drawn in the menu's currentColor so it sits with
     * the shipped line glyphs. The envelope's corner opens where the dot
     * lands, so the dot needs no background punched out of it.
     *
     * @returns {React.ReactNode} the glyph.
     */
    function UnreadGlyph() {
      return React.createElement(
        'svg',
        {
          xmlns: 'http://www.w3.org/2000/svg',
          viewBox: '4 7 29 24',
          width: 16,
          height: 16,
          fill: 'none',
          'aria-hidden': 'true',
        },
        React.createElement('path', {
          d: 'M5.5 23v-10.5a3.5 3.5 0 0 1 3.5-3.5h18a3.5 3.5 0 0 1 3.5 3.5V21',
          stroke: 'currentColor',
          strokeWidth: 2.2,
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
        }),
        React.createElement('path', {
          d: 'M5.5 23H21',
          stroke: 'currentColor',
          strokeWidth: 2.2,
          strokeLinecap: 'round',
        }),
        React.createElement('path', {
          d: 'M8 13l10 7.5L28 13',
          stroke: 'currentColor',
          strokeWidth: 2.2,
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
        }),
        React.createElement('circle', { cx: 26, cy: 25, r: 5, fill: 'currentColor' }),
      )
    }

    /**
     * The browser context, available once the plugin body runs.
     *
     * @type {import('@deepseek-ai/cordis').Context | undefined}
     */
    let pluginCtx = undefined

    /**
     * Whether the row's status cell is taken by a spinner or a warning.
     *
     * The shipped row gives that cell to the running spinner, to the pending
     * interaction warning, or to its own completion marker, and leaves it to
     * the `sidebar.session.row.leading` seat only while the Session is idle.
     * A completion marker is itself a green dot the user reads as unread, so
     * only the spinner and the warning count as a cell that says nothing.
     *
     * @param {string} sessionId - Session identity.
     * @returns {boolean} whether the cell is occupied.
     */
    function cellBusy(sessionId) {
      const status = pluginCtx?.uiSession.sessionStatus.getSnapshot()?.get(sessionId)
      if (status === undefined) return false
      return status.running === true || status.pendingInteraction !== undefined
    }

    /**
     * The marker in the row's status cell, beside the title.
     *
     * The status cell keeps its content while the row is hovered, so this is
     * the marker that stays visible when the row is under the pointer. The
     * seat renders only while the row carries no status of its own, so the
     * built-in completion marker keeps that cell to itself.
     *
     * @param {{ sessionId: string, t?: (key: string) => string }} props - the seat's props.
     * @returns {React.ReactNode} the marker, or nothing for a read Session.
     */
    function UnreadMark({ sessionId, t }) {
      const snapshot = React.useSyncExternalStore(store.subscribe, store.getSnapshot)
      if (!snapshot.unread.has(sessionId)) return null
      const label = typeof t === 'function' ? t('dot.label') : 'Unread'
      return React.createElement(
        'span',
        {
          className: 'dsh-session-unread-mark',
          role: 'img',
          'aria-label': label,
          title: label,
          style: { display: 'inline-flex', alignItems: 'center' },
        },
        React.createElement(StateDot, { state: 'done' }),
      )
    }

    /**
     * The marker beside the time label, for a row whose status cell is busy.
     *
     * While a Session runs or waits for an answer, the spinner owns the
     * status cell and the leading seat never renders — the marker would have
     * nowhere to go on the left. This seat is the row's resting area, so it
     * carries the marker exactly then, and never at the same time as the
     * leading marker.
     *
     * @param {{ sessionId: string, t?: (key: string) => string }} props - the seat's props.
     * @returns {React.ReactNode} the marker, or nothing for a read Session.
     */
    function UnreadDot({ sessionId, t }) {
      const snapshot = React.useSyncExternalStore(store.subscribe, store.getSnapshot)
      if (!snapshot.unread.has(sessionId)) return null
      if (!cellBusy(sessionId)) return null
      const label = typeof t === 'function' ? t('dot.label') : 'Unread'
      return React.createElement(
        'span',
        {
          className: 'dsh-session-unread-dot',
          role: 'img',
          'aria-label': label,
          title: label,
          style: { display: 'inline-flex', alignItems: 'center' },
        },
        React.createElement(StateDot, { state: 'done' }),
      )
    }

    // --------------------------------------------------------------- plugin

    /**
     * Plugin body.
     *
     * @param {import('@deepseek-ai/cordis').Context} ctx - browser context.
     * @returns {void}
     */
    function apply(ctx) {
      pluginCtx = ctx
      ctx.effect(() => ctx.locale.register(NS, { en, zh }), 'local-session-unread: dictionaries')
      const t = ctx.locale.bind(NS)

      /**
       * Float a Session to the top of the list.
       *
       * DSH orders a group's rows by recency, and the built-in Pin action is
       * what floats a row to the top of the list in every view and every order
       * mode. This plugin borrows that mechanism: marking a Session unread
       * pins it, and clearing the mark releases it again — but only a pin this
       * plugin set, so a pin the user placed by hand survives.
       *
       * @param {string} sessionId - Session identity.
       * @returns {Promise<void>} resolves once the pin is set, or ignored.
       */
      const floatToTop = async (sessionId) => {
        try {
          const snapshot = ctx.workspaces.list.getSnapshot()
          if (snapshot.pinnedSessionIds.includes(sessionId)) return
          await ctx.uiWorkspace.pinSession(sessionId)
          const pinned = new Set(state.pinned)
          pinned.add(sessionId)
          writeStored(PINNED_KEY, pinned)
          publish({ unread: state.unread, mainId: state.mainId, pinned })
        } catch (error) {
          console.warn('[session-unread] could not float the session to the top', error)
        }
      }

      /**
       * Release the plugin's own pin on a Session.
       *
       * @param {string} sessionId - Session identity.
       * @returns {Promise<void>} resolves once the pin is gone, or ignored.
       */
      const unfloat = async (sessionId) => {
        if (!state.pinned.has(sessionId)) return
        const pinned = new Set(state.pinned)
        pinned.delete(sessionId)
        writeStored(PINNED_KEY, pinned)
        publish({ unread: state.unread, mainId: state.mainId, pinned })
        try {
          await ctx.uiWorkspace.unpinSession(sessionId)
        } catch (error) {
          console.warn('[session-unread] could not release the session pin', error)
        }
      }

      releasePin = (sessionId) => {
        void unfloat(sessionId)
      }

      // The menu glyphs. The context menu renders an action's icon through the
      // keyed `contextMenu.icon` slot, exactly as the shipped Pin, Rename,
      // Fork, Copy and Archive entries do. The unread glyph is the very dot
      // the row carries once the mark is set.
      ctx.effect(
        () =>
          ctx.slots.inject('contextMenu.icon', function* () {
            yield ctx.slots.register(
              { name: 'contextMenu.icon', key: ICON_UNREAD },
              UnreadGlyph,
            )
            yield ctx.slots.register(
              { name: 'contextMenu.icon', key: ICON_READ },
              IconCheckCircleOutlineRegular,
            )
          }),
        'local-session-unread: menu icons',
      )

      // The menu entry. Right-click and the row's "..." button share one list.
      ctx.effect(
        () =>
          ctx.contextMenus.register({
            id: 'local.session.unread',
            target: 'session',
            order: 460,
            resolve: (target) => {
              const unread = store.getSnapshot().unread.has(target.sessionId)
              return [
                {
                  id: unread ? 'markRead' : 'markUnread',
                  label: t(unread ? 'menu.markRead' : 'menu.markUnread'),
                  icon: { key: unread ? ICON_READ : ICON_UNREAD },
                  run: async () => {
                    if (unread) {
                      setUnread(target.sessionId, false)
                      await unfloat(target.sessionId)
                    } else {
                      setUnread(target.sessionId, true)
                      await floatToTop(target.sessionId)
                    }
                  },
                },
              ]
            },
          }),
        'local-session-unread: session menu action',
      )

      // The row marker, in the status cell beside the title.
      ctx.effect(
        () =>
          ctx.slots.inject('sidebar.session.row.leading', () =>
            ctx.slots.register(
              {
                name: 'sidebar.session.row.leading',
                id: 'unread-mark',
                order: 20,
                locale: NS,
              },
              UnreadMark,
            ),
          ),
        'local-session-unread: session row marker',
      )

      // The fallback marker, beside the time label, for a busy status cell.
      ctx.effect(
        () =>
          ctx.slots.inject('sidebar.session.row.trailing', () =>
            ctx.slots.register(
              {
                name: 'sidebar.session.row.trailing',
                id: 'unread-dot',
                order: 10,
                locale: NS,
              },
              UnreadDot,
            ),
          ),
        'local-session-unread: session row fallback marker',
      )

      // The main view tells which Session the user is reading.
      ctx.effect(() => {
        const dispose = ctx.sessions.list.subscribe(() => {
          sync(ctx.sessions.list.getSnapshot())
        })
        sync(ctx.sessions.list.getSnapshot())
        return dispose
      }, 'local-session-unread: session list watch')
    }

    return {
      inject: ['contextMenus', 'locale', 'sessions', 'slots', 'uiSession', 'uiWorkspace', 'workspaces'],
      apply,
    }
  },
})
