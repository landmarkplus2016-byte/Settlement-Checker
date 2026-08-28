/**
 * approvals.js — the consolidated review screen (CLAUDE.md 3.6, 5.2, 8).
 *
 * This is the screen that replaces "open the emailed workbook, read it, reply".
 * One table holds every coordinator's `confirmed`, `approved` and `returned`
 * entries at once, and a manager decides on each one where it sits.
 *
 * Four things drive the design:
 *
 *   - **The Tracking# is shown, never chosen.** It is resolved server-side from
 *     the entry's settlement by period (6.2), so the column is read-only by
 *     construction. Old is amber, New is blue, here as everywhere (8.3).
 *   - **A returned entry needs a reason.** `return_entry` refuses an empty note
 *     server-side, so Return opens a dialog rather than acting on a click — the
 *     note is the whole point of the transition, not a decoration on it.
 *   - **A row action patches one row, it does not reload the screen.**
 *     `list_pending` opens every coordinator's spreadsheet, which is seconds of
 *     Apps Script; refetching all of that to repaint one approved row would make
 *     the screen unusable. Both single-entry actions return the stored entry, so
 *     the local row is replaced with the server's answer and the counts are
 *     recomputed from what is on screen.
 *   - **A partial sweep is never presented as complete.** `list_pending` reports
 *     coordinators whose sheet could not be read; that comes back as a warning
 *     above the table. An entry silently missing from this list is an entry that
 *     never gets approved, so it is not allowed to be silent.
 *
 * Approving in bulk is deliberately narrower than approving one row.
 * `approve_batch` refuses an empty filter server-side — "approve everything
 * anyone has ever confirmed" has no undo — so the button is disabled until the
 * manager has actually narrowed the list to something they can see.
 */

import { api } from '../api.js';
import { t, errorMessage, getLang } from '../i18n/i18n.js';
import { escapeHtml, qs } from '../utils/dom.js';
import { formatDateTime } from '../utils/dates.js';
import { formatMoney, formatMoneyOrBlank } from '../utils/money.js';
import { openModal } from '../components/modal.js';
import { toastSuccess, toastError } from '../components/toast.js';
import { renderLoading, renderLoadError, renderEmpty, renderPeriodBadge } from '../components/table.js';

/** Rows per page. Matches nothing on the server; `list_pending` caps at 500. */
const PAGE_SIZE = 100;

/** Longest note `return_entry` will store (MAX_RETURN_NOTE_LENGTH in Manager.gs). */
const MAX_NOTE_LENGTH = 1000;

/** The statuses a row can be in here, in the order the server sorts them. */
const REVIEW_STATUSES = ['confirmed', 'approved', 'returned'];

/* ------------------------------------------------------------------ *
 * Screen state
 * ------------------------------------------------------------------ */

/** The current page of entries, as returned by `list_pending`. */
let entries = [];

/** The server's roll-up over the WHOLE filtered result, not just this page. */
let counts = null;

/** Paging, from the last response. */
let page = 1;
let totalPages = 0;
let total = 0;

/** Coordinators the last sweep could not read or had to skip (3.6). */
let sweep = { errors: [], skipped: [] };

/** The live filter — the four fields of 3.6. */
let filter = { team: '', coordinator: '', period: '', month: '' };

/** Reference data for the filter selects, loaded once per visit. */
let teams = [];
let coordinators = [];
let months = [];

/**
 * user_id -> the Users row, so `approved_by` (which the server stores as an id)
 * can be shown as the manager's name.
 */
let people = {};

/** True while a list request is in flight, so a double click cannot race. */
let busy = false;

/* ================================================================== *
 * Render
 * ================================================================== */

/**
 * The Approvals screen.
 *
 * Returns synchronously with a loading body, like every other list screen — the
 * router paints a string (5.3) and the data arrives in bindApprovalsEvents().
 *
 * @return {string} HTML
 */
export function renderApprovals() {
  return `
    <div class="page" id="approvals-page">
      <div class="page-title-row">
        <div>
          <h1>${escapeHtml(t('nav_approvals'))}</h1>
          <div class="page-subtitle">${escapeHtml(t('approvals_subtitle'))}</div>
        </div>
        <span class="spacer"></span>
        <button class="btn btn-primary" type="button" data-action="approve-all" disabled>
          ${escapeHtml(t('approve_all_pending'))}
        </button>
      </div>

      <div class="toolbar" id="approvals-filters">${renderFilters()}</div>

      <div id="approvals-counts"></div>

      <div class="card">
        <div id="approvals-body">${renderLoading()}</div>
      </div>
    </div>
  `;
}

/**
 * Wire the screen and load it.
 *
 * One delegated click listener and one delegated change listener on the page,
 * both attached once. Every later repaint replaces only the body, the toolbar or
 * the counts strip, so nothing is ever re-bound and nothing leaks.
 */
export function bindApprovalsEvents() {
  const page$ = qs('#approvals-page');
  if (!page$) return;

  entries = [];
  counts = null;
  page = 1;
  totalPages = 0;
  total = 0;
  sweep = { errors: [], skipped: [] };
  filter = { team: '', coordinator: '', period: '', month: '' };
  teams = [];
  coordinators = [];
  months = [];
  people = {};
  busy = false;

  page$.addEventListener('click', function (event) {
    const trigger = event.target.closest('[data-action]');
    if (!trigger || trigger.disabled) return;

    const action = trigger.dataset.action;

    if (action === 'retry') return load();
    if (action === 'clear-filters') return clearFilters();
    if (action === 'approve-all') return confirmApproveAll();
    if (action === 'prev') return goToPage(page - 1);
    if (action === 'next') return goToPage(page + 1);

    const entry = findEntry(trigger.dataset.key);
    if (!entry) return;

    if (action === 'approve') return approveOne(entry, trigger);
    if (action === 'return') return openReturnDialog(entry);
  });

  page$.addEventListener('change', function (event) {
    const select = event.target.closest('[data-filter]');
    if (!select) return;

    const hadFilter = hasFilter();
    filter[select.dataset.filter] = String(select.value || '');
    page = 1;

    /*
     * Repaint the bar only when the Clear button has to appear or disappear.
     * Rebuilding it on every change would work, but it replaces the <select>
     * the manager just used and takes the focus off it mid-keyboard-run.
     */
    if (hasFilter() !== hadFilter) repaintFilters();

    load();
  });

  loadReference().then(load);
}

/* ================================================================== *
 * Data
 * ================================================================== */

/**
 * The three lists behind the filter selects, plus the people map that turns an
 * `approved_by` id into a name.
 *
 * Failures here are swallowed on purpose. This is decoration around the real
 * screen: a manager whose Teams list did not load can still review entries with
 * the period filter and the full list, and blocking the whole screen on a
 * dropdown would be the wrong trade. The one visible consequence is that an
 * `approved_by` falls back to showing the raw user id.
 */
async function loadReference() {
  const [teamData, userData, listData] = await Promise.all([
    api.call('list_teams', { include_inactive: true }).catch(nullOnError),
    api.call('list_users', { include_inactive: true }).catch(nullOnError),
    api.call('list_lists', { list_name: 'months' }).catch(nullOnError)
  ]);

  // Inactive teams are included: entries already filed under a team keep it
  // (2.1), so a deactivated team still has rows here that need finding.
  teams = (teamData && teamData.teams) || [];

  const users = (userData && userData.users) || [];
  people = {};
  coordinators = [];

  users.forEach(function (user) {
    people[user.user_id] = user;
    if (user.role === 'coordinator') coordinators.push(user);
  });

  months = ((listData && listData.lists && listData.lists.months) || [])
    .map(function (option) { return option.value; });

  repaintFilters();
}

/** @param {*} err @return {null} */
function nullOnError(err) {
  console.warn('Approvals reference data unavailable: ' + (err && err.message));
  return null;
}

/**
 * Fetch one page of the consolidated list and paint it.
 *
 * Only the four filter fields of 3.6 are sent, and only when set — an empty
 * string means "all", which is what the server does with an absent field.
 */
async function load() {
  const body = qs('#approvals-body');
  if (!body) return;

  busy = true;
  body.innerHTML = renderLoading();
  setApproveAllEnabled(false);

  try {
    const data = await api.call('list_pending', {
      team: filter.team,
      coordinator: filter.coordinator,
      period: filter.period,
      month: filter.month,
      page: page,
      page_size: PAGE_SIZE
    });

    entries = (data && data.entries) || [];
    counts = (data && data.counts) || null;
    total = (data && data.total) || 0;
    totalPages = (data && data.total_pages) || 0;
    page = (data && data.page) || 1;
    sweep = {
      errors: (data && data.errors) || [],
      skipped: (data && data.skipped) || []
    };

    busy = false;
    paint();

  } catch (err) {
    entries = [];
    counts = null;
    total = 0;
    totalPages = 0;
    sweep = { errors: [], skipped: [] };
    busy = false;

    body.innerHTML = renderLoadError(errorMessage(err));
    paintCounts();
    setApproveAllEnabled(false);
  }
}

/**
 * Move to another page. Bounded here rather than trusted from the click, so the
 * pager buttons cannot walk off either end.
 * @param {number} next 1-based.
 */
function goToPage(next) {
  if (busy) return;
  if (next < 1 || (totalPages && next > totalPages)) return;

  page = next;
  load();
}

/** Reset every filter and reload. */
function clearFilters() {
  filter = { team: '', coordinator: '', period: '', month: '' };
  page = 1;
  repaintFilters();
  load();
}

/**
 * The composite key identifying one row. An entry_id is only unique within one
 * coordinator's spreadsheet and one tab, so all three parts are needed — two
 * coordinators can both hold an `E-000001`.
 *
 * @param {Object} entry
 * @return {string}
 */
function entryKey(entry) {
  return [entry.coordinator.user_id, entry.kind, entry.entry_id].join('|');
}

/**
 * @param {string} key
 * @return {Object|null}
 */
function findEntry(key) {
  if (!key) return null;
  return entries.find(function (entry) { return entryKey(entry) === key; }) || null;
}

/**
 * Replace one row with what the server says it now is, and recompute the counts
 * from the page. See the file header for why this beats a refetch.
 *
 * @param {Object} updated a shaped entry from approve_entry / return_entry.
 */
function replaceEntry(updated) {
  const key = entryKey(updated);
  const index = entries.findIndex(function (entry) { return entryKey(entry) === key; });
  if (index !== -1) entries[index] = updated;

  recount();
  paint();
}

/**
 * Rebuild the status tallies after a local patch.
 *
 * Only `by_status` is touched: a decision moves a row between statuses but
 * cannot change its period, its kind, or the size of the filtered result, so the
 * server's totals for those stay correct across a patch.
 */
function recount() {
  if (!counts || !counts.by_status) return;

  const seen = { confirmed: 0, approved: 0, returned: 0 };
  entries.forEach(function (entry) {
    if (seen[entry.status] !== undefined) seen[entry.status]++;
  });

  // Only meaningful when the whole result fits on one page; otherwise the
  // server's figures cover rows this page cannot see, and guessing at them
  // would put a wrong number on screen.
  if (totalPages <= 1) counts.by_status = seen;
}

/* ================================================================== *
 * Painting
 * ================================================================== */

/** Repaint everything that depends on the loaded page. */
function paint() {
  const body = qs('#approvals-body');
  if (body) body.innerHTML = renderBody();

  paintCounts();
  setApproveAllEnabled(canApproveAll());
}

/** The filter selects, rebuilt with whatever reference data has arrived. */
function repaintFilters() {
  const host = qs('#approvals-filters');
  if (host) host.innerHTML = renderFilters();
}

/** The status chips above the table. */
function paintCounts() {
  const host = qs('#approvals-counts');
  if (host) host.innerHTML = renderCounts();
}

/**
 * Enable or disable the bulk action without repainting the title row.
 * @param {boolean} enabled
 */
function setApproveAllEnabled(enabled) {
  const button = qs('#approvals-page [data-action="approve-all"]');
  if (!button) return;

  button.disabled = !enabled;
  button.title = enabled ? '' : t('approve_all_needs_filter');
}

/**
 * Is "Approve all pending" available?
 *
 * Two conditions, and both are real: `approve_batch` refuses an empty filter
 * server-side, and there has to be something confirmed for it to act on.
 *
 * @return {boolean}
 */
function canApproveAll() {
  if (busy) return false;
  if (!hasFilter()) return false;
  return confirmedCount() > 0;
}

/** @return {boolean} true when at least one filter field is set. */
function hasFilter() {
  return !!(filter.team || filter.coordinator || filter.period || filter.month);
}

/**
 * How many confirmed rows the current filter covers, across every page.
 * @return {number}
 */
function confirmedCount() {
  return (counts && counts.by_status && counts.by_status.confirmed) || 0;
}

/* ------------------------------------------------------------------ *
 * The filter bar
 * ------------------------------------------------------------------ */

/**
 * The four filters of 3.6, as selects.
 * @return {string} HTML
 */
function renderFilters() {
  return `
    ${renderSelect('team', t('filter_all_teams'), teams.map(function (team) {
      return { value: team.name, label: team.name + (team.active ? '' : ' · ' + t('inactive')) };
    }))}

    ${renderSelect('coordinator', t('filter_all_coordinators'), coordinators.map(function (user) {
      return { value: user.user_id, label: personName(user) };
    }))}

    ${renderSelect('month', t('filter_all_months'), months.map(function (month) {
      return { value: month, label: month };
    }))}

    ${renderSelect('period', t('period_all'), [
      { value: 'old', label: t('period_old') },
      { value: 'new', label: t('period_new') }
    ])}

    ${hasFilter() ? `
      <button class="btn btn-ghost btn-sm" type="button" data-action="clear-filters">
        ${escapeHtml(t('filter_clear'))}
      </button>
    ` : ''}
  `;
}

/**
 * One filter select. The current value is re-applied on every repaint, so
 * rebuilding the bar after the reference data lands does not silently reset a
 * filter the manager already chose.
 *
 * @param {string} name a key of `filter`.
 * @param {string} allLabel already translated.
 * @param {Array<{value: string, label: string}>} options
 * @return {string} HTML
 */
function renderSelect(name, allLabel, options) {
  const current = filter[name] || '';

  return `
    <select class="select toolbar-select" data-filter="${escapeHtml(name)}"
            aria-label="${escapeHtml(allLabel)}">
      <option value="">${escapeHtml(allLabel)}</option>
      ${options.map(function (option) {
        const selected = option.value === current ? ' selected' : '';
        return `<option value="${escapeHtml(option.value)}"${selected}>${escapeHtml(option.label)}</option>`;
      }).join('')}
    </select>
  `;
}

/* ------------------------------------------------------------------ *
 * The counts strip
 * ------------------------------------------------------------------ */

/**
 * The per-status tally for the whole filtered result.
 * @return {string} HTML
 */
function renderCounts() {
  if (!counts) return '';

  const byStatus = counts.by_status || {};

  return `
    <div class="count-strip">
      ${REVIEW_STATUSES.map(function (status) {
        return `
          <span class="count-chip">
            <span class="badge badge-${status}">${escapeHtml(t('entry_status_' + status))}</span>
            <span class="num text-bold">${escapeHtml(String(byStatus[status] || 0))}</span>
          </span>
        `;
      }).join('')}

      <span class="spacer"></span>

      ${counts.by_period && counts.by_period.unrouted
        ? `<span class="text-tiny alert alert-warning">${escapeHtml(
            t(counts.by_period.unrouted === 1 ? 'unrouted_count_one' : 'unrouted_count',
              { count: counts.by_period.unrouted })
          )}</span>`
        : ''}
    </div>
  `;
}

/* ------------------------------------------------------------------ *
 * The table
 * ------------------------------------------------------------------ */

/**
 * The sweep warning, the table and the pager — or the right empty state.
 * @return {string} HTML
 */
function renderBody() {
  const warning = renderSweepWarning();

  if (!entries.length) {
    return warning + (hasFilter()
      ? renderEmpty(t('nothing_found_title'), t('nothing_found_text'), '⌕')
      : renderEmpty(t('approvals_empty_title'), t('approvals_empty_text'), '✓'));
  }

  return `
    ${warning}

    <div class="table-wrap">
      <table class="table">
        <thead>
          <tr>
            <th>${escapeHtml(t('col_coordinator'))}</th>
            <th>${escapeHtml(t('col_entry'))}</th>
            <th>${escapeHtml(t('col_site_id'))}</th>
            <th>${escapeHtml(t('col_job_code'))}</th>
            <th>${escapeHtml(t('col_category_fuel'))}</th>
            <th class="text-end">${escapeHtml(t('col_amount'))}</th>
            <th>${escapeHtml(t('col_team'))}</th>
            <th>${escapeHtml(t('col_period_tracking'))}</th>
            <th>${escapeHtml(t('status'))}</th>
            <th class="col-actions"><span class="sr-only">${escapeHtml(t('actions'))}</span></th>
          </tr>
        </thead>
        <tbody>
          ${entries.map(renderRow).join('')}
        </tbody>
      </table>
    </div>

    ${renderPager()}
  `;
}

/**
 * Coordinators whose sheets could not be read (3.6).
 *
 * Never hidden, and never softened into a toast that scrolls away: the list
 * above is incomplete while this is showing, and the manager has to know which
 * people are missing from it.
 *
 * @return {string} HTML
 */
function renderSweepWarning() {
  const problems = sweep.errors.concat(sweep.skipped);
  if (!problems.length) return '';

  const names = problems.map(function (problem) {
    const user = people[problem.user_id];
    return user ? personName(user) : problem.user_id;
  });

  return `
    <div class="alert alert-warning m-4">
      ${escapeHtml(t('sweep_incomplete', { names: names.join(t('list_separator')) }))}
    </div>
  `;
}

/**
 * One entry row.
 * @param {Object} entry
 * @return {string} HTML
 */
function renderRow(entry) {
  const key = escapeHtml(entryKey(entry));
  const isFuel = entry.kind === 'fuel';

  return `
    <tr>
      <td>
        <div class="text-bold">${escapeHtml(personName(entry.coordinator))}</div>
        <div class="text-tiny text-muted num">${escapeHtml(entry.settlement.settlement_id)}</div>
      </td>

      <td>
        <div class="cell-line">
          <span class="badge badge-neutral">${escapeHtml(t('kind_' + entry.kind))}</span>
          <span class="num">${escapeHtml(entryDate(entry))}</span>
        </div>
        <div class="text-tiny text-muted">
          ${escapeHtml(entry.project || '—')}
          <span class="num cell-subfigure"> · ${escapeHtml(entry.entry_id)}</span>
        </div>
      </td>

      <td class="num text-bold">${escapeHtml(entry.site_id || '—')}</td>
      <td class="num">${escapeHtml(entry.job_code || '—')}</td>

      <td>${isFuel ? renderFuelDetail(entry) : renderExpenseDetail(entry)}</td>

      <td class="num text-bold text-end">
        ${escapeHtml(formatMoney(isFuel ? entry.fuel_amount : entry.amount))}
        ${isFuel && formatMoneyOrBlank(entry.karta_amount)
          ? `<div class="text-tiny text-muted cell-subfigure">${escapeHtml(t('col_karta'))} ${escapeHtml(formatMoney(entry.karta_amount))}</div>`
          : ''}
      </td>

      <td>${escapeHtml(entry.team || '—')}</td>

      <td>
        <div class="cell-line">
          ${entry.period ? renderPeriodBadge(entry.period) : `<span class="badge badge-draft">${escapeHtml(t('period_none'))}</span>`}
          ${entry.tracking_no
            ? `<span class="num text-bold">#${escapeHtml(entry.tracking_no)}</span>`
            : `<span class="text-tiny text-muted">${escapeHtml(t('tracking_placeholder'))}</span>`}
        </div>
      </td>

      <td>${renderStatusCell(entry)}</td>

      <td class="col-actions">
        <div class="cell-actions">
          ${entry.status === 'confirmed' ? `
            <button class="btn btn-primary btn-sm" type="button"
                    data-action="approve" data-key="${key}">
              ${escapeHtml(t('approve'))}
            </button>
          ` : ''}
          ${entry.status === 'confirmed' || entry.status === 'approved' ? `
            <button class="btn btn-secondary btn-sm" type="button"
                    data-action="return" data-key="${key}">
              ${escapeHtml(t('return_action'))}
            </button>
          ` : ''}
        </div>
      </td>
    </tr>
  `;
}

/**
 * The expense side of the shared detail column.
 * @param {Object} entry
 * @return {string} HTML
 */
function renderExpenseDetail(entry) {
  return `
    <div>${escapeHtml(entry.category || '—')}</div>
    ${entry.item_description
      ? `<div class="text-tiny text-muted cell-clamp">${escapeHtml(entry.item_description)}</div>`
      : ''}
  `;
}

/**
 * The fuel side of the shared detail column.
 *
 * The KM readings sit here rather than in their own columns because they are the
 * fuel equivalent of an item description — context for the amount. They are also
 * the one pair of numbers the per-site export never divides (6.4), so they are
 * shown as a span rather than as two figures that look splittable.
 *
 * @param {Object} entry
 * @return {string} HTML
 */
function renderFuelDetail(entry) {
  const parts = [entry.driver, entry.area, entry.city].filter(Boolean);
  const hasKm = entry.start_km !== null || entry.end_km !== null;

  return `
    <div>${escapeHtml(parts.length ? parts.join(' · ') : '—')}</div>
    ${hasKm ? `
      <div class="text-tiny text-muted num">
        ${escapeHtml(entry.start_km === null ? '—' : entry.start_km)}
        →
        ${escapeHtml(entry.end_km === null ? '—' : entry.end_km)}
      </div>
    ` : ''}
  `;
}

/**
 * The status badge, plus who decided.
 *
 * An approved row carries the approving manager's name and the moment — that is
 * the audit trail the old workbook never had, and it is the reason `approved_by`
 * is server-stamped from the session rather than sent by the client (rule 8).
 *
 * @param {Object} entry
 * @return {string} HTML
 */
function renderStatusCell(entry) {
  const badge = `<span class="badge badge-${escapeHtml(entry.status)}">${escapeHtml(t('entry_status_' + entry.status))}</span>`;

  if (entry.status === 'approved' && entry.approved_by) {
    return `
      ${badge}
      <div class="text-tiny text-muted">
        ${escapeHtml(t('approved_by_stamp', { name: personName(people[entry.approved_by]) || entry.approved_by }))}
      </div>
      ${entry.approved_at
        ? `<div class="text-tiny text-muted num">${escapeHtml(formatDateTime(entry.approved_at))}</div>`
        : ''}
    `;
  }

  if (entry.status === 'returned' && entry.return_note) {
    return `
      ${badge}
      <div class="text-tiny text-muted cell-clamp" title="${escapeHtml(entry.return_note)}">
        ${escapeHtml(entry.return_note)}
      </div>
    `;
  }

  return badge;
}

/**
 * The pager, when there is more than one page.
 * @return {string} HTML
 */
function renderPager() {
  if (totalPages <= 1) {
    return `<div class="table-foot">${escapeHtml(t('showing_all', { total: total }))}</div>`;
  }

  return `
    <div class="table-foot pager">
      <button class="btn btn-secondary btn-sm" type="button" data-action="prev"
              ${page <= 1 ? 'disabled' : ''}>${escapeHtml(t('pager_prev'))}</button>

      <span class="num">${escapeHtml(t('pager_position', { page: page, pages: totalPages, total: total }))}</span>

      <button class="btn btn-secondary btn-sm" type="button" data-action="next"
              ${page >= totalPages ? 'disabled' : ''}>${escapeHtml(t('pager_next'))}</button>
    </div>
  `;
}

/* ================================================================== *
 * Actions
 * ================================================================== */

/**
 * Approve one entry.
 *
 * The button is disabled for the round trip rather than the whole table: a
 * manager working down a long list should be able to keep reading while one row
 * commits.
 *
 * @param {Object} entry
 * @param {HTMLButtonElement} button the clicked button.
 */
async function approveOne(entry, button) {
  button.disabled = true;

  try {
    const data = await api.call('approve_entry', {
      coordinator_user_id: entry.coordinator.user_id,
      kind: entry.kind,
      entry_id: entry.entry_id
    });

    // `changed: false` means somebody else had already approved it. Not an
    // error, and not worth a success message that claims this manager did it.
    toastSuccess(data && data.changed === false
      ? t('approve_already')
      : t('approve_success'));

    if (data && data.entry) replaceEntry(data.entry);
    else load();

  } catch (err) {
    button.disabled = false;
    toastError(errorMessage(err));
  }
}

/**
 * Return one entry with a note.
 *
 * The note is required here and again on the server. A row handed back with no
 * reason is a round trip the coordinator cannot act on, so the dialog will not
 * submit empty.
 *
 * @param {Object} entry
 */
function openReturnDialog(entry) {
  openModal({
    title: t('return_title'),
    confirmLabel: t('return_action'),
    confirmVariant: 'btn-danger',

    bodyHtml: `
      <p class="text-small text-secondary">
        ${escapeHtml(t('return_text', {
          coordinator: personName(entry.coordinator),
          entry: entry.entry_id
        }))}
      </p>

      <div class="field mt-4">
        <label class="label" for="return-note">${escapeHtml(t('return_note_label'))}</label>
        <textarea class="textarea" id="return-note" maxlength="${MAX_NOTE_LENGTH}"
                  placeholder="${escapeHtml(t('return_note_placeholder'))}"></textarea>
        <div class="field-hint">${escapeHtml(t('return_note_hint'))}</div>
      </div>
    `,

    onConfirm: async function (ctx) {
      const note = ctx.value('#return-note');
      if (!note) {
        ctx.setError(t('return_note_required'));
        return false;
      }

      const data = await api.call('return_entry', {
        coordinator_user_id: entry.coordinator.user_id,
        kind: entry.kind,
        entry_id: entry.entry_id,
        note: note
      });

      toastSuccess(t('return_success'));

      if (data && data.entry) replaceEntry(data.entry);
      else load();
    }
  });
}

/**
 * "Approve all pending" — `approve_batch` over the current filter (3.6).
 *
 * Confirmed first, and the dialog names the count and the filter it is about to
 * act on. Bulk approval has no undo: un-approving is a return, one row at a
 * time, with a note.
 */
function confirmApproveAll() {
  const pending = confirmedCount();
  if (!pending || !hasFilter()) return;

  openModal({
    title: t('approve_all_title'),
    confirmLabel: t('approve_all_confirm', { count: pending }),

    bodyHtml: `
      <p class="text-small text-secondary">
        ${escapeHtml(t('approve_all_text', { count: pending }))}
      </p>

      <div class="alert alert-info mt-4">${escapeHtml(filterSummary())}</div>

      <p class="text-tiny text-muted mt-4">${escapeHtml(t('approve_all_note'))}</p>
    `,

    onConfirm: async function () {
      const data = await api.call('approve_batch', { filter: filter });

      toastSuccess(t('approve_all_success', {
        count: (data && data.approved) || 0
      }));

      // A batch moves rows this page cannot see, so this one really is a
      // refetch — the local counts would be a guess.
      page = 1;
      load();
    }
  });
}

/**
 * The active filter, spelled out for the bulk-approve dialog. A manager about to
 * approve forty rows in one click should be able to read back exactly what
 * "matching" means.
 *
 * @return {string} plain text, already translated.
 */
function filterSummary() {
  const parts = [];

  if (filter.team) parts.push(t('col_team') + ': ' + filter.team);
  if (filter.coordinator) {
    parts.push(t('col_coordinator') + ': ' + (personName(people[filter.coordinator]) || filter.coordinator));
  }
  if (filter.month) parts.push(t('col_month') + ': ' + filter.month);
  if (filter.period) parts.push(t('col_period') + ': ' + t('period_' + filter.period));

  return parts.join('  ·  ');
}

/* ================================================================== *
 * Helpers
 * ================================================================== */

/**
 * A person's name in the active language (8.1) — the Arabic name in AR when
 * there is one, the English name otherwise.
 *
 * @param {Object|null|undefined} person any object carrying display_name /
 *        display_name_ar: a coordinator on an entry, or a Users row.
 * @return {string} '' when there is no such person.
 */
function personName(person) {
  if (!person) return '';
  if (getLang() === 'ar' && person.display_name_ar) return person.display_name_ar;
  return person.display_name || person.user_id || '';
}

/**
 * The entry's own date label — the month and day the coordinator typed, not the
 * settlement's month. They are usually the same and occasionally not, and the
 * one on the row is the one being settled.
 *
 * @param {Object} entry
 * @return {string}
 */
function entryDate(entry) {
  const month = entry.month || entry.settlement.month || '';
  const day = (entry.day === null || entry.day === undefined) ? '' : String(entry.day);

  if (month && day) return month + ' ' + day;
  return month || day || '—';
}
