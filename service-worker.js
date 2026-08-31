/**
 * service-worker.js — the app shell cache (CLAUDE.md 9.2).
 *
 * The app is a static site on GitHub Pages with Google Sheets behind it. This
 * worker makes the SHELL load instantly and open offline; it has nothing to do
 * with the data, and it must never pretend otherwise.
 *
 * ── The one rule that matters ──────────────────────────────────────────────
 *
 * **No response from the Apps Script Web App is ever cached, and no non-GET
 * request is ever touched.** api.js POSTs every action to the Web App (3.1),
 * and the Sheets are the single source of truth — a cached settlement, a cached
 * approval or a cached export query would show a manager money that has already
 * moved. Three independent guards in onFetch() enforce it:
 *
 *   1. `request.method !== 'GET'` → not handled. Every api.call() is a POST, so
 *      this alone already excludes the entire API surface.
 *   2. cross-origin → not handled. The Web App lives on script.google.com and
 *      answers through script.googleusercontent.com; both are other origins, as
 *      is the SheetJS CDN.
 *   3. outside this app's own path → not handled. github.io serves every repo's
 *      pages from ONE origin, so same-origin is not the same as ours.
 *
 * "Not handled" means respondWith() is never called and the browser does its
 * own normal, uncached fetch. That is deliberately different from "handled and
 * then passed through": there is no code path here that can accidentally put an
 * API response in a cache, because API requests never reach the caching code.
 *
 * ── Caching strategy ───────────────────────────────────────────────────────
 *
 * Stale-while-revalidate for the shell, the CSS and the JS: serve the cached
 * copy immediately, fetch a fresh one in the background, and keep it for next
 * time. The screen paints from disk; the update lands on the following visit.
 *
 * ── Deploying ──────────────────────────────────────────────────────────────
 *
 * Editing a file and pushing to main is the whole deploy (CLAUDE.md,
 * Deployment). **Bump APP_VERSION in the same push.** That one line is what
 * tells every open app a new version exists — see the constant below.
 *
 * ── Telling an open app about an update ────────────────────────────────────
 *
 * A browser checks THIS FILE for changes, byte for byte. Nothing else: a new
 * dashboard.js with an unchanged worker is invisible to it. That is the whole
 * reason APP_VERSION has to move on every deploy.
 *
 * When it does move, the browser installs the new worker and parks it in
 * `waiting`, because this file deliberately does NOT call skipWaiting() on
 * install. The page notices the waiting worker and offers a Reload button
 * (js/updates.js); only when somebody presses it does the page post
 * `skip_waiting` here, and only then does the new version take over.
 *
 * This used to skipWaiting() immediately. It was wrong: the swap replaced the
 * CACHE under a page whose JS was already loaded and running, so the app went
 * on running old code with no way to know, and the only cure was a hard
 * refresh. Waiting for a click also means a coordinator halfway through a grid
 * decides when the reload happens, instead of it landing on him mid-entry.
 */

/**
 * The deployed version. **Bump this on every push to main.**
 *
 * Two jobs in one line: it names this version's cache (so activating drops
 * every older one), and it is the signal that makes an open app show its
 * "new version available" prompt. Any string that changes will do; a date plus
 * a counter reads best in DevTools.
 */
const APP_VERSION = '2026.08.31-5';

/** This version's cache. Anything not named this is deleted on activate. */
const CACHE_NAME = 'settlement-checker-' + APP_VERSION;

/**
 * The app's own path on the host.
 *
 * A GitHub *project* page is served from a subdirectory
 * (`/Settlement-Checker/`), not the domain root, and every other repo of the
 * same account shares the origin. Derived from this file's own URL rather than
 * written down, so it is right for a project page, a user page and localhost
 * without anyone having to remember to change it.
 */
const SCOPE_PATH = new URL('./', self.location).pathname;

/**
 * The shell, precached on install so the first offline open works.
 *
 * Everything is relative to this file, which sits at the app root — the same
 * reason index.html's own paths are relative (rule 20's cousin: the app must
 * work from a subdirectory).
 *
 * The list is maintained by hand, like everything else in this project. A URL
 * that 404s does NOT fail the install (see precache()), so a forgotten entry
 * costs one uncached first load rather than a broken worker.
 */
const PRECACHE = [
  './',
  './index.html',
  './manifest.json',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/maskable-512.png',
  './icons/apple-touch-icon.png',

  // The sidebar logo and the watermark behind the app. Part of the shell:
  // without them the rail opens with a hole in it and the page opens bare on the
  // first offline load.
  './assets/lmp-logo-white.png',
  './assets/app-background.jpg',

  './css/tokens.css',
  './css/base.css',
  './css/components.css',
  './css/grid.css',
  './css/template.css',
  './css/print.css',

  './js/main.js',
  './js/router.js',
  './js/api.js',
  './js/state.js',
  './js/updates.js',

  './js/i18n/i18n.js',
  './js/i18n/en.js',
  './js/i18n/ar.js',

  './js/utils/hash.js',
  './js/utils/dates.js',
  './js/utils/dom.js',
  './js/utils/money.js',
  './js/utils/validate.js',
  './js/utils/explode.js',
  './js/utils/xlsx.js',

  './js/components/sidebar.js',
  './js/components/brandMark.js',
  './js/components/modal.js',
  './js/components/toast.js',
  './js/components/badge.js',
  './js/components/table.js',

  './js/auth/login.js',
  './js/auth/session.js',
  './js/auth/changePassword.js',

  './js/coordinator/dashboard.js',
  './js/coordinator/settlement.js',
  './js/coordinator/grid.js',
  './js/coordinator/gridPaste.js',
  './js/coordinator/gridAutofill.js',
  './js/coordinator/confirm.js',

  './js/manager/dashboard.js',
  './js/manager/approvals.js',
  './js/manager/export.js',
  './js/manager/exportTemplate.js',

  './js/admin/teams.js',
  './js/admin/siteJc.js',
  './js/admin/users.js',
  './js/admin/lists.js'
];

/* ================================================================== *
 * Install — fill the cache
 * ================================================================== */

self.addEventListener('install', function (event) {
  event.waitUntil(precache());
});

/**
 * Fetch the shell into this version's cache, one URL at a time.
 *
 * Deliberately not `cache.addAll()`: that rejects the whole batch if a single
 * URL 404s, which would leave the worker uninstalled and the app with no cache
 * at all. In a hand-maintained list, one stale entry is a near-certainty
 * eventually, and it should cost one uncached load rather than the feature.
 *
 * @return {Promise<void>}
 */
async function precache() {
  const cache = await caches.open(CACHE_NAME);

  const results = await Promise.all(PRECACHE.map(function (url) {
    return cache.add(new Request(url, { cache: 'reload' })).then(
      function () { return null; },
      function () { return url; }
    );
  }));

  const missing = results.filter(Boolean);
  if (missing.length) {
    // Not fatal, but it means PRECACHE and the repo have drifted apart.
    console.warn('[sw] not precached (check the PRECACHE list): ' + missing.join(', '));
  }
}

/* ================================================================== *
 * Activate — drop every older version
 * ================================================================== */

self.addEventListener('activate', function (event) {
  event.waitUntil((async function () {
    const names = await caches.keys();

    await Promise.all(names.map(function (name) {
      // Only this app's caches, and only the ones that are not the current
      // version. Another app on the same origin owns its own names.
      const ours = name.indexOf('settlement-checker-') === 0;
      return (ours && name !== CACHE_NAME) ? caches.delete(name) : null;
    }));

    await self.clients.claim();
  })());
});

/* ================================================================== *
 * Message — the page's half of the update handshake
 * ================================================================== */

/**
 * `skip_waiting` is the page asking this worker to take over now.
 *
 * It is the ONLY way a new version activates while a tab is open, and it
 * happens because somebody pressed Reload in the update prompt
 * (js/updates.js). The page then reloads itself off the back of
 * `controllerchange`, so the swap and the reload are one action rather than a
 * cache changing under running code.
 *
 * A first install never comes through here: with no worker controlling the page
 * there is nothing to wait behind, so it activates on its own.
 */
self.addEventListener('message', function (event) {
  const data = event.data || {};

  if (data.type === 'skip_waiting') {
    self.skipWaiting();
    return;
  }

  // Lets the page ask what it is actually running, for support questions.
  if (data.type === 'get_version' && event.ports && event.ports[0]) {
    event.ports[0].postMessage({ version: APP_VERSION });
  }
});

/* ================================================================== *
 * Fetch — the three guards, then stale-while-revalidate
 * ================================================================== */

self.addEventListener('fetch', function (event) {
  const request = event.request;

  /*
   * Guard 1 — GET only.
   *
   * Every api.call() is a POST to the Apps Script Web App (3.1), so this one
   * line already puts the entire API beyond the reach of this file. Returning
   * without calling respondWith() hands the request back to the browser
   * untouched.
   */
  if (request.method !== 'GET') return;

  let url;
  try {
    url = new URL(request.url);
  } catch (err) {
    return;
  }

  /*
   * Guard 2 — our origin only.
   *
   * The Web App (script.google.com, answering via script.googleusercontent.com)
   * and the SheetJS CDN are both cross-origin. Neither is cached: the first
   * must never be, and the second is only needed by the Excel import and the
   * finance export, which are online operations anyway. Leaving it out keeps
   * opaque cross-origin responses — which cannot be inspected or validated —
   * out of the cache entirely.
   */
  if (url.origin !== self.location.origin) return;

  /*
   * Guard 3 — our own path only. github.io serves every repository of an
   * account from one origin, so same-origin is not the same as ours.
   */
  if (url.pathname.indexOf(SCOPE_PATH) !== 0) return;

  // Never cache the worker itself; the browser has its own update mechanism for
  // it, and a cached copy could pin an old version in place.
  if (url.pathname.indexOf('service-worker.js') !== -1) return;

  /*
   * A navigation. The router is hash-based (rule 20), so every URL the user can
   * reach is index.html — which is what makes an offline open possible at all.
   */
  if (request.mode === 'navigate') {
    event.respondWith(handleNavigation(event));
    return;
  }

  event.respondWith(staleWhileRevalidate(event));
});

/**
 * Serve the shell for a navigation.
 *
 * Cache first, because the point is that the app opens instantly and opens at
 * all when there is no signal — a coordinator's grid draft lives in
 * localStorage (6.5) and is readable offline. The network copy is fetched
 * behind it and kept for next time.
 *
 * @param {FetchEvent} event
 * @return {Promise<Response>}
 */
async function handleNavigation(event) {
  const cache = await caches.open(CACHE_NAME);
  const cached = await cache.match('./index.html');

  const fromNetwork = revalidate(event, cache, new Request('./index.html'));

  if (cached) return cached;

  const fresh = await fromNetwork;
  return fresh || offlineResponse();
}

/**
 * Stale-while-revalidate for one asset.
 *
 * The cached copy goes back immediately and the refresh runs in the background
 * under waitUntil(), so the worker is not killed mid-update after the response
 * has already been handed over.
 *
 * @param {FetchEvent} event
 * @return {Promise<Response>}
 */
async function staleWhileRevalidate(event) {
  const cache = await caches.open(CACHE_NAME);
  const cached = await cache.match(event.request);

  const fromNetwork = revalidate(event, cache, event.request);

  if (cached) return cached;

  const fresh = await fromNetwork;
  return fresh || offlineResponse();
}

/**
 * Fetch and store, without ever letting a failure surface as a rejection.
 *
 * @param {FetchEvent} event
 * @param {Cache} cache
 * @param {Request} request
 * @return {Promise<Response|null>} null when the network could not answer.
 */
function revalidate(event, cache, request) {
  const task = fetch(request).then(function (response) {
    if (isCacheable(response)) {
      // Clone before returning: a Response body can only be read once.
      cache.put(request, response.clone());
    }
    return response;
  }).catch(function () {
    return null;   // offline, or the file is gone — the cached copy stands
  });

  event.waitUntil(task);
  return task;
}

/**
 * Is this response safe to keep?
 *
 * `type === 'basic'` means same-origin and fully readable. An opaque response
 * (a cross-origin request with no CORS) has status 0 and an unreadable body, so
 * a broken one is indistinguishable from a good one — never cached. Guard 2
 * already keeps those out; this is the second lock on the same door.
 *
 * @param {Response} response
 * @return {boolean}
 */
function isCacheable(response) {
  return !!response && response.ok && response.type === 'basic';
}

/**
 * The answer when there is neither a cached copy nor a network.
 *
 * A real Response rather than a thrown error, so the page sees a clean failure
 * it can report instead of a generic network exception.
 *
 * @return {Response}
 */
function offlineResponse() {
  return new Response('', {
    status: 503,
    statusText: 'Offline',
    headers: { 'Content-Type': 'text/plain; charset=utf-8' }
  });
}
