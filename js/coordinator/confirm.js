/**
 * confirm.js — Save draft, and the two Confirms (CLAUDE.md 3.5, 6.1).
 *
 * This is where the local-first grid finally meets the sheet. Everything up to
 * now has lived in memory and in `sc_draft_*`; these three buttons are the only
 * things on the coordinator's screen that write to his spreadsheet.
 *
 * The two acts are different in kind, and the file keeps them apart:
 *
 *   - **Save draft** is cheap and reversible. It pushes the active grid's rows
 *     and changes nothing about where they are in the lifecycle. The one thing
 *     it can do behind the coordinator's back is revert an approved row to
 *     `confirmed` when he has changed it (rule 12) — so when that happens, it is
 *     reported rather than left to be discovered by a manager.
 *
 *   - **Confirm** hands one period to the managers. It is a period, not a tab:
 *     `confirm_track` moves the draft rows of BOTH grids, so both are saved
 *     first — confirming with unsaved fuel rows would send half a track. Old and
 *     new never move together (rule 10), which is why there are two buttons and
 *     no "confirm everything".
 *
 * Every refusal here is also enforced on the server (3.5, 6.3). The checks in
 * this file exist so the coordinator is told *which rows* and *why* without a
 * round trip — not because the client is trusted with the decision.
 */

import { api } from '../api.js';
import { t, errorMessage } from '../i18n/i18n.js';
import { escapeHtml } from '../utils/dom.js';
import { clearDraft } from '../state.js';
import { validateRows, toNumber, period as asPeriod } from '../utils/validate.js';
import { openModal } from '../components/modal.js';
import { toastSuccess, toastError, showToast } from '../components/toast.js';

/**
 * The statuses Confirm can still move.
 *
 * `draft` is the obvious one. `returned` is here because 6.1 puts such a row
 * back in the coordinator's hands: `save_entries` turns an edited returned row
 * into a `draft` (Coordinator.gs), and runConfirm() saves both grids before it
 * calls `confirm_track` — so by the time the server decides, a fixed returned
 * row IS a draft and moves with the rest of its track.
 *
 * Counting only `draft` here was a dead end: a coordinator who filled in the
 * very thing a manager returned the row for was told "nothing to confirm", and
 * pressing the button refused without even saving. The only way out was to press
 * Save draft first and reload, which nothing on screen said.
 *
 * A returned row the coordinator has NOT edited stays `returned` server-side and
 * simply does not move; the toast reports what actually changed.
 */
const CONFIRMABLE_STATUSES = ['draft', 'returned'];

/**
 * Is one track ready to be confirmed?
 *
 * Mirrors what `confirm_track` will decide (3.5, 6.3): the period's Tracking#
 * must be set, and no FLAG may remain on the rows it would move. Warnings are
 * not consulted — an unknown site still confirms.
 *
 * The rows it would move are the draft and returned rows of that period, across
 * both grids (CONFIRMABLE_STATUSES). Rows already confirmed or approved belong
 * to a manager now, and a flag on one of those cannot be cleared by the
 * coordinator anyway, so blocking on it would be a dead end.
 *
 * @param {Object} page the settlement page's handle (see settlement.js).
 * @param {string} period 'old' | 'new'
 * @return {{ready: boolean, reason: string, pendingCount: number,
 *           flaggedCount: number, trackingNo: number|null}}
 */
export function trackReadiness(page, period) {
  const trackingNo = toNumber(page.settlement()[period + '_tracking_no']);

  let pendingCount = 0;
  let flaggedCount = 0;

  page.kinds.forEach(function (kind) {
    const rows = page.rowsFor(kind);
    const report = validateRows(kind, rows, { siteJcMap: page.siteJcMap() });

    rows.forEach(function (row, index) {
      const status = String(row.status || 'draft').toLowerCase();
      if (CONFIRMABLE_STATUSES.indexOf(status) === -1) return;
      if (asPeriod(row.period) !== period) return;

      pendingCount++;
      if (report.rows[index].flags.length) flaggedCount++;
    });
  });

  let reason = '';
  if (trackingNo === null) reason = 'tracking';
  else if (!pendingCount) reason = 'nothing';
  else if (flaggedCount) reason = 'flags';

  return {
    ready: reason === '',
    reason: reason,
    pendingCount: pendingCount,
    flaggedCount: flaggedCount,
    trackingNo: trackingNo
  };
}

/* ================================================================== *
 * Save draft
 * ================================================================== */

/**
 * `save_entries` for the grid currently on screen (3.5).
 *
 * @param {Object} page
 * @param {string} [kind] defaults to the active grid.
 * @return {Promise<Object|null>} the server's result, or null when nothing was sent.
 */
export async function saveKind(page, kind) {
  const target = kind || page.activeKind();
  const rows = page.payloadRowsFor(target);

  // The mirror is flushed first so a crash between here and the response still
  // leaves the typing on this device (6.5).
  page.flushDraft(target);

  if (!rows.length) {
    // Nothing to send is not a failure — an untouched grid saves in no time at
    // all — but saying so beats a success toast for a write that never happened.
    showToast(t('save_nothing'), 'info');
    return null;
  }

  const result = await api.call('save_entries', {
    settlement_id: page.settlementId,
    kind: target,
    rows: rows
  });

  page.afterSave(target, result);

  toastSuccess(t('save_success', {
    created: result.created || 0,
    updated: result.updated || 0
  }));

  /*
   * Rule 12, made visible. The coordinator changed a row a manager had already
   * signed off; it has dropped back to `confirmed` and needs approving again.
   * Nobody should have to find that out from the manager.
   */
  if (result.reverted_entry_ids && result.reverted_entry_ids.length) {
    showToast(t('save_reverted', { count: result.reverted_entry_ids.length }), 'warning', 6000);
  }

  return result;
}

/**
 * The Save draft button.
 * @param {Object} page
 */
export async function runSave(page) {
  page.setBusy('save', true);

  try {
    await saveKind(page);
  } catch (err) {
    reportSaveFailure(err);
  } finally {
    page.setBusy('save', false);
  }
}

/* ================================================================== *
 * Confirm
 * ================================================================== */

/**
 * The Confirm Old / Confirm New buttons.
 *
 * Order matters and is the whole of the function: check, save BOTH grids, ask,
 * confirm, reload. Saving before confirming is not an optimisation — the server
 * confirms what is in the sheet, so anything still only in the browser would be
 * left behind in `draft` while the rest of its track moved on.
 *
 * @param {Object} page
 * @param {string} period 'old' | 'new'
 */
export async function runConfirm(page, period) {
  const readiness = trackReadiness(page, period);

  if (!readiness.ready) {
    refuse(page, period, readiness);
    return;
  }

  const confirmed = await askToConfirm(page, period, readiness);
  if (!confirmed) return;

  page.setBusy(period, true);

  try {
    // Both kinds: a track is a period, and it spans both grids (rule 10).
    for (let i = 0; i < page.kinds.length; i++) {
      await saveKind(page, page.kinds[i]);
    }

    const result = await api.call('confirm_track', {
      settlement_id: page.settlementId,
      period: period
    });

    toastSuccess(t('confirm_success', {
      count: result.confirmed || 0,
      period: t('period_' + period),
      tracking: result.tracking_no
    }));

    /*
     * Rows with no period are routed to neither Tracking# (6.2), so the server
     * leaves them where they are and counts them. They are easy to overlook —
     * they are usually the rows whose site was missing from the lookup — so they
     * get their own line rather than being folded into the success message.
     */
    if (result.unrouted) {
      showToast(t('confirm_unrouted', { count: result.unrouted }), 'warning', 6000);
    }

    // The roll-up in the header and the status of every row have both moved.
    await page.reload();

  } catch (err) {
    reportConfirmFailure(err, period);
  } finally {
    page.setBusy(period, false);
  }
}

/**
 * Say why a track cannot be confirmed, in the terms the coordinator can act on.
 *
 * @param {Object} page
 * @param {string} period
 * @param {Object} readiness from trackReadiness().
 */
function refuse(page, period, readiness) {
  const periodLabel = t('period_' + period);

  if (readiness.reason === 'tracking') {
    openModal({
      title: t('confirm_needs_tracking_title'),
      cancelLabel: t('close'),
      bodyHtml: `<p class="text-small text-secondary">${escapeHtml(t('confirm_needs_tracking', { period: periodLabel }))}</p>`,
      onOpen: function () {
        const input = document.getElementById('tracking-' + period);
        if (input) input.focus();
      }
    });
    return;
  }

  if (readiness.reason === 'nothing') {
    showToast(t('confirm_nothing', { period: periodLabel }), 'info');
    return;
  }

  openModal({
    title: t('confirm_blocked_title'),
    cancelLabel: t('close'),
    bodyHtml: `
      <p class="text-small text-secondary">
        ${escapeHtml(t('confirm_has_flags', { rows: readiness.flaggedCount, period: periodLabel }))}
      </p>
      <p class="text-small text-muted mt-4">${escapeHtml(t('confirm_has_flags_hint'))}</p>
    `
  });
}

/**
 * Ask before handing a track over.
 *
 * Confirming is not a save. It puts the rows in front of the managers, stamps
 * them against a Tracking#, and the coordinator cannot take them back — only a
 * manager returning them will do that. That is worth one dialog.
 *
 * @param {Object} page
 * @param {string} period
 * @param {Object} readiness
 * @return {Promise<boolean>}
 */
function askToConfirm(page, period, readiness) {
  return new Promise(function (resolve) {
    let answered = false;

    openModal({
      title: t('confirm_dialog_title', { period: t('period_' + period) }),
      confirmLabel: t('confirm_' + period),

      bodyHtml: `
        <div class="stack">
          <p class="text-small text-secondary">
            ${escapeHtml(t('confirm_dialog_body', {
              count: readiness.pendingCount,
              period: t('period_' + period)
            }))}
          </p>

          <div class="confirm-track-line">
            <span class="badge badge-${period}">${escapeHtml(t('period_' + period))}</span>
            <span class="text-small">${escapeHtml(t('col_' + period + '_track'))}</span>
            <span class="num text-bold">${escapeHtml(readiness.trackingNo)}</span>
          </div>

          <p class="text-small text-muted">${escapeHtml(t('confirm_dialog_note'))}</p>
        </div>
      `,

      onConfirm: function () { answered = true; resolve(true); },
      onClose: function () { if (!answered) resolve(false); }
    });
  });
}

/* ------------------------------------------------------------------ *
 * Failures
 * ------------------------------------------------------------------ */

/**
 * A failed save.
 *
 * `save_entries` is all-or-nothing, so nothing was written and the grid is still
 * exactly what the coordinator typed. The one case worth naming is a row that
 * has been exported since he loaded the screen (rule 13) — the fix for that is
 * to reload, not to retry.
 *
 * @param {Object} err
 */
function reportSaveFailure(err) {
  const fields = (err && err.fieldErrors) || null;
  const exported = fields && Object.keys(fields).some(function (key) {
    return fields[key] === 'entry_exported';
  });

  if (exported) {
    openModal({
      title: t('save_failed_title'),
      cancelLabel: t('close'),
      bodyHtml: `<p class="text-small text-secondary">${escapeHtml(t('save_failed_exported'))}</p>`
    });
    return;
  }

  toastError(errorMessage(err));
}

/**
 * A failed confirm.
 *
 * The server re-checks everything this file checked, and it may know something
 * the client does not — a row exported a minute ago, a tracking number cleared
 * elsewhere. `confirm_blocked_by_flags` comes back keyed by entry_id, so the
 * count is real and worth showing rather than a generic failure.
 *
 * @param {Object} err
 * @param {string} period
 */
function reportConfirmFailure(err, period) {
  const message = err && err.serverMessage;

  if (message === 'confirm_blocked_by_flags') {
    const blocked = Object.keys((err && err.fieldErrors) || {}).length;
    openModal({
      title: t('confirm_blocked_title'),
      cancelLabel: t('close'),
      bodyHtml: `
        <p class="text-small text-secondary">
          ${escapeHtml(t('confirm_has_flags', { rows: blocked, period: t('period_' + period) }))}
        </p>
        <p class="text-small text-muted mt-4">${escapeHtml(t('confirm_has_flags_hint'))}</p>
      `
    });
    return;
  }

  if (message === 'tracking_no_required') {
    openModal({
      title: t('confirm_needs_tracking_title'),
      cancelLabel: t('close'),
      bodyHtml: `<p class="text-small text-secondary">${escapeHtml(t('confirm_needs_tracking', { period: t('period_' + period) }))}</p>`
    });
    return;
  }

  toastError(errorMessage(err));
}

/* ------------------------------------------------------------------ *
 * Draft housekeeping
 * ------------------------------------------------------------------ */

/**
 * Drop the local mirror for one grid, once the server holds the rows (6.5).
 *
 * MUST be called after the grid has been rebuilt from the server's answer, not
 * before. Rebuilding retires the old controller, and retiring one flushes it —
 * clearing first would simply have the outgoing grid write its pre-save rows
 * straight back.
 *
 * @param {string} settlementId
 * @param {string} kind
 */
export function dropDraft(settlementId, kind) {
  clearDraft(settlementId, kind);
}
