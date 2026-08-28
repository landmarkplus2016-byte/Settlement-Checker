/**
 * teams.js — the Teams admin tab (CLAUDE.md 3.4, 5.2).
 *
 * The simplest of the four admin screens, and the one that sets the pattern the
 * other three follow:
 *
 *   renderTeams()      returns the page shell with a loading body, synchronously,
 *                      because the router paints a string (5.3).
 *   bindTeamsEvents()  attaches ONE delegated listener to the page and then
 *                      fetches. Every later refresh repaints only the body, so
 *                      the listener is never re-attached and never leaks.
 *
 * There is no delete. A team is deactivated, never removed (CLAUDE.md 2.1):
 * entries already filed under a team must keep resolving its name, so the row
 * has to stay. Inactive teams still show here — that is the only way to turn one
 * back on.
 */

import { api } from '../api.js';
import { t, errorMessage } from '../i18n/i18n.js';
import { escapeHtml, qs } from '../utils/dom.js';
import { openModal } from '../components/modal.js';
import { toastSuccess, toastError } from '../components/toast.js';
import { renderLoading, renderLoadError, renderEmpty, renderActiveBadge } from '../components/table.js';

/** The last loaded teams, so a row action can find its record without a refetch. */
let teams = [];

/**
 * The Teams screen.
 * @return {string} HTML
 */
export function renderTeams() {
  return `
    <div class="page" id="teams-page">
      <div class="page-title-row">
        <div>
          <h1>${escapeHtml(t('nav_teams'))}</h1>
          <div class="page-subtitle">${escapeHtml(t('teams_subtitle'))}</div>
        </div>
        <span class="spacer"></span>
        <button class="btn btn-primary" type="button" data-action="add">
          ${escapeHtml(t('team_add'))}
        </button>
      </div>

      <div class="card">
        <div id="teams-body">${renderLoading()}</div>
      </div>
    </div>
  `;
}

/**
 * Wire the screen and load it.
 */
export function bindTeamsEvents() {
  const page = qs('#teams-page');
  if (!page) return;

  teams = [];

  page.addEventListener('click', function (event) {
    const trigger = event.target.closest('[data-action]');
    if (!trigger) return;

    const action = trigger.dataset.action;
    const team = findTeam(trigger.dataset.teamId);

    if (action === 'retry') return load();
    if (action === 'add') return openTeamDialog(null);
    if (action === 'edit' && team) return openTeamDialog(team);
    if (action === 'toggle' && team) return toggleTeam(team);
  });

  load();
}

/* ------------------------------------------------------------------ *
 * Data
 * ------------------------------------------------------------------ */

/**
 * Fetch the teams and paint the body.
 *
 * `include_inactive` is on: this is the admin screen, and a deactivated team
 * that could not be seen could never be reactivated.
 */
async function load() {
  const body = qs('#teams-body');
  if (!body) return;

  body.innerHTML = renderLoading();

  try {
    const data = await api.call('list_teams', { include_inactive: true });
    teams = (data && data.teams) || [];
    body.innerHTML = renderBody();
  } catch (err) {
    teams = [];
    body.innerHTML = renderLoadError(errorMessage(err));
  }
}

/**
 * @param {string} teamId
 * @return {Object|null}
 */
function findTeam(teamId) {
  if (!teamId) return null;
  return teams.find(function (team) { return team.team_id === teamId; }) || null;
}

/* ------------------------------------------------------------------ *
 * Rendering
 * ------------------------------------------------------------------ */

/**
 * The table, or the empty state.
 * @return {string} HTML
 */
function renderBody() {
  if (!teams.length) {
    return renderEmpty(t('teams_empty_title'), t('teams_empty_text'), '◧');
  }

  return `
    <div class="table-wrap">
      <table class="table">
        <thead>
          <tr>
            <th>${escapeHtml(t('col_team'))}</th>
            <th>${escapeHtml(t('status'))}</th>
            <th class="col-actions"><span class="sr-only">${escapeHtml(t('actions'))}</span></th>
          </tr>
        </thead>
        <tbody>
          ${teams.map(renderRow).join('')}
        </tbody>
      </table>
    </div>
  `;
}

/**
 * One team row.
 * @param {Object} team
 * @return {string} HTML
 */
function renderRow(team) {
  const id = escapeHtml(team.team_id);

  return `
    <tr>
      <td class="text-bold">${escapeHtml(team.name)}</td>
      <td>${renderActiveBadge(team.active)}</td>
      <td class="col-actions">
        <div class="cell-actions">
          <button class="btn btn-secondary btn-sm" type="button"
                  data-action="edit" data-team-id="${id}">
            ${escapeHtml(t('edit'))}
          </button>
          <button class="btn btn-ghost btn-sm" type="button"
                  data-action="toggle" data-team-id="${id}">
            ${escapeHtml(team.active ? t('deactivate') : t('activate'))}
          </button>
        </div>
      </td>
    </tr>
  `;
}

/* ------------------------------------------------------------------ *
 * Actions
 * ------------------------------------------------------------------ */

/**
 * Add or rename a team. One dialog for both: the only field is the name.
 * @param {Object|null} team null to create.
 */
function openTeamDialog(team) {
  const editing = !!team;

  openModal({
    title: editing ? t('team_edit') : t('team_add'),
    confirmLabel: editing ? t('save') : t('add'),
    bodyHtml: `
      <div class="field">
        <label class="label" for="team-name">${escapeHtml(t('team_name'))}</label>
        <input class="input" id="team-name" type="text" maxlength="100"
               placeholder="${escapeHtml(t('team_name_placeholder'))}"
               value="${escapeHtml(editing ? team.name : '')}">
      </div>
    `,

    onConfirm: async function (ctx) {
      const name = ctx.value('#team-name');
      if (!name) {
        ctx.setError(t('team_name_required'));
        return false;
      }

      // Nothing changed — close without a pointless round trip.
      if (editing && name === team.name) return;

      if (editing) {
        await api.call('update_team', { team_id: team.team_id, name: name });
        toastSuccess(t('team_updated'));
      } else {
        await api.call('create_team', { name: name });
        toastSuccess(t('team_created'));
      }

      load();
    }
  });
}

/**
 * Flip a team's `active` flag.
 *
 * Deactivating asks first: it is not destructive — the row and its history stay
 * — but it does take the team off every coordinator's dropdown, and that is
 * worth a moment's thought. Reactivating is harmless and happens immediately.
 *
 * @param {Object} team
 */
function toggleTeam(team) {
  const next = !team.active;

  // Reactivating happens straight away. It has no dialog to show an error on,
  // so the failure surfaces as a toast.
  if (next) {
    return setTeamActive(team, true).catch(function (err) {
      toastError(errorMessage(err));
    });
  }

  openModal({
    title: t('team_deactivate_title'),
    confirmLabel: t('deactivate'),
    confirmVariant: 'btn-danger',
    bodyHtml: `<p class="text-small text-secondary">${escapeHtml(t('team_deactivate_text', { name: team.name }))}</p>`,
    onConfirm: function () { return setTeamActive(team, false); }
  });
}

/**
 * @param {Object} team
 * @param {boolean} active
 */
async function setTeamActive(team, active) {
  await api.call('update_team', { team_id: team.team_id, active: active });
  toastSuccess(t(active ? 'team_activated' : 'team_deactivated'));
  load();
}
