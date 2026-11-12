/**
 * Browser half of the composer-code bundle.
 *
 * Codex styles the composer markdown while it is typed: `inline code` turns
 * into a coloured chip on a grey background, and a ``` fence opens a grey
 * box that the rest of the message is typed into. The DSH composer is a
 * Lexical editor that keeps plain text, so this plugin decorates the editor
 * state instead:
 *
 *   - inline code: the text node is split at the backtick pairs and the code
 *     span becomes a node of this plugin's own type, styled through CSS. The
 *     backticks stay in the message but are drawn as ordinary text, so the
 *     composer shows the code alone while the message that leaves the
 *     composer still carries its markdown.
 *   - code fences: a ``` line opens a code block. The fence line moves into
 *     a zero-height paragraph of its own, so it is invisible in the composer
 *     and present in the message, and the code goes into the paragraph below
 *     it, which the plugin paints as the grey box. A second ``` line closes
 *     the box and the text after it leaves the box.
 *
 * Three rules from the Codex composer are kept on purpose:
 *
 *   - a code span opens wherever a backtick opens it. Codex shipped a
 *     regression here (openai/codex#59827): the span only formatted when a
 *     space or punctuation came first, so `abc`code`` stayed literal. The
 *     scan below has no left boundary at all.
 *   - the composer keeps the source text. Every decoration here is a view
 *     of the text the user typed, and the text the message carries is the
 *     text the user typed.
 *   - the code block is an ordinary paragraph. A block of the plugin's own
 *     node type works until the user types into it: the browser cannot hold
 *     a caret in an element it does not know, and the caret leaves the box
 *     on the first keystroke. The box is therefore a plain paragraph that
 *     the plugin paints.
 *
 * The plugin reaches the editor through the handle the composer publishes on
 * its content-editable element (`__lexicalEditor`) and through the node
 * classes the editor has registered. Every step is guarded: a composer that
 * does not look the way this plugin expects is left alone.
 */

window.__ModuleLoader__.load({
  id: '@local/composer-code',
  factory() {
    /** Inline code span: a backtick pair with a non-empty, single-line body. */
    const INLINE_RE = /`([^`\n]+)`/g
    /** The fence that opens and closes a code block. */
    const FENCE = '```'
    /** Registered node type of the inline code span. */
    const CODE_TYPE = 'dsh-composer-inline-code'
    /** Class of the paragraph that holds a fence line. */
    const FENCE_CLASS = 'dsh-code-fence'
    /** Class of the paragraph that draws the grey code box. */
    const BLOCK_CLASS = 'dsh-code-block'
    /** Style of a text that stays in the message but not on the screen. */
    const HIDDEN_STYLE = 'font-size:0'
    /** Style id of the injected stylesheet. */
    const STYLE_ID = 'dsh-composer-code-styles'

    /** Editors this plugin already decorated. */
    const decorated = new WeakSet()
    /** Node keys of the paragraphs that hold a fence line. */
    const fenceLines = new Set()
    /** Node keys of the paragraphs that draw the grey code box. */
    const codeBlocks = new Set()
    /** Node keys of the fence lines the user is editing: they show again. */
    const editedFences = new Set()

    /**
     * @returns {Element|null} the composer content-editable element.
     */
    function composerElement() {
      return document.querySelector('[data-composer-input]')
    }

    /**
     * @param {Element|null} element - the composer element.
     * @returns {object|null} the Lexical editor the composer owns.
     */
    function editorOf(element) {
      const editor = element === null ? null : element.__lexicalEditor
      return editor !== undefined && editor !== null ? editor : null
    }

    /**
     * Add the plugin styles once per document.
     */
    function installStyles() {
      if (document.getElementById(STYLE_ID) !== null) return
      const style = document.createElement('style')
      style.id = STYLE_ID
      style.textContent = [
        `[data-composer-input] .dsh-inline-code {`,
        '  background: color-mix(in srgb, currentColor 14%, transparent);',
        '  color: var(--dsh-composer-code-fg, #b4530a);',
        '  border-radius: 4px;',
        '  padding: 0.1em 0.3em;',
        '  font-family: var(--dsh-font-mono, ui-monospace, SFMono-Regular, Menlo, monospace);',
        '  font-size: 0.92em;',
        '}',
        `[data-composer-input] .${BLOCK_CLASS} {`,,
        '  background: color-mix(in srgb, currentColor 8%, transparent);',
        '  border: 1px solid color-mix(in srgb, currentColor 12%, transparent);',
        '  border-radius: 8px;',
        '  padding: 8px 10px;',
        '  margin: 2px 0;',
        '  font-family: var(--dsh-font-mono, ui-monospace, SFMono-Regular, Menlo, monospace);',
        '  font-size: 0.92em;',
        '  white-space: pre-wrap;',
        '}',
        `[data-composer-input] .${FENCE_CLASS} {`,
        '  height: 0;',
        '  margin: 0;',
        '  padding: 0;',
        '  line-height: 0;',
        '  overflow: hidden;',
        '}',
        'body[data-ds-dark-theme] [data-composer-input] .dsh-inline-code {',
        '  --dsh-composer-code-fg: #f0a868;',
        '}',
      ].join('\n')
      document.head.append(style)
    }

    /**
     * Decorate one editor: register the plugin node types and the transforms
     * that keep them in sync with the text.
     * @param {object} editor - the Lexical editor of the composer.
     */
    function decorate(editor) {
      if (decorated.has(editor)) return
      const nodes = editor._nodes
      if (nodes === undefined || nodes === null) return
      const TextClass = nodes.get('text')?.klass
      const ParagraphClass = nodes.get('paragraph')?.klass
      const LineBreakClass = nodes.get('linebreak')?.klass
      if (TextClass === undefined || ParagraphClass === undefined || LineBreakClass === undefined) return

      /** Inline code span: a text node of its own type, styled as a chip. */
      class InlineCodeNode extends TextClass {
        /** @returns {string} the Lexical node type. */
        static getType() { return CODE_TYPE }

        /**
         * @param {InlineCodeNode} node - the node to clone.
         * @returns {InlineCodeNode} the copy.
         */
        static clone(node) { return new InlineCodeNode(node.__text, node.__key) }

        /**
         * @param {object} json - the serialized node.
         * @returns {InlineCodeNode} the rebuilt node.
         */
        static importJSON(json) {
          const node = new InlineCodeNode(json.text)
          node.setFormat(json.format)
          node.setDetail(json.detail)
          node.setMode(json.mode)
          node.setStyle(json.style)
          return node
        }

        /** @returns {object} the serialized node. */
        exportJSON() { return { ...super.exportJSON(), type: CODE_TYPE } }

        /**
         * @param {object} config - the editor config.
         * @returns {HTMLElement} the styled span.
         */
        createDOM(config) {
          const dom = super.createDOM(config)
          dom.className = `${dom.className} dsh-inline-code`.trim()
          return dom
        }

        /**
         * The span is ordinary text: the user edits the code inside it, and
         * a span of its own type never merges with a plain sibling.
         * @returns {false} the span is editable text.
         */
        isTextEntity() { return false }
      }

      /**
       * Register one node type with the editor.
       * @param {string} type - the node type.
       * @param {Function} klass - the node class.
       */
      function registerNodeType(type, klass) {
        nodes.set(type, {
          exportDOM: undefined,
          klass,
          replace: null,
          replaceWithKlass: null,
          sharedNodeState: {},
          transforms: new Set(),
        })
      }

      registerNodeType(CODE_TYPE, InlineCodeNode)

      /**
       * @param {object} node - a Lexical node.
       * @returns {boolean} whether the node is a plain fence line.
       */
      function isFenceLine(node) {
        return node.getType() === 'text' && node.getTextContent() === FENCE
      }

      /**
       * @param {object} node - a Lexical node.
       * @returns {boolean} whether the node is a line break.
       */
      function isBreak(node) {
        return node.getType() === 'linebreak'
      }

      /**
       * @param {object} node - a Lexical node.
       * @returns {boolean} whether the node is text the plugin drew as nothing.
       */
      function isHidden(node) {
        return node.getType() === 'text' && node.getStyle().includes(HIDDEN_STYLE)
      }

      /**
       * @param {object} node - a Lexical node.
       * @returns {boolean} whether the node is text that ends in a backtick.
       */
      function endsWithBacktick(node) {
        if (node === null || node.getType() !== 'text') return false
        const text = node.getTextContent()
        return text.length > 0 && text.endsWith('`')
      }

      /**
       * @param {object} node - a Lexical node.
       * @returns {boolean} whether the node is text that starts with a backtick.
       */
      function startsWithBacktick(node) {
        if (node === null || node.getType() !== 'text') return false
        return node.getTextContent().startsWith('`')
      }

      /**
       * @param {object} node - the code span.
       * @returns {boolean} whether the span still stands between two backticks.
       */
      function isCodeSpan(node) {
        return endsWithBacktick(node.getPreviousSibling()) && startsWithBacktick(node.getNextSibling())
      }

      /**
       * A code span that lost a backtick is plain text again. The caret sits
       * in the span the user is editing, so it moves to the plain text with
       * the same offset; otherwise the composer would swallow the next
       * keystrokes.
       * @param {object} node - the code span.
       */
      function releaseCodeSpan(node) {
        const caret = caretOffsetIn(node)
        const plain = new TextClass(node.getTextContent())
        plain.setFormat(node.getFormat())
        node.replace(plain)
        if (caret !== null) plain.select(caret, caret)
      }

      /**
       * Build the nodes of one code span: the opening backtick, the code
       * itself, and the closing backtick. The backticks stay plain text, so
       * the composer shows them without the chip's colour and background, and
       * the caret can sit in them.
       * @param {string} body - the code between the backticks.
       * @param {number} format - the text format of the span.
       * @returns {LexicalNode[]} the three nodes, in order.
       */
      function codeSpanNodes(body, format) {
        const open = new TextClass('`')
        const code = new InlineCodeNode(body)
        code.setFormat(format)
        const close = new TextClass('`')
        return [open, code, close]
      }

      /**
       * The caret inside one node, in the node's own coordinates.
       * @param {object} node - the node the caret may sit in.
       * @returns {number|null} the offset, or null when the caret is elsewhere.
       */
      function caretOffsetIn(node) {
        const state = editor._pendingEditorState ?? editor._editorState
        const selection = state._selection
        if (selection === undefined || selection === null) return null
        const anchor = selection.anchor
        if (anchor === undefined || anchor === null) return null
        if (anchor.type !== 'text' || anchor.key !== node.getKey()) return null
        return anchor.offset
      }

      /**
       * Split one text node at its backtick pairs and turn every code span
       * into a chip. The scan has no left boundary: a backtick opens a code
       * span wherever it stands.
       * @param {object} node - the text node to scan.
       */
      function applyInlineCode(node) {
        const text = node.getTextContent()
        INLINE_RE.lastIndex = 0
        const ranges = []
        let match = INLINE_RE.exec(text)
        while (match !== null) {
          ranges.push([match.index, match.index + match[0].length])
          match = INLINE_RE.exec(text)
        }
        if (ranges.length === 0) return
        const caret = caretOffsetIn(node)
        const offsets = []
        for (const [start, end] of ranges) {
          if (start > 0) offsets.push(start)
          if (end < text.length) offsets.push(end)
        }
        const parts = node.splitText(...offsets)
        let position = 0
        for (const part of parts) {
          const length = part.getTextContent().length
          const start = position
          position += length
          const range = ranges.find(([from, to]) => start >= from && start + length <= to)
          if (range === undefined) continue
          const body = part.getTextContent()
          // The node changed under the scan (the host wrote into it while the
          // transform ran): leave it alone, the next pass sees the new text.
          if (body !== text.slice(start, start + length)) return
          const [open, code, close] = codeSpanNodes(body.slice(1, -1), part.getFormat())
          part.replace(open)
          open.insertAfter(code)
          code.insertAfter(close)
          // The caret sat in the node that was just replaced, so it is lost
          // with it. Put it back where the user left it: inside the code, or
          // behind the closing backtick.
          if (caret === null || caret < start || caret > start + length) continue
          if (caret === start) open.selectStart()
          else if (caret === start + length) close.selectEnd()
          else code.select(caret - start - 1, caret - start - 1)
        }
      }

      /**
       * Move the paragraphs that follow a freshly opened block into it, up to
       * the closing fence line.
       * @param {object} block - the code block.
       */
      function absorbFollowing(block) {
        let sibling = block.getNextSibling()
        let filled = false
        while (sibling !== null) {
          if (sibling.getType() !== 'paragraph') break
          const next = sibling.getNextSibling()
          const children = sibling.getChildren()
          const fence = children.length === 1 && isFenceLine(children[0]) ? children[0] : null
          if (fence !== null) {
            closeWithFence(block, fence)
            return
          }
          if (filled) block.append(new LineBreakClass())
          for (const child of children) block.append(child)
          sibling.remove()
          filled = true
          sibling = next
        }
      }

      /**
       * Close a block with a fence line that already sits in a paragraph.
       * @param {object} block - the code block.
       * @param {object} fence - the fence text node.
       */
      function closeWithFence(block, fence) {
        const paragraph = fence.getParent()
        fence.setStyle(HIDDEN_STYLE)
        const fenceParagraph = new ParagraphClass()
        fenceParagraph.append(fence)
        paragraph.insertBefore(fenceParagraph)
        paragraph.remove()
        fenceLines.add(fenceParagraph.getKey())
        const tail = new ParagraphClass()
        fenceParagraph.insertAfter(tail)
        tail.selectStart()
      }

      /**
       * Split the paragraph that holds a fence line into the text before the
       * fence, the fence line itself, and a code block for the text after it.
       * @param {object} fence - the fence text node.
       */
      function openBlock(fence) {
        const paragraph = fence.getParent()
        if (paragraph === null || paragraph.getType() !== 'paragraph') return
        const previous = fence.getPreviousSibling()
        if (previous !== null && !isBreak(previous)) return
        const before = []
        let cursor = paragraph.getFirstChild()
        while (cursor !== null && cursor !== fence) {
          before.push(cursor)
          cursor = cursor.getNextSibling()
        }
        const after = []
        cursor = fence.getNextSibling()
        while (cursor !== null) {
          const following = cursor.getNextSibling()
          after.push(cursor)
          cursor = following
        }
        // The line breaks around the fence become the gaps between the
        // paragraphs the split produces.
        if (before.length > 0 && isBreak(before[before.length - 1])) before.pop()
        if (after.length > 0 && isBreak(after[0])) after.shift()
        const fenceParagraph = new ParagraphClass()
        const block = new ParagraphClass()
        fence.setStyle(HIDDEN_STYLE)
        fenceParagraph.append(fence)
        for (const node of after) block.append(node)
        paragraph.insertBefore(fenceParagraph)
        fenceParagraph.insertAfter(block)
        if (before.length > 0) {
          const head = new ParagraphClass()
          for (const node of before) head.append(node)
          fenceParagraph.insertBefore(head)
        }
        paragraph.remove()
        fenceLines.add(fenceParagraph.getKey())
        codeBlocks.add(block.getKey())
        absorbFollowing(block)
        // The block gets a line of its own below it, so the rest of the
        // message has somewhere to be written.
        if (block.getNextSibling() === null) block.insertAfter(new ParagraphClass())
        block.selectStart()
      }

      /**
       * Put the caret at the start of a block, once the editor has drawn it.
       * The block is built while the transform runs, and the browser cannot
       * hold a caret in an element that is not in the document yet: the caret
       * would fall out of the block on the next keystroke.
       * @param {object} block - the code block.
       */
      function placeCaretIn(block) {
        queueMicrotask(() => {
          editor.update(() => {
            if (!block.isAttached()) return
            block.selectStart()
          }, { discrete: true })
        })
      }

      /**
       * Close a code block: the fence line leaves the block and the text
       * after it leaves with it.
       * @param {object} fence - the fence text node inside the block.
       */
      function closeBlock(fence) {
        const block = fence.getParent()
        if (block === null || !codeBlocks.has(block.getKey())) return
        const previous = fence.getPreviousSibling()
        if (previous !== null && !isBreak(previous)) return
        const rest = []
        let cursor = fence.getNextSibling()
        while (cursor !== null) {
          const following = cursor.getNextSibling()
          rest.push(cursor)
          cursor = following
        }
        // The block keeps the code up to the fence; the newline in front of
        // the fence becomes the gap between the block and the fence line.
        if (previous !== null && isBreak(previous)) previous.remove()
        fence.setStyle(HIDDEN_STYLE)
        // The line the block got when it opened goes: the fence line and the
        // line for the rest of the message take its place.
        const spare = block.getNextSibling()
        if (spare !== null && spare.getType() === 'paragraph' && spare.getTextContent() === '') spare.remove()
        const fenceParagraph = new ParagraphClass()
        fenceParagraph.append(fence)
        block.insertAfter(fenceParagraph)
        fenceLines.add(fenceParagraph.getKey())
        const tail = new ParagraphClass()
        for (const node of rest) tail.append(node)
        fenceParagraph.insertAfter(tail)
        tail.selectStart()
      }

      /**
       * Paint the fence line and the code box. Both are ordinary paragraphs
       * of the composer, so the class is set on their elements after every
       * draw.
       */
      function paintBlocks() {
        const children = editor.getEditorState().read(() => {
          const root = editor._editorState._nodeMap.get('root')
          return root === undefined ? [] : root.getChildren()
        })
        for (const child of children) {
          const element = editor.getElementByKey(child.getKey())
          if (element === null) continue
          element.classList.toggle(FENCE_CLASS, fenceLines.has(child.getKey()))
          element.classList.toggle(BLOCK_CLASS, codeBlocks.has(child.getKey()))
        }
      }

      /**
       * Drop a fence line whose block is gone. The fence text is what tells
       * the model that the code follows, so a fence without a block is a
       * leftover of a block the user deleted.
       */
      function dropOrphanFences() {
        // The tree is read inside a read: a node cannot be asked for its
        // latest state outside one.
        const orphans = editor.getEditorState().read(() => {
          const root = editor._editorState._nodeMap.get('root')
          if (root === undefined) return []
          const out = []
          for (const child of root.getChildren()) {
            if (!fenceLines.has(child.getKey())) continue
            if (child.getTextContent() !== FENCE) continue
            const previous = child.getPreviousSibling()
            const next = child.getNextSibling()
            const blockBefore = previous !== null && codeBlocks.has(previous.getKey())
            const blockAfter = next !== null && codeBlocks.has(next.getKey())
            if (!blockBefore && !blockAfter) out.push(child.getKey())
          }
          return out
        })
        if (orphans.length === 0) return
        // A deferred update: a discrete one inside the update listener
        // would throw.
        editor.update(() => {
          const state = editor._pendingEditorState ?? editor._editorState
          for (const key of orphans) {
            const orphan = state._nodeMap.get(key)
            if (orphan === undefined) continue
            fenceLines.delete(key)
            orphan.remove()
          }
        })
      }

      editor.registerUpdateListener(() => {
        dropOrphanFences()
        paintBlocks()
      })



      /**
       * A fence line is drawn as nothing, so a caret that ends up in one
       * would take the keystrokes with it. The line shows its text again as
       * soon as the caret is inside it.
       * @param {object} node - the text node the caret may sit in.
       */
      function revealFence(node) {
        const parent = node.getParent()
        if (parent === null) return
        if (!fenceLines.has(parent.getKey())) return
        if (caretOffsetIn(node) === null) return
        node.setStyle('')
        fenceLines.delete(parent.getKey())
        editedFences.add(parent.getKey())
      }

      /**
       * Reveal a fence line the caret is inside. The line is drawn as
       * nothing, so a caret in it would take the keystrokes with it.
       * @param {object} paragraph - the fence line.
       */
      function revealFenceLine(paragraph) {
        if (!fenceLines.has(paragraph.getKey())) return
        for (const child of paragraph.getChildren()) {
          if (child.getType() !== 'text') continue
          revealFence(child)
        }
      }

      editor.registerNodeTransform(TextClass, (node) => {
        applyInlineCode(node)
        if (!node.isAttached()) return
        revealFence(node)
        if (!isFenceLine(node) || isHidden(node)) return
        const parent = node.getParent()
        if (parent === null || parent.getType() !== 'paragraph') return
        // A fence inside a code block closes it; a fence in ordinary text
        // opens one.
        if (codeBlocks.has(parent.getKey())) closeBlock(node)
        else openBlock(node)
      })

      editor.registerNodeTransform(InlineCodeNode, (node) => {
        if (!node.isAttached()) return
        if (isCodeSpan(node)) return
        releaseCodeSpan(node)
      })

      editor.registerNodeTransform(ParagraphClass, (paragraph) => {
        if (!paragraph.isAttached()) return
        // A code block is an ordinary paragraph, and the fence inside it
        // closes the block rather than opening another one.
        if (codeBlocks.has(paragraph.getKey())) return
        const children = paragraph.getChildren()
        // A code span whose backtick was deleted is plain text again; the
        // span itself is not dirty when only a sibling changed.
        for (const child of children) {
          if (child.getType() !== CODE_TYPE) continue
          if (!isCodeSpan(child)) releaseCodeSpan(child)
        }
        revealFenceLine(paragraph)
        if (children.length !== 1) return
        const only = children[0]
        if (!isFenceLine(only) || isHidden(only)) return
        if (editedFences.has(paragraph.getKey())) return
        openBlock(only)
      })

      decorated.add(editor)
    }

    /**
     * Backspace in an empty code box removes the box. Lexical deletes a
     * character, and an empty box has none: the box would stay and the
     * keystroke would do nothing.
     * @param {KeyboardEvent} event - the keydown event.
     */
    function handleBackspace(event) {
      if (event.key !== 'Backspace') return
      const target = event.target
      if (target === null || typeof target.closest !== 'function') return
      const composer = target.closest('[data-composer-input]')
      if (composer === null) return
      const editor = editorOf(composer)
      if (editor === null) return
      const selection = editor.getEditorState()._selection
      if (selection === null || selection === undefined) return
      const anchor = selection.anchor
      if (anchor === undefined || anchor === null) return
      if (!codeBlocks.has(anchor.key)) return
      event.preventDefault()
      editor.update(() => {
        const state = editor._pendingEditorState ?? editor._editorState
        const node = state._nodeMap.get(anchor.key)
        if (node === undefined) return
        if (node.getTextContent() !== '') return
        const previous = node.getPreviousSibling()
        if (previous !== null && fenceLines.has(previous.getKey()) && previous.getTextContent() === FENCE) {
          fenceLines.delete(previous.getKey())
          previous.remove()
        }
        codeBlocks.delete(node.getKey())
        node.remove()
        const root = state._nodeMap.get('root')
        if (root !== undefined) root.selectEnd()
      }, { discrete: true })
    }

    /**
     * Decorate the composer editor whenever the composer shows up.
     */
    /** Composer elements that already carry the key listener. */
    const listened = new WeakSet()

    /**
     * Watch the keystrokes of the composer element. The app replaces the
     * element when the session mounts, so the listener follows the element
     * and not the editor.
     */
    function listenToComposer() {
      const composer = composerElement()
      if (composer === null || listened.has(composer)) return
      listened.add(composer)
      composer.addEventListener('keydown', handleBackspace)
    }

    function watch() {
      listenToComposer()
      installStyles()
      const decorateComposer = () => {
        const editor = editorOf(composerElement())
        if (editor !== null) decorate(editor)
      }
      decorateComposer()
      const observer = new MutationObserver(() => {
        decorateComposer()
        listenToComposer()
      })
      observer.observe(document.documentElement, { childList: true, subtree: true })
    }

    /**
     * Client plugin body: start the watcher once the document is up.
     *
     * @returns {void}
     */
    function apply() {
      if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', watch, { once: true })
      } else {
        watch()
      }
    }

    return { inject: [], apply }
  },
})
