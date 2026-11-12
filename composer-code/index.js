/**
 * Host half of the composer-code bundle.
 *
 * The feature is entirely browser-side: the composer of the Web UI is a
 * Lexical editor, and the browser half decorates that editor so that inline
 * code and code fences look the way they look in Codex. Nothing about the
 * message that leaves the composer changes, so this half has no host
 * behaviour at all.
 *
 * This half exists because a package becomes a browser module only while the
 * Host holds a Loader entry for it, and this row is what makes the Host
 * publish `client.js` to the Web UI.
 */

/**
 * Host plugin body: no host behaviour.
 *
 * @returns {void}
 */
export function apply() {}
