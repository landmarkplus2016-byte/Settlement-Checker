/**
 * dom.js — the few DOM helpers every screen uses.
 *
 * Screens are plain functions returning HTML strings, inserted with innerHTML
 * (CLAUDE.md 5.3). That makes escapeHtml() not a nicety but the thing standing
 * between a display name from the Sheet and injected markup: any value that did
 * not come from t() goes through it.
 */

/**
 * The single mount point from index.html.
 * @return {HTMLElement}
 */
export function appRoot() {
  return document.getElementById('app');
}

/**
 * @param {string} selector
 * @param {ParentNode} [root=document]
 * @return {Element|null}
 */
export function qs(selector, root) {
  return (root || document).querySelector(selector);
}

/**
 * @param {string} selector
 * @param {ParentNode} [root=document]
 * @return {Array<Element>}
 */
export function qsa(selector, root) {
  return Array.from((root || document).querySelectorAll(selector));
}

/**
 * Replace the app's contents with a rendered screen.
 * @param {string} html
 */
export function mount(html) {
  const root = appRoot();
  if (root) root.innerHTML = html;
}

/**
 * Escape a value for interpolation into an HTML string.
 * @param {*} value
 * @return {string}
 */
export function escapeHtml(value) {
  if (value === null || value === undefined) return '';
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * Show or hide an element's text without re-rendering the screen.
 * @param {Element|null} el
 * @param {string} text '' hides the element.
 */
export function setMessage(el, text) {
  if (!el) return;
  el.textContent = text || '';
  el.classList.toggle('hidden', !text);
}

/**
 * Put a form into or out of its "working" state: disable the submit button and
 * swap its label for a spinner and a progress word.
 *
 * @param {HTMLButtonElement|null} button
 * @param {boolean} busy
 * @param {string} label the idle label.
 * @param {string} busyLabel the in-progress label.
 */
export function setBusy(button, busy, label, busyLabel) {
  if (!button) return;
  button.disabled = busy;
  button.innerHTML = busy
    ? '<span class="spinner spinner-on-primary"></span>' + escapeHtml(busyLabel)
    : escapeHtml(label);
}
