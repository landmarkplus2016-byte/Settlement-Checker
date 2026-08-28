/**
 * lists.js — the Lists tab (CLAUDE.md 3.4, 5.2).
 *
 * Five lists of dropdown options — projects, categories, areas, drivers,
 * months — that the coordinator's grid will offer as in-cell selects (6.6.4).
 *
 * The Lists tab has no primary key, so `update_lists` replaces one named list
 * wholesale. This screen is built to match: a tab strip picks a list, the editor
 * below holds a WORKING COPY of it, and Save pushes the whole thing back. That
 * shape is what makes reordering and removing possible at all — with no row id,
 * there is nothing to send a per-row edit against.
 *
 * Two consequences worth stating:
 *   - Order is meaningful. `sort_order` is assigned from the row's position at
 *     save time, so dragging a common option to the top of the list is a real,
 *     persisted change and not just a local view.
 *   - Edits are unsaved until Save. Switching tabs or leaving with changes
 *     pending asks first — a typed-out list of forty drivers lost to a stray
 *     click would be a bad afternoon.
 *
 * An option is never "deleted" in the app's usual sense, because there is
 * nothing to deactivate against: an entry stores the STRING it was filed under,
 * so removing an option here only takes it off future dropdowns and never
 * rewrites an entry. Deactivating instead of removing is offered too, and is
 * the gentler choice — it keeps the option visible in this editor.
 */

import { api } from '../api.js';
import { t, errorMessage } from '../i18n/i18n.js';
import { escapeHtml, qs, setBusy } from '../utils/dom.js';
import { openModal } from '../components/modal.js';
import { toastSuccess } from '../components/toast.js';
import { renderLoading, renderLoadError } from '../components/table.js';

/** The five lists, in the order the tab strip shows them (CLAUDE.md 2.1). */
const LIST_NAMES = ['projects', 'categories', 'areas', 'drivers', 'months'];

/** Every list as the server last returned it. */
let lists = {};

/** The tab in view. */
let activeList = LIST_NAMES[0];

/** The working copy of `activeList` — what the editor is showing. */
let working = [];

/** True once the working copy differs from what was loaded. */
let dirty = false;

/**
 * The Lists screen.
 * @return {string} HTML
 */
export function renderLists() {
  return `
    <div class="page" id="lists-page">
      <div class="page-title-row">
        <div>
          <h1>${escapeHtml(t('nav_lists'))}</h1>
          <div class="page-subtitle">${escapeHtml(t('lists_subtitle'))}</div>
        </div>
      </div>

      <div id="lists-body">${renderLoading()}</div>
    </div>
  `;
}

/**
 * Wire the screen and load it.
 */
export function bindListsEvents() {
  const page = qs('#lists-page');
  if (!page) return;

  lists = {};
  activeList = LIST_NAMES[0];
  working = [];
  dirty = false;

  page.addEventListener('click', function (event) {
    const trigger = event.target.closest('[data-action]');
    if (!trigger) return;

    const action = trigger.dataset.action;
    const index = trigger.dataset.index === undefined ? -1 : Number(trigger.dataset.index);

    if (action === 'retry') return load();
    if (action === 'tab') return switchTab(trigger.dataset.list);
    if (action === 'add-option') return addOption();
    if (action === 'save') return save();
    if (action === 'revert') return confirmRevert();
    if (action === 'move-up') return moveOption(index, -1);
    if (action === 'move-down') return moveOption(index, 1);
    if (action === 'remove') return removeOption(index);
  });

  // Typing a value or toggling `active` edits the working copy in place. The
  // editor is deliberately NOT re-rendered on input — that would steal the caret
  // out of the box the user is typing in.
  page.addEventListener('input', function (event) {
    const input = event.target.closest('.option-value');
    if (!input) return;

    const index = Number(input.dataset.index);
    if (working[index]) {
      working[index].value = input.value;
      markDirty();
    }
  });

  page.addEventListener('change', function (event) {
    const box = event.target.closest('.option-active');
    if (!box) return;

    const index = Number(box.dataset.index);
    if (working[index]) {
      working[index].active = box.checked;
      markDirty();
    }
  });

  load();
}

/* ------------------------------------------------------------------ *
 * Data
 * ------------------------------------------------------------------ */

/** Fetch all five lists, inactive options included. */
async function load() {
  const body = qs('#lists-body');
  if (!body) return;

  body.innerHTML = renderLoading();

  try {
    const data = await api.call('list_lists', { include_inactive: true });
    lists = (data && data.lists) || {};

    resetWorking();
    body.innerHTML = renderEditor();
  } catch (err) {
    lists = {};
    body.innerHTML = renderLoadError(errorMessage(err));
  }
}

/**
 * Take a fresh working copy of the active list.
 *
 * A deep copy on purpose: the editor mutates rows as the user types, and doing
 * that to the loaded objects would make "revert" impossible.
 */
function resetWorking() {
  const source = lists[activeList] || [];

  working = source.map(function (item) {
    return { value: item.value, active: item.active !== false };
  });

  dirty = false;
}

/** Note that the working copy has diverged, and enable Save. */
function markDirty() {
  if (dirty) return;
  dirty = true;

  const saveEl = qs('#lists-save');
  const revertEl = qs('#lists-revert');
  if (saveEl) saveEl.disabled = false;
  if (revertEl) revertEl.disabled = false;
}

/* ------------------------------------------------------------------ *
 * Rendering
 * ------------------------------------------------------------------ */

/**
 * The tab strip plus the editor for the active list.
 * @return {string} HTML
 */
function renderEditor() {
  return `
    <div class="tabs" role="tablist">
      ${LIST_NAMES.map(function (name) {
        const isActive = name === activeList;
        const count = (lists[name] || []).length;

        return `
          <button class="tab${isActive ? ' is-active' : ''}" type="button" role="tab"
                  aria-selected="${isActive}" data-action="tab" data-list="${name}">
            ${escapeHtml(t('list_' + name))}
            <span class="tab-count num">${count}</span>
          </button>
        `;
      }).join('')}
    </div>

    <div class="card">
      <div class="card-header">
        <span class="card-title">${escapeHtml(t('list_' + activeList))}</span>
        <span class="spacer"></span>
        <button class="btn btn-ghost btn-sm" id="lists-revert" type="button"
                data-action="revert" ${dirty ? '' : 'disabled'}>
          ${escapeHtml(t('list_revert'))}
        </button>
        <button class="btn btn-primary btn-sm" id="lists-save" type="button"
                data-action="save" ${dirty ? '' : 'disabled'}>
          ${escapeHtml(t('save'))}
        </button>
      </div>

      <div class="card-body">
        <div id="lists-options">${renderOptions()}</div>

        <button class="btn btn-secondary btn-sm mt-4" type="button" data-action="add-option">
          ${escapeHtml(t('list_add_option'))}
        </button>
      </div>

      <div class="card-footer text-small text-muted">
        ${escapeHtml(t('list_help'))}
      </div>
    </div>
  `;
}

/**
 * The option rows.
 * @return {string} HTML
 */
function renderOptions() {
  if (!working.length) {
    return `<div class="text-small text-muted">${escapeHtml(t('list_empty_text'))}</div>`;
  }

  return working.map(function (item, index) {
    const last = index === working.length - 1;

    return `
      <div class="option-row">
        <span class="option-index num">${index + 1}</span>

        <input class="input option-value" type="text" maxlength="100"
               data-index="${index}" value="${escapeHtml(item.value)}"
               aria-label="${escapeHtml(t('list_option_value'))}">

        <label class="check-row">
          <input class="option-active" type="checkbox" data-index="${index}"
                 ${item.active ? 'checked' : ''}>
          <span class="text-small">${escapeHtml(t('active'))}</span>
        </label>

        <button class="icon-btn" type="button" data-action="move-up" data-index="${index}"
                title="${escapeHtml(t('list_move_up'))}"
                aria-label="${escapeHtml(t('list_move_up'))}" ${index === 0 ? 'disabled' : ''}>▲</button>

        <button class="icon-btn" type="button" data-action="move-down" data-index="${index}"
                title="${escapeHtml(t('list_move_down'))}"
                aria-label="${escapeHtml(t('list_move_down'))}" ${last ? 'disabled' : ''}>▼</button>

        <button class="icon-btn icon-btn-danger" type="button" data-action="remove" data-index="${index}"
                title="${escapeHtml(t('list_remove'))}"
                aria-label="${escapeHtml(t('list_remove'))}">✕</button>
      </div>
    `;
  }).join('');
}

/**
 * Repaint just the option rows, keeping the tab strip and the header buttons.
 * Called after a structural change — add, remove, reorder — never on a keystroke.
 */
function paintOptions() {
  const host = qs('#lists-options');
  if (host) host.innerHTML = renderOptions();
}

/** Repaint the whole editor — used when the active tab changes. */
function paintEditor() {
  const body = qs('#lists-body');
  if (body) body.innerHTML = renderEditor();
}

/* ------------------------------------------------------------------ *
 * Editing the working copy
 * ------------------------------------------------------------------ */

/**
 * Show a different list, asking first if this one has unsaved edits.
 * @param {string} name
 */
function switchTab(name) {
  if (!name || name === activeList || LIST_NAMES.indexOf(name) === -1) return;

  const go = function () {
    activeList = name;
    resetWorking();
    paintEditor();
  };

  if (!dirty) return go();

  openModal({
    title: t('list_unsaved_title'),
    confirmLabel: t('list_discard'),
    confirmVariant: 'btn-danger',
    bodyHtml: `<p class="text-small text-secondary">${escapeHtml(t('list_unsaved_text'))}</p>`,
    onConfirm: function () { go(); }
  });
}

/** Append an empty option and focus it. */
function addOption() {
  working.push({ value: '', active: true });
  markDirty();
  paintOptions();

  const inputs = document.querySelectorAll('#lists-options .option-value');
  const last = inputs[inputs.length - 1];
  if (last) last.focus();
}

/**
 * Move an option one place up or down. Position IS the stored sort_order, so
 * this is a real edit, not a view preference.
 *
 * @param {number} index
 * @param {number} delta -1 or 1.
 */
function moveOption(index, delta) {
  const target = index + delta;
  if (index < 0 || target < 0 || target >= working.length) return;

  const moved = working[index];
  working[index] = working[target];
  working[target] = moved;

  markDirty();
  paintOptions();
}

/**
 * Drop an option from the list.
 *
 * A blank row goes without asking — it is a mistake being tidied up, not data.
 * A real one asks, and the dialog points out that deactivating is the gentler
 * option.
 *
 * @param {number} index
 */
function removeOption(index) {
  const item = working[index];
  if (!item) return;

  const drop = function () {
    working.splice(index, 1);
    markDirty();
    paintOptions();
  };

  if (!String(item.value).trim()) return drop();

  openModal({
    title: t('list_remove_title'),
    confirmLabel: t('list_remove'),
    confirmVariant: 'btn-danger',
    bodyHtml: `
      <p class="text-small text-secondary">
        ${escapeHtml(t('list_remove_text', { value: item.value }))}
      </p>
      <p class="text-small text-muted mt-4">${escapeHtml(t('list_remove_note'))}</p>
    `,
    onConfirm: function () { drop(); }
  });
}

/** Throw the working copy away and start again from what was loaded. */
function confirmRevert() {
  if (!dirty) return;

  openModal({
    title: t('list_unsaved_title'),
    confirmLabel: t('list_discard'),
    confirmVariant: 'btn-danger',
    bodyHtml: `<p class="text-small text-secondary">${escapeHtml(t('list_revert_text'))}</p>`,
    onConfirm: function () {
      resetWorking();
      paintEditor();
    }
  });
}

/* ------------------------------------------------------------------ *
 * Saving
 * ------------------------------------------------------------------ */

/**
 * Push the working copy back as the whole list.
 *
 * Validated here first because the server is all-or-nothing on a list — one bad
 * option rejects the save — and pointing at the offending row is far more useful
 * than a generic failure. `sort_order` comes from position, which is what makes
 * the reorder buttons mean anything.
 */
async function save() {
  const saveEl = qs('#lists-save');

  const items = [];
  const seen = {};

  for (let i = 0; i < working.length; i++) {
    const value = String(working[i].value || '').trim();

    if (!value) {
      return showSaveError(t('list_value_required', { row: i + 1 }));
    }

    const key = value.toLowerCase();
    if (Object.prototype.hasOwnProperty.call(seen, key)) {
      return showSaveError(t('list_duplicate', { value: value }));
    }
    seen[key] = true;

    items.push({ value: value, active: working[i].active !== false, sort_order: i + 1 });
  }

  setBusy(saveEl, true, t('save'), t('saving'));

  try {
    const data = await api.call('update_lists', { list_name: activeList, items: items });

    // Take the server's answer as the new truth rather than assuming ours stuck.
    lists = (data && data.lists) || lists;
    resetWorking();
    paintEditor();

    toastSuccess(t('list_saved', { list: t('list_' + activeList) }));

  } catch (err) {
    setBusy(saveEl, false, t('save'), t('saving'));
    showSaveError(errorMessage(err));
  }
}

/**
 * Report a save problem without losing the editor's contents.
 * @param {string} message already translated.
 */
function showSaveError(message) {
  openModal({
    title: t('list_save_failed_title'),
    cancelLabel: t('close'),
    bodyHtml: `<p class="text-small text-secondary">${escapeHtml(message)}</p>`
  });
}
