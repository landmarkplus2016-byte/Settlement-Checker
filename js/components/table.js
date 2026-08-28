/**
 * table.js — the three states a data table is in before it has data
 * (CLAUDE.md 8.4).
 *
 * Every list screen loads asynchronously, so every one of them renders a
 * spinner, then either rows, an empty state, or a failure with a retry. Those
 * three blocks are identical across screens and live here rather than four
 * times over.
 *
 * The table markup itself does NOT live here: the four admin tables differ in
 * columns, inline controls and per-row actions, and a component general enough
 * to express all of them would be harder to read than the tables it replaced.
 */

import { t } from '../i18n/i18n.js';
import { escapeHtml } from '../utils/dom.js';

/**
 * A list that is loading.
 * @return {string} HTML
 */
export function renderLoading() {
  return `
    <div class="loading-block">
      <span class="spinner"></span>
      <span>${escapeHtml(t('loading'))}</span>
    </div>
  `;
}

/**
 * A list that failed to load. The retry button carries `data-action="retry"`,
 * which every admin screen's delegated click handler understands.
 *
 * @param {string} message already translated — the reason, from errorMessage().
 * @return {string} HTML
 */
export function renderLoadError(message) {
  return `
    <div class="empty-state">
      <div class="empty-icon" aria-hidden="true">!</div>
      <div class="empty-title">${escapeHtml(t('load_failed_title'))}</div>
      <div class="empty-text">${escapeHtml(message)}</div>
      <button class="btn btn-secondary mt-4" type="button" data-action="retry">
        ${escapeHtml(t('retry'))}
      </button>
    </div>
  `;
}

/**
 * A list with nothing in it.
 *
 * @param {string} title already translated.
 * @param {string} text already translated.
 * @param {string} [icon='▤'] a glyph, not a word — never translated.
 * @return {string} HTML
 */
export function renderEmpty(title, text, icon = '▤') {
  return `
    <div class="empty-state">
      <div class="empty-icon" aria-hidden="true">${icon}</div>
      <div class="empty-title">${escapeHtml(title)}</div>
      <div class="empty-text">${escapeHtml(text)}</div>
    </div>
  `;
}

/**
 * The active/inactive pill every admin list shows (CLAUDE.md 8.3 — deactivation
 * instead of deletion, so "inactive" is a state worth seeing at a glance).
 *
 * @param {boolean} active
 * @return {string} HTML
 */
export function renderActiveBadge(active) {
  return active
    ? `<span class="badge badge-approved">${escapeHtml(t('active'))}</span>`
    : `<span class="badge badge-draft">${escapeHtml(t('inactive'))}</span>`;
}

/**
 * The Old / New period marker — amber and blue, everywhere (CLAUDE.md 8.3).
 *
 * @param {string} period 'old' | 'new'
 * @return {string} HTML
 */
export function renderPeriodBadge(period) {
  const isOld = String(period).toLowerCase() === 'old';
  return `<span class="badge badge-${isOld ? 'old' : 'new'}">${escapeHtml(t(isOld ? 'period_old' : 'period_new'))}</span>`;
}
