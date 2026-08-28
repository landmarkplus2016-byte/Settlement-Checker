/**
 * modal.js — the one dialog primitive (CLAUDE.md 8.4).
 *
 * Every admin screen needs the same shape: a titled panel, a form body, an
 * error line, and Cancel / Confirm. Rather than each screen growing its own,
 * they all call openModal() and hand it a body plus an `onConfirm`.
 *
 * Two things it does that are easy to get wrong by hand:
 *   - The body is a <form>, so Enter submits and the browser's own focus
 *     handling applies. A dialog you cannot dismiss with the keyboard is a
 *     dialog somebody will fight with fifty times a day.
 *   - `onConfirm` may throw. An ApiError thrown inside it is caught here and
 *     shown on the modal's own error line, so a failed save leaves the typed
 *     values on screen instead of closing and losing them.
 *
 * Only one modal is open at a time; opening a second closes the first.
 */

import { t, errorMessage } from '../i18n/i18n.js';
import { escapeHtml, setBusy } from '../utils/dom.js';

const HOST_ID = 'sc-modal-host';

/** The open dialog's backdrop, or null. */
let current = null;

/** What had focus before the modal opened, so it can be given back. */
let previousFocus = null;

/**
 * Open a dialog.
 *
 * @param {Object} options
 * @param {string} options.title already translated.
 * @param {string} [options.bodyHtml] the form's contents.
 * @param {string} [options.confirmLabel] already translated; omitted renders no
 *   confirm button, making this a read-only dialog.
 * @param {string} [options.confirmVariant='btn-primary'] 'btn-primary' | 'btn-danger'.
 * @param {string} [options.cancelLabel] defaults to t('cancel').
 * @param {boolean} [options.wide=false] the 640px panel, for the import preview.
 * @param {Function} [options.onOpen] called as onOpen(ctx) once the DOM exists —
 *   for wiring anything inside the body.
 * @param {Function} [options.onConfirm] async onConfirm(ctx). Returning `false`
 *   keeps the dialog open (a validation failure the screen has already shown);
 *   anything else closes it. A thrown error is shown on the error line.
 * @param {Function} [options.onClose] called after the dialog is removed.
 * @return {Object} the same `ctx` the callbacks receive.
 */
export function openModal(options) {
  const opts = options || {};

  closeModal();
  previousFocus = document.activeElement;

  const confirmLabel = opts.confirmLabel || '';
  const cancelLabel = opts.cancelLabel || t('cancel');
  const confirmVariant = opts.confirmVariant || 'btn-primary';

  const backdrop = document.createElement('div');
  backdrop.className = 'modal-backdrop';
  backdrop.innerHTML = `
    <div class="modal${opts.wide ? ' modal-lg' : ''}" role="dialog" aria-modal="true"
         aria-labelledby="sc-modal-title">

      <div class="modal-header">
        <span class="modal-title" id="sc-modal-title">${escapeHtml(opts.title || '')}</span>
        <span class="spacer"></span>
        <button class="modal-close" type="button" data-modal-cancel
                aria-label="${escapeHtml(t('close'))}">&times;</button>
      </div>

      <form novalidate>
        <div class="modal-body">
          <div class="alert alert-danger hidden" data-modal-error role="alert"></div>
          ${opts.bodyHtml || ''}
        </div>

        <div class="modal-footer">
          <button class="btn btn-secondary" type="button" data-modal-cancel>
            ${escapeHtml(cancelLabel)}
          </button>
          ${confirmLabel ? `
            <button class="btn ${confirmVariant}" type="submit" data-modal-confirm>
              ${escapeHtml(confirmLabel)}
            </button>
          ` : ''}
        </div>
      </form>
    </div>
  `;

  host().appendChild(backdrop);
  current = backdrop;

  const form = backdrop.querySelector('form');
  const errorEl = backdrop.querySelector('[data-modal-error]');
  const confirmEl = backdrop.querySelector('[data-modal-confirm]');

  /** The handle passed to every callback. */
  const ctx = {
    root: backdrop,

    /** @param {string} selector @return {Element|null} */
    find: function (selector) { return backdrop.querySelector(selector); },

    /**
     * The trimmed value of a field in the body.
     * @param {string} selector
     * @return {string}
     */
    value: function (selector) {
      const el = backdrop.querySelector(selector);
      return el ? String(el.value || '').trim() : '';
    },

    /**
     * A checkbox's state.
     * @param {string} selector
     * @return {boolean}
     */
    checked: function (selector) {
      const el = backdrop.querySelector(selector);
      return !!(el && el.checked);
    },

    /** @param {string} message already translated; '' clears the line. */
    setError: function (message) {
      if (!errorEl) return;
      errorEl.textContent = message || '';
      errorEl.classList.toggle('hidden', !message);
    },

    /** @param {boolean} busy */
    setBusy: function (busy) {
      if (!confirmEl || !confirmEl.isConnected) return;
      setBusy(confirmEl, busy, confirmLabel, t('saving'));
    },

    close: closeModal
  };

  // Cancel — the × and the footer button share the attribute.
  backdrop.addEventListener('click', function (event) {
    if (event.target.closest('[data-modal-cancel]')) {
      event.preventDefault();
      closeModal();
      return;
    }
    // A click on the backdrop itself, outside the panel, dismisses too.
    if (event.target === backdrop) closeModal();
  });

  if (form) {
    form.addEventListener('submit', async function (event) {
      event.preventDefault();
      if (typeof opts.onConfirm !== 'function') return closeModal();

      ctx.setError('');
      ctx.setBusy(true);

      try {
        const result = await opts.onConfirm(ctx);
        if (result !== false) closeModal();
      } catch (err) {
        // The screen's job was the call; showing why it failed is ours. The
        // typed values stay on screen so the user can correct and retry.
        ctx.setError(errorMessage(err));
      } finally {
        ctx.setBusy(false);
      }
    });
  }

  document.addEventListener('keydown', onKeydown);
  backdrop._onClose = opts.onClose || null;

  if (typeof opts.onOpen === 'function') opts.onOpen(ctx);

  // Focus the first real control, or the confirm button when the body has none.
  const firstField = backdrop.querySelector(
    '.modal-body input:not([type="hidden"]), .modal-body select, .modal-body textarea'
  );
  (firstField || confirmEl || backdrop.querySelector('[data-modal-cancel]')).focus();

  return ctx;
}

/** Close the open dialog, if any. */
export function closeModal() {
  if (!current) return;

  const onClose = current._onClose;

  document.removeEventListener('keydown', onKeydown);
  current.remove();
  current = null;

  if (previousFocus && typeof previousFocus.focus === 'function' && previousFocus.isConnected) {
    previousFocus.focus();
  }
  previousFocus = null;

  if (typeof onClose === 'function') onClose();
}

/** @return {boolean} */
export function isModalOpen() {
  return current !== null;
}

/**
 * Escape closes. Tab is left to the browser: the modal is the last thing in the
 * DOM, so the natural tab order already runs through it before wrapping.
 * @param {KeyboardEvent} event
 */
function onKeydown(event) {
  if (event.key === 'Escape') {
    event.preventDefault();
    closeModal();
  }
}

/**
 * The modal's container, outside #app so a screen re-render underneath cannot
 * tear an open dialog out from under the user.
 * @return {HTMLElement}
 */
function host() {
  let el = document.getElementById(HOST_ID);
  if (!el) {
    el = document.createElement('div');
    el.id = HOST_ID;
    document.body.appendChild(el);
  }
  return el;
}
