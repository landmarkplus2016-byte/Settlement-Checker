/**
 * updates.js — "a new version is available" (CLAUDE.md 9.2).
 *
 * The app is a static site with no build step, so a push to main changes the
 * files under a browser that has already loaded the old ones. Without this, the
 * only way anybody got a fix was a hard refresh they had to know to do.
 *
 * How it works, end to end:
 *
 *   1. The developer bumps APP_VERSION in service-worker.js and pushes.
 *   2. Every open app checks that file periodically (and whenever its tab comes
 *      back to the front). A changed byte means a new worker, which installs
 *      and then PARKS in `waiting` — the worker no longer calls skipWaiting().
 *   3. This file notices the waiting worker and shows the prompt.
 *   4. Reload posts `skip_waiting` to it, the new worker takes over, and
 *      `controllerchange` reloads the page onto the new version.
 *
 * Three decisions worth keeping:
 *
 *   - **The reload is a click, never automatic.** The one screen that matters
 *     here is the coordinator's grid, and a page that reloads itself under
 *     somebody who is typing is worse than a stale one. The prompt collapses to
 *     a chip if he is busy, and waits there.
 *   - **The prompt is honest about the cost.** The session token is memory-only
 *     (4.2), so a reload signs the user out. Grid drafts survive — they are
 *     mirrored to localStorage (6.5) — and the text says exactly that, because
 *     a surprise sign-out mid-settlement is how people learn to ignore a
 *     button.
 *   - **It lives outside #app.** The router replaces #app on every paint (5.3),
 *     so anything mounted inside it would vanish on the next navigation. Same
 *     reason toast.js does it.
 */

import { t, LANG_CHANGE_EVENT } from './i18n/i18n.js';
import { escapeHtml } from './utils/dom.js';

/** The prompt's own element, outside #app. */
const HOST_ID = 'sc-update-host';

/** How often an open tab asks whether a new version has shipped. */
const CHECK_INTERVAL_MS = 30 * 60 * 1000;

/**
 * The floor between two checks, however many things ask for one. Tab switching
 * fires visibilitychange constantly, and every check is a request.
 */
const MIN_CHECK_GAP_MS = 5 * 60 * 1000;

/**
 * How long to wait for the new worker to take over before reloading anyway. A
 * button that spins forever because a worker failed to activate is worse than a
 * reload that lands on the same version.
 */
const TAKEOVER_TIMEOUT_MS = 3000;

/** The registration, once it exists. */
let registration = null;

/**
 * The installed-but-waiting worker, or null when the update is already active
 * (another tab applied it) and only a reload is left to do.
 */
let waitingWorker = null;

/** True once Reload has been pressed — the guard on the reload path. */
let applying = false;

/** True while there is something to offer. */
let pending = false;

/** True once "Later" has been pressed: the prompt shrinks to a chip. */
let collapsed = false;

/** Throttle for checkForUpdate(). */
let lastCheckAt = 0;

/**
 * Was this page already controlled by a worker when it loaded?
 *
 * A FIRST install claims the page and fires `controllerchange` exactly like an
 * update does. Without this the very first visit would be told, wrongly, that a
 * new version is available.
 */
let hadController = false;

/* ================================================================== *
 * Boot
 * ================================================================== */

/**
 * Register the service worker and watch for new versions.
 *
 * Every failure is swallowed. The worker is a nicety — it makes the shell open
 * instantly and offline — and an app that refuses to start because a cache
 * could not be registered would be strictly worse than one with no cache. It is
 * also absent by design on `file://` and on plain http, where the API does not
 * exist at all; there, this whole file does nothing and the app runs normally.
 */
export function initAppUpdates() {
  if (!('serviceWorker' in navigator)) return;

  hadController = !!navigator.serviceWorker.controller;

  navigator.serviceWorker.addEventListener('controllerchange', onControllerChange);

  // A language switch mid-prompt should not leave the old language on screen.
  window.addEventListener(LANG_CHANGE_EVENT, function () {
    if (pending) render();
  });

  window.addEventListener('load', function () {
    navigator.serviceWorker.register('./service-worker.js').then(onRegistered, function (err) {
      console.warn('Service worker not registered: ' + (err && err.message));
    });
  });
}

/**
 * Wire one registration: the update that may already be waiting, the ones that
 * arrive later, and the checks that go looking for them.
 *
 * @param {ServiceWorkerRegistration} reg
 */
function onRegistered(reg) {
  if (!reg) return;
  registration = reg;

  // A version that installed during an earlier visit and is still parked.
  if (reg.waiting && navigator.serviceWorker.controller) {
    offer(reg.waiting);
  }

  reg.addEventListener('updatefound', function () {
    const installing = reg.installing;
    if (!installing) return;

    installing.addEventListener('statechange', function () {
      if (installing.state !== 'installed') return;

      /*
       * No controller means this is the first install on this device, not an
       * update: there is no old version running to replace, and the worker
       * activates by itself.
       */
      if (!navigator.serviceWorker.controller) return;

      offer(reg.waiting || installing);
    });
  });

  window.setInterval(checkForUpdate, CHECK_INTERVAL_MS);

  document.addEventListener('visibilitychange', function () {
    if (document.visibilityState === 'visible') checkForUpdate();
  });

  window.addEventListener('online', checkForUpdate);
}

/**
 * Ask whether a new version has shipped.
 *
 * Throttled rather than deduplicated: `update()` re-fetches service-worker.js
 * every time it is called, and a tab that is switched to twenty times an hour
 * would otherwise make twenty requests for a file that changes once a week.
 */
function checkForUpdate() {
  if (!registration || applying) return;

  const now = Date.now();
  if (now - lastCheckAt < MIN_CHECK_GAP_MS) return;
  lastCheckAt = now;

  registration.update().catch(function () {
    /* Offline, or the server is unreachable. The next check will do. */
  });
}

/**
 * A worker took control of this page.
 *
 * Two ways that happens: this tab asked for it (reload onto the new version),
 * or another tab did (this one is still running the old code, so it gets the
 * same offer — with nothing left to activate, only a reload).
 */
function onControllerChange() {
  if (applying) {
    window.location.reload();
    return;
  }

  if (!hadController) {
    hadController = true;   // the first install claiming the page
    return;
  }

  offer(null);
}

/* ================================================================== *
 * The prompt
 * ================================================================== */

/**
 * Offer the update.
 * @param {ServiceWorker|null} worker the waiting worker, or null when the new
 *        version is already active and only a reload is missing.
 */
function offer(worker) {
  if (applying) return;

  waitingWorker = worker || null;
  pending = true;
  render();
}

/**
 * Take the update: hand over to the new worker, then reload onto it.
 *
 * The reload happens in onControllerChange() rather than here, so the page only
 * comes back once the new version is actually in charge — reloading first would
 * just re-serve the old cache.
 */
function applyUpdate() {
  if (applying) return;
  applying = true;
  render();

  if (!waitingWorker) {
    window.location.reload();
    return;
  }

  waitingWorker.postMessage({ type: 'skip_waiting' });

  window.setTimeout(function () {
    if (applying) window.location.reload();
  }, TAKEOVER_TIMEOUT_MS);
}

/**
 * @return {HTMLElement} the prompt's container, created on first use.
 */
function host() {
  let el = document.getElementById(HOST_ID);
  if (el) return el;

  el = document.createElement('div');
  el.id = HOST_ID;
  el.className = 'update-host';
  el.setAttribute('role', 'status');
  el.setAttribute('aria-live', 'polite');

  el.addEventListener('click', function (event) {
    const trigger = event.target.closest('[data-action]');
    if (!trigger) return;

    const action = trigger.dataset.action;
    if (action === 'apply') return applyUpdate();
    if (action === 'later') { collapsed = true; return render(); }
    if (action === 'expand') { collapsed = false; return render(); }
  });

  document.body.appendChild(el);
  return el;
}

/** Draw whichever of the three states the prompt is in. */
function render() {
  if (!pending) return;

  const el = host();

  if (collapsed && !applying) {
    el.innerHTML = `
      <button class="update-chip" type="button" data-action="expand">
        <span aria-hidden="true">↻</span>${escapeHtml(t('update_chip'))}
      </button>
    `;
    return;
  }

  el.innerHTML = `
    <div class="update-banner">
      <div class="update-body">
        <div class="update-title">${escapeHtml(t('update_title'))}</div>
        <div class="update-text">${escapeHtml(t('update_text'))}</div>
      </div>

      <div class="update-actions">
        <button class="btn btn-primary btn-sm" type="button" data-action="apply"
                ${applying ? 'disabled' : ''}>
          ${escapeHtml(applying ? t('update_applying') : t('update_reload'))}
        </button>
        ${applying ? '' : `
          <button class="btn btn-ghost btn-sm" type="button" data-action="later">
            ${escapeHtml(t('update_later'))}
          </button>
        `}
      </div>
    </div>
  `;
}
