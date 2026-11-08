/* Hazmat Portal offline support.
   Network first, so crews get the newest version when they have signal. If the network
   is slow (no answer in 3 seconds) or down, the last saved copy is shown instead.
   The portal shell and the form menus are saved on install. Every PDF in files/ is
   then saved in the background (one at a time, so the first visit stays fast), so all
   forms open offline even if nobody opened them before.
   Bump CACHE when the shell list changes; bump FILES_CACHE only to force a re-download
   of every PDF. Keep FILES in sync with the files/ folder. */
var CACHE = 'hazmat-portal-v2';
var FILES_CACHE = 'hazmat-files-v1';
var NETWORK_TIMEOUT_MS = 3000;
var PRECACHE = [
  './',
  './index.html',
  './manifest.json',
  './logo.png',
  './icon-192.png',
  './icon-512.png',
  './apple-touch-icon.png',
  './files/ics-forms/',
  './files/ics-forms/index.html',
  './files/worksheets/',
  './files/worksheets/index.html'
];
var FILES = [
  './files/chemical-exposure-report.pdf',
  './files/cleanup-contractor-list.pdf',
  './files/epcra-tier2.pdf',
  './files/hazmat-medical-protocol.pdf',
  './files/hazmat-sop.pdf',
  './files/serc-field-operations-guide.pdf',
  './files/team-contact-list.pdf',
  './files/ics-forms/ics201.pdf',
  './files/ics-forms/ics204.pdf',
  './files/ics-forms/ics206.pdf',
  './files/ics-forms/ics208.pdf',
  './files/ics-forms/ics208hm.pdf',
  './files/ics-forms/ics214.pdf',
  './files/ics-forms/ics215.pdf',
  './files/ics-forms/ics215a.pdf',
  './files/worksheets/DeconGroupWorksheet.pdf',
  './files/worksheets/EntryTeamWorksheet.pdf',
  './files/worksheets/HM208.pdf',
  './files/worksheets/HazMatGroupLeaderWorksheet.pdf',
  './files/worksheets/PCHMRTEntry-MedicalWorksheet.pdf',
  './files/worksheets/PCHMRTRehab-MedicalWorksheet.pdf',
  './files/worksheets/PCHMRTRehabCheckinCheckoutWorksheet.pdf',
  './files/worksheets/SafetyOfficerWorksheet.pdf'
];

function abs(path) { return new URL(path, self.registration.scope).href; }
function isFile(url) { return url.split('?')[0].toLowerCase().endsWith('.pdf'); }

// Save every PDF that isn't saved yet, one at a time. Safe to call repeatedly.
var filling = null;
function fillFiles() {
  if (filling) return filling;
  filling = caches.open(FILES_CACHE).then(function (cache) {
    return FILES.reduce(function (chain, path) {
      return chain.then(function () {
        var url = abs(path);
        return cache.match(url).then(function (hit) {
          if (hit) return;
          return fetch(url, { cache: 'no-cache' }).then(function (res) {
            if (res && res.status === 200) return cache.put(url, res);
          }).catch(function () { /* offline or missing: try again next time */ });
        });
      });
    }, Promise.resolve());
  }).then(function () { filling = null; }, function () { filling = null; });
  return filling;
}

function savedCount() {
  return caches.open(FILES_CACHE).then(function (cache) {
    return Promise.all(FILES.map(function (p) { return cache.match(abs(p)); }));
  }).then(function (hits) { return hits.filter(Boolean).length; });
}

self.addEventListener('install', function (event) {
  event.waitUntil(
    caches.open(CACHE).then(function (cache) { return cache.addAll(PRECACHE); })
      .then(function () { return self.skipWaiting(); })
  );
});

self.addEventListener('activate', function (event) {
  event.waitUntil(
    caches.keys().then(function (keys) {
      return Promise.all(keys.filter(function (k) { return k !== CACHE && k !== FILES_CACHE; })
        .map(function (k) { return caches.delete(k); }));
    }).then(function () { return self.clients.claim(); })
  );
  fillFiles(); // background: not part of waitUntil, so activation isn't held up
});

// The page asks how many forms are saved; asking also resumes any unfinished download.
self.addEventListener('message', function (event) {
  var data = event.data || {};
  if (data.type !== 'files-status' || !event.ports || !event.ports[0]) return;
  var port = event.ports[0];
  fillFiles();
  event.waitUntil(savedCount().then(function (n) {
    port.postMessage({ cached: n, total: FILES.length });
  }));
});

self.addEventListener('fetch', function (event) {
  var req = event.request;
  // Only handle this site's own files. Firebase, fonts and outside links go straight to the network.
  if (req.method !== 'GET' || new URL(req.url).origin !== self.location.origin) return;

  // PDF viewers ask for byte ranges (HTTP 206). Answer with the full saved file when we have it;
  // otherwise let the request go to the network untouched (partial responses are never saved).
  if (req.headers.has('range')) {
    event.respondWith(
      caches.match(req.url, { ignoreSearch: true }).then(function (hit) { return hit || fetch(req); })
    );
    return;
  }

  var network = fetch(req).then(function (res) {
    if (res && res.status === 200 && res.type === 'basic') {
      var copy = res.clone();
      caches.open(isFile(req.url) ? FILES_CACHE : CACHE).then(function (cache) { cache.put(req, copy); });
    }
    return res;
  });
  event.waitUntil(network.catch(function () {})); // let a slow response still refresh the cache

  event.respondWith(new Promise(function (resolve) {
    var done = false;
    function finish(res) { if (!done) { done = true; resolve(res); } }
    function fallback() {
      return caches.match(req, { ignoreSearch: true }).then(function (hit) {
        if (hit) return hit;
        if (req.mode === 'navigate') return caches.match('./index.html');
        return null;
      });
    }
    // Weak signal: after 3 s show the saved copy of THIS page/file if there is one, and keep
    // waiting for the network otherwise (no home-page substitute while the network may still answer).
    var timer = setTimeout(function () {
      caches.match(req, { ignoreSearch: true }).then(function (hit) { if (hit) finish(hit); });
    }, NETWORK_TIMEOUT_MS);
    network.then(function (res) { clearTimeout(timer); finish(res); })
      .catch(function () {
        clearTimeout(timer);
        fallback().then(function (hit) { finish(hit || Response.error()); });
      });
  }));
});
