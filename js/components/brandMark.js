/**
 * brandMark.js — the brand chrome of a screen that stands outside the shell.
 *
 * The login card, the change-password card, the first-run setup screen, the boot
 * failure and the unknown-role dead end all sit on their own with no sidebar, so
 * each one has to say for itself which app this is and whose it is. That is the
 * mark at the top of the card and the company line at the bottom of it.
 *
 * The mark used to be the two letters `SC` in a navy box; it is now the PWA icon
 * itself, so the tab, the installed launcher and the sign-in screen are all the
 * same picture.
 *
 * Both live in one file rather than five copies apiece, because the five screens
 * must never drift apart — one of them showing an older mark, or the year the
 * others have moved past, is exactly the kind of thing nobody notices until a
 * user does.
 *
 * The path is relative, like every other asset reference (GitHub Pages serves a
 * project repo from a subdirectory), and the intrinsic size is on the tag so the
 * card does not jump while the image loads.
 */

import { t } from '../i18n/i18n.js';
import { escapeHtml } from '../utils/dom.js';

/**
 * The app mark.
 * @return {string} HTML
 */
export function renderBrandMark() {
  return `<img class="brand-mark" src="icons/icon-192.png"
               alt="${escapeHtml(t('app_name'))}" width="192" height="192">`;
}

/**
 * The company line at the foot of a standalone card.
 *
 * The year is read from the clock rather than written into the dictionary, so
 * the notice cannot go stale on 1 January while nobody is looking. It rides in
 * as a {year} placeholder so each language keeps the wording — and the position
 * of the number — its own.
 *
 * @return {string} HTML
 */
export function renderBrandFooter() {
  const year = new Date().getFullYear();
  return `<div class="auth-footnote">${escapeHtml(t('brand_copyright', { year: year }))}</div>`;
}
