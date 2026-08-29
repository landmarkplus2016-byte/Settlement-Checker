/**
 * brandMark.js — the app's icon, wherever a screen stands outside the shell.
 *
 * The login card, the change-password card, the first-run setup screen, the boot
 * failure and the unknown-role dead end all sit on their own with no sidebar, so
 * each one carries the mark that says which app this is. It used to be the two
 * letters `SC` in a navy box; it is now the PWA icon itself, so the tab, the
 * installed launcher and the sign-in screen are all the same picture.
 *
 * It lives in one file rather than five copies of an <img> because the five
 * screens must never drift apart — one of them showing an older mark is exactly
 * the kind of thing nobody notices until a user does.
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
