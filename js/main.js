/**
 * main.js — boot (CLAUDE.md 4.4, 9.1).
 *
 * The sequence, in order, and nothing else lives here:
 *   1. apply the stored language, so even the first screen is translated
 *   2. make sure this device has an Apps Script Web App URL (rule 2)
 *   3. get_config — the one call made before anyone signs in (3.3)
 *   4. adopt the server's primary_language unless the user has chosen one
 *   5. hand over to the router, which shows login or the role shell
 *
 * Plus the two PWA lines (9.2): paint the browser chrome from the design tokens,
 * and hand the service worker to js/updates.js — which registers it and offers
 * the "new version available" prompt when a deploy lands under an open app.
 * Both are fire-and-forget and neither is allowed to hold up or break the
 * sequence above.
 */

import { api, ApiError } from './api.js';
import { setConfig, hasExplicitLang } from './state.js';
import { t, getLang, setLang, errorMessage } from './i18n/i18n.js';
import { escapeHtml, mount, qs, setMessage, setBusy } from './utils/dom.js';
import { startRouter, setRouterSuspended } from './router.js';
import { initAppUpdates } from './updates.js';

/**
 * Run the boot sequence. Safe to call again — "Try again" and "Change server
 * URL" both re-enter here.
 * @return {Promise<void>}
 */
async function boot() {
  // Step 1 — language before any pixels, so nothing renders in the wrong one.
  setLang(getLang(), false);

  // Step 2 — the URL is per device and never in the repo.
  if (!api.hasScriptUrl()) {
    return renderSetupScreen();
  }

  // Step 3 — the only unauthenticated read in the app.
  let config;
  try {
    config = await api.call('get_config');
  } catch (err) {
    return renderBootError(err);
  }

  setConfig(config);

  // Step 4 — the server's default, only while the user has not chosen (8.1).
  if (!hasExplicitLang()) {
    setLang(config.primary_language, false);
  }

  // The tab title is the one string that comes from the Sheet rather than t().
  if (config.app_name) document.title = config.app_name;

  // Step 5.
  startRouter({ onChangeUrl: changeScriptUrl });
}

/* ------------------------------------------------------------------ *
 * First run — asking for the Web App URL
 * ------------------------------------------------------------------ */

/**
 * The one-time setup screen. Shown when localStorage has no `sc_script_url`,
 * and again whenever the user asks to re-point this device.
 */
function renderSetupScreen() {
  setRouterSuspended(true);
  const lang = getLang();

  mount(`
    <div class="screen-centered">
      <form class="auth-card" id="setup-form" novalidate>

        <div class="auth-head">
          <div class="brand-mark">${escapeHtml(t('brand_mark'))}</div>
          <div class="auth-title">${escapeHtml(t('setup_title'))}</div>
          <div class="auth-subtitle">${escapeHtml(t('setup_subtitle'))}</div>
        </div>

        <div class="stack">
          <div class="field">
            <label class="label" for="setup-url">${escapeHtml(t('setup_url_label'))}</label>
            <input class="input num" id="setup-url" name="script_url" type="url"
                   autocomplete="off" spellcheck="false"
                   placeholder="${escapeHtml(t('setup_url_placeholder'))}">
          </div>

          <div class="alert alert-danger hidden" id="setup-error" role="alert"></div>

          <button class="btn btn-primary btn-block btn-lg" id="setup-submit" type="submit">
            ${escapeHtml(t('setup_connect'))}
          </button>
        </div>
      </form>

      <div class="lang-toggle" id="setup-lang">
        <button type="button" data-lang="en" aria-pressed="${lang === 'en'}">${escapeHtml(t('lang_en'))}</button>
        <button type="button" data-lang="ar" aria-pressed="${lang === 'ar'}">${escapeHtml(t('lang_ar'))}</button>
      </div>
    </div>
  `);

  bindSetupEvents();
}

/**
 * Wire the setup screen. The URL is only stored once get_config has actually
 * answered through it — a typo must not leave the device pointed at nothing.
 */
function bindSetupEvents() {
  const form = qs('#setup-form');
  if (!form) return;

  const urlEl = qs('#setup-url');
  const errorEl = qs('#setup-error');
  const submitEl = qs('#setup-submit');

  if (urlEl) urlEl.focus();

  const langToggle = qs('#setup-lang');
  if (langToggle) {
    langToggle.addEventListener('click', function (event) {
      const button = event.target.closest('button[data-lang]');
      if (button) {
        const typed = urlEl ? urlEl.value : '';
        setLang(button.dataset.lang);
        renderSetupScreen();
        const restored = qs('#setup-url');
        if (restored) restored.value = typed;
      }
    });
  }

  form.addEventListener('submit', async function (event) {
    event.preventDefault();

    const url = (urlEl ? urlEl.value : '').trim();
    setMessage(errorEl, '');

    if (!url) {
      setMessage(errorEl, t('setup_url_required'));
      return;
    }
    if (!api.isValidScriptUrl(url)) {
      setMessage(errorEl, t('setup_url_invalid'));
      return;
    }

    setBusy(submitEl, true, t('setup_connect'), t('setup_connecting'));

    try {
      api.setScriptUrl(url);
      await api.call('get_config');   // prove it before keeping it
      await boot();
    } catch (err) {
      api.clearScriptUrl();
      setBusy(submitEl, false, t('setup_connect'), t('setup_connecting'));
      setMessage(errorEl, errorMessage(err instanceof ApiError ? err : { code: 'unknown' }));
    }
  });
}

/**
 * Forget this device's URL and go back to the setup screen. Passed to the
 * router so the login screen can offer it.
 */
function changeScriptUrl() {
  api.clearScriptUrl();
  renderSetupScreen();
}

/* ------------------------------------------------------------------ *
 * Boot failure
 * ------------------------------------------------------------------ */

/**
 * Shown when get_config cannot be reached: the app has no config, so there is
 * nothing to sign in to. Offers a retry and a way to fix the URL.
 * @param {ApiError} err
 */
function renderBootError(err) {
  setRouterSuspended(true);

  mount(`
    <div class="screen-centered">
      <div class="auth-card">
        <div class="auth-head">
          <div class="brand-mark">${escapeHtml(t('brand_mark'))}</div>
          <div class="auth-title">${escapeHtml(t('boot_failed_title'))}</div>
          <div class="auth-subtitle">${escapeHtml(t('boot_failed_subtitle'))}</div>
        </div>

        <div class="stack">
          <div class="alert alert-danger" role="alert">
            ${escapeHtml(errorMessage(err instanceof ApiError ? err : { code: 'unknown' }))}
          </div>
          <button class="btn btn-primary btn-block" id="boot-retry" type="button">
            ${escapeHtml(t('retry'))}
          </button>
          <button class="btn btn-ghost btn-block" id="boot-change-url" type="button">
            ${escapeHtml(t('setup_change_url'))}
          </button>
        </div>
      </div>
    </div>
  `);

  const retry = qs('#boot-retry');
  if (retry) retry.addEventListener('click', function () { boot(); });

  const change = qs('#boot-change-url');
  if (change) change.addEventListener('click', changeScriptUrl);
}

/* ------------------------------------------------------------------ *
 * PWA (9.2)
 * ------------------------------------------------------------------ */

/**
 * Paint the browser's own chrome (the Android address bar, the desktop title
 * bar of an installed window) with the app's navy.
 *
 * Done here rather than as a `<meta name="theme-color">` in index.html so the
 * colour is READ from css/tokens.css instead of being written down a second
 * time — rule 23 holds for the browser chrome as much as for the page.
 * manifest.json cannot do this; JSON has no access to CSS, so its `theme_color`
 * is a literal that has to be kept in step by hand.
 */
function applyThemeColor() {
  const navy = getComputedStyle(document.documentElement)
    .getPropertyValue('--color-navy')
    .trim();

  if (!navy) return;

  let meta = document.querySelector('meta[name="theme-color"]');
  if (!meta) {
    meta = document.createElement('meta');
    meta.setAttribute('name', 'theme-color');
    document.head.appendChild(meta);
  }
  meta.setAttribute('content', navy);
}

/* ------------------------------------------------------------------ *
 * Go
 * ------------------------------------------------------------------ */

applyThemeColor();
initAppUpdates();

boot();
