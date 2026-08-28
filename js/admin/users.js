/**
 * users.js — the People tab (CLAUDE.md 3.4, 5.2).
 *
 * The Users tab of the config sheet is two things at once: the account list AND
 * the coordinator → spreadsheet registry (2.1). This screen edits both, and the
 * three rules that fall out of that shape run through the whole file:
 *
 *   - **A sheet id is write-only.** No Sheet ID ever leaves the Apps Script
 *     (rule 3), so `list_users` returns a boolean — is a sheet wired up or not —
 *     and never the id. A manager can SET one and can REPLACE one, but cannot
 *     read back what is stored. The edit dialog says so rather than showing an
 *     empty box that looks like data was lost.
 *
 *   - **A coordinator needs a sheet; a manager must not have one.** An account
 *     without one can sign in and then fail on every action, so it is required
 *     at creation. Promoting a coordinator to manager clears the id server-side,
 *     which is why this screen simply omits the field for managers.
 *
 *   - **The last active manager cannot be deactivated** (rule 25). That is
 *     enforced server-side and surfaces here as a plain sentence, not a stack
 *     trace.
 *
 * Passwords are SHA-256'd in the browser before they are sent (rule 7), exactly
 * as on the login and change-password screens. No plain-text password is ever
 * put in a payload, and both fields are cleared as soon as the call succeeds.
 */

import { api } from '../api.js';
import { t, errorMessage, getLang } from '../i18n/i18n.js';
import { escapeHtml, qs } from '../utils/dom.js';
import { getUser } from '../state.js';
import { sha256Hex } from '../utils/hash.js';
import { formatDateTime } from '../utils/dates.js';
import { openModal } from '../components/modal.js';
import { toastSuccess, toastError } from '../components/toast.js';
import { renderLoading, renderLoadError, renderEmpty, renderActiveBadge } from '../components/table.js';
import { MIN_PASSWORD_LENGTH } from '../auth/changePassword.js';

/** Every user from the last load. */
let users = [];

/**
 * The People screen.
 * @return {string} HTML
 */
export function renderUsers() {
  return `
    <div class="page" id="people-page">
      <div class="page-title-row">
        <div>
          <h1>${escapeHtml(t('nav_people'))}</h1>
          <div class="page-subtitle">${escapeHtml(t('people_subtitle'))}</div>
        </div>
        <span class="spacer"></span>
        <button class="btn btn-primary" type="button" data-action="add">
          ${escapeHtml(t('user_add'))}
        </button>
      </div>

      <div class="card">
        <div id="people-body">${renderLoading()}</div>
      </div>
    </div>
  `;
}

/**
 * Wire the screen and load it.
 */
export function bindUsersEvents() {
  const page = qs('#people-page');
  if (!page) return;

  users = [];

  page.addEventListener('click', function (event) {
    const trigger = event.target.closest('[data-action]');
    if (!trigger) return;

    const action = trigger.dataset.action;
    const user = findUser(trigger.dataset.userId);

    if (action === 'retry') return load();
    if (action === 'add') return openUserDialog(null);
    if (action === 'edit' && user) return openUserDialog(user);
    if (action === 'password' && user) return openResetPasswordDialog(user);
    if (action === 'toggle' && user) return toggleUser(user);
  });

  load();
}

/* ------------------------------------------------------------------ *
 * Data
 * ------------------------------------------------------------------ */

/** Fetch the registry, deactivated people included. */
async function load() {
  const body = qs('#people-body');
  if (!body) return;

  body.innerHTML = renderLoading();

  try {
    const data = await api.call('list_users', { include_inactive: true });
    users = (data && data.users) || [];
    body.innerHTML = renderBody();
  } catch (err) {
    users = [];
    body.innerHTML = renderLoadError(errorMessage(err));
  }
}

/**
 * @param {string} userId
 * @return {Object|null}
 */
function findUser(userId) {
  if (!userId) return null;
  return users.find(function (user) { return user.user_id === userId; }) || null;
}

/**
 * The name to show — the Arabic one in Arabic, when the account has one.
 * @param {Object} user
 * @return {string}
 */
function nameOf(user) {
  if (getLang() === 'ar' && user.display_name_ar) return user.display_name_ar;
  return user.display_name || user.username;
}

/** @return {string} the signed-in manager's user_id. */
function myId() {
  const me = getUser();
  return (me && me.user_id) || '';
}

/* ------------------------------------------------------------------ *
 * Rendering
 * ------------------------------------------------------------------ */

/**
 * @return {string} HTML
 */
function renderBody() {
  if (!users.length) {
    return renderEmpty(t('people_empty_title'), t('people_empty_text'), '☰');
  }

  return `
    <div class="table-wrap">
      <table class="table">
        <thead>
          <tr>
            <th>${escapeHtml(t('col_name'))}</th>
            <th>${escapeHtml(t('col_username'))}</th>
            <th>${escapeHtml(t('col_role'))}</th>
            <th>${escapeHtml(t('col_sheet'))}</th>
            <th>${escapeHtml(t('status'))}</th>
            <th>${escapeHtml(t('col_last_login'))}</th>
            <th class="col-actions"><span class="sr-only">${escapeHtml(t('actions'))}</span></th>
          </tr>
        </thead>
        <tbody>
          ${users.map(renderRow).join('')}
        </tbody>
      </table>
    </div>
  `;
}

/**
 * One person.
 *
 * The Sheet column is the registry made visible: a coordinator with no sheet is
 * an account that cannot do anything, and this is where that shows up.
 *
 * @param {Object} user
 * @return {string} HTML
 */
function renderRow(user) {
  const id = escapeHtml(user.user_id);
  const isCoordinator = user.role === 'coordinator';
  const isMe = user.user_id === myId();

  let sheetCell;
  if (!isCoordinator) {
    sheetCell = `<span class="text-muted">—</span>`;
  } else if (user.coordinator_sheet_configured) {
    sheetCell = `<span class="badge badge-approved">${escapeHtml(t('user_sheet_configured'))}</span>`;
  } else {
    sheetCell = `<span class="badge badge-returned">${escapeHtml(t('user_sheet_missing'))}</span>`;
  }

  return `
    <tr>
      <td>
        <span class="text-bold">${escapeHtml(nameOf(user))}</span>
        ${isMe ? `<span class="badge badge-neutral">${escapeHtml(t('user_you'))}</span>` : ''}
        ${user.force_password_change
          ? `<span class="badge badge-old">${escapeHtml(t('user_must_change_password'))}</span>`
          : ''}
      </td>
      <td class="num">${escapeHtml(user.username)}</td>
      <td>
        <span class="badge ${isCoordinator ? 'badge-neutral' : 'badge-confirmed'}">
          ${escapeHtml(t(isCoordinator ? 'role_coordinator' : 'role_manager'))}
        </span>
      </td>
      <td>${sheetCell}</td>
      <td>${renderActiveBadge(user.active)}</td>
      <td class="num text-small text-muted">${escapeHtml(formatDateTime(user.last_login_at, t('never')))}</td>
      <td class="col-actions">
        <div class="cell-actions">
          <button class="btn btn-secondary btn-sm" type="button"
                  data-action="edit" data-user-id="${id}">
            ${escapeHtml(t('edit'))}
          </button>
          <button class="btn btn-ghost btn-sm" type="button"
                  data-action="password" data-user-id="${id}">
            ${escapeHtml(t('user_reset_password'))}
          </button>
          <button class="btn btn-ghost btn-sm" type="button"
                  data-action="toggle" data-user-id="${id}">
            ${escapeHtml(user.active ? t('deactivate') : t('activate'))}
          </button>
        </div>
      </td>
    </tr>
  `;
}

/* ------------------------------------------------------------------ *
 * Add / edit
 * ------------------------------------------------------------------ */

/**
 * Create a person, or edit one.
 *
 * The password fields exist only when creating: changing an existing person's
 * password is `reset_user_password`, which is a different act with a different
 * consequence (it ends their session and forces them to pick a new one), and
 * folding it into "save these details" would make that consequence invisible.
 *
 * @param {Object|null} user null to create.
 */
function openUserDialog(user) {
  const editing = !!user;
  const role = editing ? user.role : 'coordinator';

  openModal({
    title: editing ? t('user_edit') : t('user_add'),
    confirmLabel: editing ? t('save') : t('add'),
    wide: true,

    bodyHtml: `
      <div class="form-grid">
        <div class="field">
          <label class="label" for="user-name">${escapeHtml(t('user_display_name'))}</label>
          <input class="input" id="user-name" type="text" maxlength="100"
                 value="${escapeHtml(editing ? user.display_name : '')}">
        </div>

        <div class="field">
          <label class="label" for="user-name-ar">${escapeHtml(t('user_display_name_ar'))}</label>
          <input class="input" id="user-name-ar" type="text" maxlength="100" dir="rtl"
                 value="${escapeHtml(editing ? user.display_name_ar : '')}">
        </div>

        <div class="field">
          <label class="label" for="user-username">${escapeHtml(t('col_username'))}</label>
          <input class="input num" id="user-username" type="text" maxlength="60"
                 autocomplete="off" autocapitalize="none" spellcheck="false"
                 value="${escapeHtml(editing ? user.username : '')}">
          <span class="field-hint">${escapeHtml(t('user_username_hint'))}</span>
        </div>

        <div class="field">
          <label class="label" for="user-role">${escapeHtml(t('col_role'))}</label>
          <select class="select" id="user-role">
            <option value="coordinator"${role === 'coordinator' ? ' selected' : ''}>
              ${escapeHtml(t('role_coordinator'))}
            </option>
            <option value="manager"${role === 'manager' ? ' selected' : ''}>
              ${escapeHtml(t('role_manager'))}
            </option>
          </select>
        </div>

        <div class="field field-full${role === 'coordinator' ? '' : ' hidden'}" id="user-sheet-field">
          <label class="label" for="user-sheet">${escapeHtml(t('user_sheet_id'))}</label>
          <input class="input num" id="user-sheet" type="text"
                 autocomplete="off" spellcheck="false"
                 placeholder="${escapeHtml(t('user_sheet_placeholder'))}">
          <span class="field-hint" id="user-sheet-hint">${escapeHtml(sheetHint(user))}</span>
        </div>

        ${editing ? '' : `
          <div class="field">
            <label class="label" for="user-password">${escapeHtml(t('user_password'))}</label>
            <input class="input" id="user-password" type="password" autocomplete="new-password">
            <span class="field-hint">${escapeHtml(t('change_password_hint', { min: MIN_PASSWORD_LENGTH }))}</span>
          </div>

          <div class="field">
            <label class="label" for="user-password-2">${escapeHtml(t('user_password_confirm'))}</label>
            <input class="input" id="user-password-2" type="password" autocomplete="new-password">
          </div>

          <div class="field field-full">
            <label class="check-row">
              <input type="checkbox" id="user-force-change" checked>
              <span>${escapeHtml(t('user_force_password_change'))}</span>
            </label>
          </div>
        `}
      </div>
    `,

    onOpen: function (ctx) {
      // The sheet id belongs to coordinators only, so the field follows the role
      // select rather than sitting there confusing a manager.
      const roleEl = ctx.find('#user-role');
      const field = ctx.find('#user-sheet-field');
      const hint = ctx.find('#user-sheet-hint');

      if (!roleEl || !field) return;

      roleEl.addEventListener('change', function () {
        const isCoordinator = roleEl.value === 'coordinator';
        field.classList.toggle('hidden', !isCoordinator);

        // Promoting an existing coordinator drops their sheet id server-side.
        if (hint && editing) {
          hint.textContent = isCoordinator ? sheetHint(user) : t('user_sheet_cleared_hint');
        }
      });
    },

    onConfirm: async function (ctx) {
      const displayName = ctx.value('#user-name');
      const displayNameAr = ctx.value('#user-name-ar');
      const username = ctx.value('#user-username');
      const nextRole = ctx.value('#user-role');
      const sheetId = ctx.value('#user-sheet');

      if (!displayName) {
        ctx.setError(t('user_display_name_required'));
        return false;
      }
      if (!username) {
        ctx.setError(t('user_username_required'));
        return false;
      }
      if (/\s/.test(username)) {
        ctx.setError(t('user_username_no_spaces'));
        return false;
      }

      if (editing) {
        return saveEdit(ctx, user, {
          display_name: displayName,
          display_name_ar: displayNameAr,
          username: username,
          role: nextRole,
          sheet_id: sheetId
        });
      }

      return saveNew(ctx, {
        display_name: displayName,
        display_name_ar: displayNameAr,
        username: username,
        role: nextRole,
        sheet_id: sheetId
      });
    }
  });
}

/**
 * What to tell the manager about the sheet id box.
 * @param {Object|null} user
 * @return {string}
 */
function sheetHint(user) {
  if (!user) return t('user_sheet_hint_new');
  return user.coordinator_sheet_configured ? t('user_sheet_hint_keep') : t('user_sheet_hint_new');
}

/**
 * Create.
 * @param {Object} ctx the modal handle.
 * @param {Object} values
 * @return {Promise<boolean|undefined>} false keeps the dialog open.
 */
async function saveNew(ctx, values) {
  if (values.role === 'coordinator' && !values.sheet_id) {
    ctx.setError(t('user_sheet_required'));
    return false;
  }

  const passwordEl = ctx.find('#user-password');
  const confirmEl = ctx.find('#user-password-2');
  const password = passwordEl ? passwordEl.value : '';
  const confirmation = confirmEl ? confirmEl.value : '';

  if (!password) {
    ctx.setError(t('change_password_required'));
    return false;
  }
  if (password.length < MIN_PASSWORD_LENGTH) {
    ctx.setError(t('change_password_too_short', { min: MIN_PASSWORD_LENGTH }));
    return false;
  }
  if (password !== confirmation) {
    ctx.setError(t('change_password_mismatch'));
    if (confirmEl) confirmEl.value = '';
    return false;
  }

  const payload = {
    username: values.username,
    display_name: values.display_name,
    display_name_ar: values.display_name_ar,
    role: values.role,
    password_hash: await sha256Hex(password),
    force_password_change: ctx.checked('#user-force-change')
  };

  // A manager row must carry no sheet id at all; sending an empty string is
  // still sending the field, so the key is simply left out.
  if (values.role === 'coordinator') payload.coordinator_sheet_id = values.sheet_id;

  await api.call('create_user', payload);

  // The plain-text password never leaves this function; wipe it from the DOM
  // the moment it is no longer needed.
  if (passwordEl) passwordEl.value = '';
  if (confirmEl) confirmEl.value = '';

  toastSuccess(t('user_created'));
  load();
}

/**
 * Edit.
 *
 * Only what actually changed is sent — `update_user` is a PATCH, and an absent
 * key means "leave it alone". That is what lets the sheet id stay write-only:
 * omitting it keeps whatever the server holds.
 *
 * @param {Object} ctx the modal handle.
 * @param {Object} user the current row.
 * @param {Object} values
 * @return {Promise<boolean|undefined>} false keeps the dialog open.
 */
async function saveEdit(ctx, user, values) {
  const becomingCoordinator = values.role === 'coordinator';

  // A coordinator with no sheet on file must be given one; a coordinator who
  // already has one may leave the box blank to keep it.
  if (becomingCoordinator && !user.coordinator_sheet_configured && !values.sheet_id) {
    ctx.setError(t('user_sheet_required'));
    return false;
  }

  const patch = { user_id: user.user_id };

  if (values.username !== user.username) patch.username = values.username;
  if (values.display_name !== user.display_name) patch.display_name = values.display_name;
  if (values.display_name_ar !== user.display_name_ar) patch.display_name_ar = values.display_name_ar;
  if (values.role !== user.role) patch.role = values.role;

  // Sent only when a NEW id was typed. For a manager it is never sent at all —
  // the server clears any stale id on the role change by itself.
  if (becomingCoordinator && values.sheet_id) patch.coordinator_sheet_id = values.sheet_id;

  if (Object.keys(patch).length === 1) {
    // Nothing to save.
    return;
  }

  await api.call('update_user', patch);
  toastSuccess(t('user_updated'));
  load();
}

/* ------------------------------------------------------------------ *
 * Password and activation
 * ------------------------------------------------------------------ */

/**
 * Set someone else's password.
 *
 * The server raises `force_password_change` on a manager-issued reset and ends
 * that person's session, so the password set here is temporary by design. The
 * dialog says both things — a manager handing over a password should know the
 * person will be asked to replace it.
 *
 * @param {Object} user
 */
function openResetPasswordDialog(user) {
  openModal({
    title: t('user_reset_password_title'),
    confirmLabel: t('user_reset_password'),

    bodyHtml: `
      <div class="stack">
        <p class="text-small text-secondary">
          ${escapeHtml(t('user_reset_password_text', { name: nameOf(user) }))}
        </p>

        <div class="field">
          <label class="label" for="reset-password">${escapeHtml(t('user_password'))}</label>
          <input class="input" id="reset-password" type="password" autocomplete="new-password">
          <span class="field-hint">${escapeHtml(t('change_password_hint', { min: MIN_PASSWORD_LENGTH }))}</span>
        </div>

        <div class="field">
          <label class="label" for="reset-password-2">${escapeHtml(t('user_password_confirm'))}</label>
          <input class="input" id="reset-password-2" type="password" autocomplete="new-password">
        </div>

        <div class="alert alert-warning">${escapeHtml(t('user_reset_password_note'))}</div>
      </div>
    `,

    onConfirm: async function (ctx) {
      const passwordEl = ctx.find('#reset-password');
      const confirmEl = ctx.find('#reset-password-2');
      const password = passwordEl ? passwordEl.value : '';
      const confirmation = confirmEl ? confirmEl.value : '';

      if (!password) {
        ctx.setError(t('change_password_required'));
        return false;
      }
      if (password.length < MIN_PASSWORD_LENGTH) {
        ctx.setError(t('change_password_too_short', { min: MIN_PASSWORD_LENGTH }));
        return false;
      }
      if (password !== confirmation) {
        ctx.setError(t('change_password_mismatch'));
        if (confirmEl) confirmEl.value = '';
        return false;
      }

      await api.call('reset_user_password', {
        user_id: user.user_id,
        password_hash: await sha256Hex(password)
      });

      if (passwordEl) passwordEl.value = '';
      if (confirmEl) confirmEl.value = '';

      toastSuccess(t('user_password_reset'));
      load();
    }
  });
}

/**
 * Deactivate or reactivate.
 *
 * Deactivation is how a person leaves — the row and everything attached to it
 * stays (2.1). The server refuses to deactivate the last active manager
 * (rule 25); that comes back as a `conflict` and lands on the dialog's error
 * line, which is why the confirm step exists even though nothing is destroyed.
 *
 * @param {Object} user
 */
function toggleUser(user) {
  const next = !user.active;

  if (next) {
    return setUserActive(user, true).catch(function (err) {
      toastError(errorMessage(err));
    });
  }

  const isMe = user.user_id === myId();

  openModal({
    title: t('user_deactivate_title'),
    confirmLabel: t('deactivate'),
    confirmVariant: 'btn-danger',

    bodyHtml: `
      <p class="text-small text-secondary">
        ${escapeHtml(t('user_deactivate_text', { name: nameOf(user) }))}
      </p>
      ${isMe ? `<div class="alert alert-warning mt-4">${escapeHtml(t('user_deactivate_self'))}</div>` : ''}
    `,

    onConfirm: function () { return setUserActive(user, false); }
  });
}

/**
 * @param {Object} user
 * @param {boolean} active
 */
async function setUserActive(user, active) {
  await api.call('deactivate_user', { user_id: user.user_id, active: active });
  toastSuccess(t(active ? 'user_activated' : 'user_deactivated'));
  load();
}
