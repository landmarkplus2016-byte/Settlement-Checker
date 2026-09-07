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
 *
 * A team now carries three things beyond its name: a Latin `code`, which spells
 * its settlement ids (`S-MS-01`) and its batch ids (`EXP-MS-01-NEW-02`), and the
 * two counters those ids and the tracking numbers are issued from. This screen is
 * the only place the counters can be set, and setting them is the one manual step
 * of the cutover.
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
            <th>${escapeHtml(t('col_team_code'))}</th>
            <th>${escapeHtml(t('col_next_settlement'))}</th>
            <th>${escapeHtml(t('col_next_tracking'))}</th>
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
      <td class="num">${escapeHtml(team.code || '—')}</td>
      <td class="num">${escapeHtml(team.next_settlement_no)}</td>
      <td class="num">${escapeHtml(team.next_tracking_no)}</td>
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
 * Add or edit a team — name, code, and the two counters.
 *
 * The COUNTERS are the reason this screen matters more than it used to. A
 * settlement id and a Tracking# are both issued from them (decision 6), and the
 * app cannot know what numbers a team has already been given by hand — so after
 * the deploy the owner types each team's highest issued number here, once, and
 * then never touches them again.
 *
 * They are only offered when editing. A brand-new team starts both at 1, which
 * is the right answer for a team that has never settled and would be a strange
 * thing to ask about at the moment of creating one.
 *
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

      <div class="field">
        <label class="label" for="team-code">${escapeHtml(t('team_code'))}</label>
        <input class="input num" id="team-code" type="text" maxlength="4"
               placeholder="${escapeHtml(t('team_code_placeholder'))}"
               value="${escapeHtml(editing ? (team.code || '') : '')}">
        <div class="field-hint">${escapeHtml(t('team_code_hint'))}</div>
      </div>

      ${editing ? `
        <div class="field">
          <label class="label" for="team-next-settlement">${escapeHtml(t('col_next_settlement'))}</label>
          <input class="input num" id="team-next-settlement" type="text" inputmode="numeric"
                 value="${escapeHtml(team.next_settlement_no)}">
        </div>

        <div class="field">
          <label class="label" for="team-next-tracking">${escapeHtml(t('col_next_tracking'))}</label>
          <input class="input num" id="team-next-tracking" type="text" inputmode="numeric"
                 value="${escapeHtml(team.next_tracking_no)}">
          <div class="field-hint">${escapeHtml(t('team_counters_hint'))}</div>
        </div>
      ` : ''}
    `,

    onConfirm: async function (ctx) {
      const name = ctx.value('#team-name');
      if (!name) {
        ctx.setError(t('team_name_required'));
        return false;
      }

      const code = ctx.value('#team-code').trim().toUpperCase();
      if (!/^[A-Z0-9]{2,4}$/.test(code)) {
        ctx.setError(t('team_code_required'));
        return false;
      }

      if (!editing) {
        await api.call('create_team', { name: name, code: code });
        toastSuccess(t('team_created'));
        load();
        return;
      }

      const settlementNo = ctx.value('#team-next-settlement').trim();
      const trackingNo = ctx.value('#team-next-tracking').trim();

      if (!isCounter(settlementNo) || !isCounter(trackingNo)) {
        ctx.setError(t('team_counter_invalid'));
        return false;
      }

      const patch = { team_id: team.team_id };
      if (name !== team.name) patch.name = name;
      if (code !== (team.code || '')) patch.code = code;
      if (Number(settlementNo) !== team.next_settlement_no) patch.next_settlement_no = Number(settlementNo);
      if (Number(trackingNo) !== team.next_tracking_no) patch.next_tracking_no = Number(trackingNo);

      // Nothing changed — close without a pointless round trip.
      if (Object.keys(patch).length === 1) return;

      await api.call('update_team', patch);
      toastSuccess(t('team_updated'));
      load();
    }
  });
}

/**
 * @param {string} value
 * @return {boolean} a whole number of 1 or more, which is what a counter is.
 */
function isCounter(value) {
  return /^\d+$/.test(value) && Number(value) >= 1;
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
