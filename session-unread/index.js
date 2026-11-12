/**
 * Host half of the session-unread bundle.
 *
 * The feature is entirely browser-side. The marked-unread set is local
 * browsing state: it is the user's own "I have not read this yet" note, it
 * never reaches the Host, and it is not shared with another browser or
 * device. That is the same boundary the shipped completion marker lives
 * behind ("completion-time > last-seen never reaches the host").
 *
 * This half therefore does nothing. It exists because a package becomes a
 * browser module only while the Host holds a Loader entry for it, and this
 * row is what makes the Host publish `client.js` to the Web UI.
 */

/**
 * Host plugin body: no host behaviour.
 *
 * @returns {void}
 */
export function apply() {}
