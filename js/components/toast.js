/**
 * toast.js — brief, non-blocking feedback.
 *
 * Lives outside #app so a screen re-render never wipes a toast mid-flight.
 * Callers pass an already-translated string (rule 22 is the caller's job).
 */

import { escapeHtml } from '../utils/dom.js';

const HOST_ID = 'sc-toast-host';
const DEFAULT_MS = 3200;

/**
 * @return {HTMLElement} the toast container, created on first use.
 */
function host() {
  let el = document.getElementById(HOST_ID);
  if (!el) {
    el = document.createElement('div');
    el.id = HOST_ID;
    el.className = 'toast-host';
    el.setAttribute('role', 'status');
    el.setAttribute('aria-live', 'polite');
    document.body.appendChild(el);
  }
  return el;
}

/**
 * Show a toast.
 * @param {string} message already translated.
 * @param {string} [variant='info'] 'info' | 'success' | 'error' | 'warning'
 * @param {number} [ms=3200] time on screen.
 */
export function showToast(message, variant = 'info', ms = DEFAULT_MS) {
  const el = document.createElement('div');
  el.className = 'toast toast-' + variant;
  el.innerHTML = escapeHtml(message);

  host().appendChild(el);

  window.setTimeout(function () {
    el.classList.add('is-leaving');
    window.setTimeout(function () { el.remove(); }, 220);
  }, ms);
}

/** @param {string} message */
export function toastSuccess(message) { showToast(message, 'success'); }

/** @param {string} message */
export function toastError(message) { showToast(message, 'error', 4200); }
